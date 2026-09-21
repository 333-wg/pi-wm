import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pruneDesktopRuntime, runtimePruneReason } from "../../../scripts/lib/prune-desktop-runtime.mjs";

test("SDK sources and browser-only PDF bundles are removed without touching runtime or licenses", () => {
	for (const prefix of ["node_modules/", "node_modules/parent/node_modules/"]) {
		for (const name of ["openai", "zod", "@anthropic-ai/sdk"]) {
			assert.equal(runtimePruneReason(`${prefix}${name}/src/index.ts`), "sdkSources");
			assert.equal(runtimePruneReason(`${prefix}${name}/index.js`), undefined);
			assert.equal(runtimePruneReason(`${prefix}${name}/src/LICENSE`), undefined);
		}
		assert.equal(runtimePruneReason(`${prefix}pdf-parse/dist/pdf-parse/web/pdf.worker.mjs`), "browserOnlyPdfBuild");
		for (const file of [
			"pdf-parse/dist/pdf-parse/esm/PDFParse.js",
			"pdf-parse/dist/worker/esm/index.js",
			"pdfjs-dist/legacy/build/pdf.worker.mjs",
			"pdfjs-dist/wasm/openjpeg.wasm",
			"other/src/index.ts",
			"@earendil-works/pi-coding-agent/examples/sdk.ts",
		])
			assert.equal(runtimePruneReason(`${prefix}${file}`), undefined);
	}
});

test("Windows and both Mac architectures retain exactly the bundled Node profiler target", () => {
	const targets = ["win32-x64", "darwin-arm64", "darwin-x64"];
	for (const target of targets) {
		const [platform, arch] = target.split("-");
		for (const candidate of [...targets, "linux-x64-glibc"]) {
			for (const abi of ["108", "127", "137"]) {
				assert.equal(
					runtimePruneReason(
						`node_modules/@sentry/node-cpu-profiler/lib/sentry_cpu_profiler-${candidate}-${abi}.node`,
						platform,
						arch,
						"127"
					),
					candidate === target && abi === "127" ? undefined : "otherProfilerTargets"
				);
			}
		}
	}
});

test("browser resource pruning preserves supported locales, fonts, ICU, licenses and unrelated files", () => {
	for (const platform of ["win32", "darwin"]) {
		const prefix = "browsers/chromium_headless_shell-1234/chrome-headless-shell/locales/";
		assert.equal(runtimePruneReason(`${prefix}fr.pak`, platform), "browserLocales");
		for (const locale of ["en-US", "zh-CN", "zh-TW"])
			assert.equal(runtimePruneReason(`${prefix}${locale}.pak`, platform), undefined);
		for (const path of [
			"browsers/chromium_headless_shell-1234/fonts/font.ttf",
			"browsers/chromium_headless_shell-1234/icudtl.dat",
			`${prefix}LICENSE`,
			"workspace/locales/fr.pak",
			"node_modules/other/locales/fr.pak",
		])
			assert.equal(runtimePruneReason(path, platform), undefined);
	}
});

test("each Mac architecture retains its own PTY binary and spawn helper", () => {
	for (const arch of ["arm64", "x64"]) {
		for (const file of ["pty.node", "spawn-helper"]) {
			assert.equal(
				runtimePruneReason(`node_modules/node-pty/prebuilds/darwin-${arch}/${file}`, "darwin", arch),
				undefined
			);
			assert.equal(
				runtimePruneReason(
					`node_modules/node-pty/prebuilds/darwin-${arch}/${file}`,
					"darwin",
					arch === "x64" ? "arm64" : "x64"
				),
				"otherPlatforms"
			);
		}
		assert.equal(
			runtimePruneReason("node_modules/node-pty/prebuilds/win32-x64/pty.node", "darwin", arch),
			"otherPlatforms"
		);
		assert.equal(
			runtimePruneReason("node_modules/node-pty/third_party/conpty/1/win10-x64/conpty.dll", "darwin", arch),
			"otherPlatforms"
		);
	}
});

test("pruning removes development-only assets and non-target PTY platforms", async () => {
	const parent = await realpath(tmpdir());
	const root = await mkdtemp(join(parent, "wuming-prune-test-"));
	const remove = [
		"node_modules/lib/index.js.map",
		"apps/gateway/dist/main.d.ts.map",
		"node_modules/lib/index.d.ts",
		"node_modules/lib/index.d.cts",
		"node_modules/lib/index.d.mts",
		"node_modules/node-pty/prebuilds/win32-x64/pty.pdb",
		"node_modules/node-pty/prebuilds/win32-arm64/pty.node",
		"node_modules/node-pty/third_party/conpty/1/win10-arm64/conpty.dll",
		"node_modules/openai/src/client.ts",
		"node_modules/zod/src/v4/core.ts",
		"node_modules/parent/node_modules/@anthropic-ai/sdk/src/client.ts",
		"node_modules/pdf-parse/dist/pdf-parse/web/pdf.worker.mjs",
		"node_modules/@sentry/node-cpu-profiler/lib/sentry_cpu_profiler-linux-x64-glibc-127.node",
		"browsers/chromium_headless_shell-1234/chrome-headless-shell/locales/fr.pak",
	];
	const keep = [
		"node_modules/lib/index.js",
		"node_modules/lib/index.cts",
		"node_modules/lib/geography.map",
		"node_modules/lib/LICENSE",
		"node_modules/node-pty/prebuilds/win32-x64/pty.node",
		"node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
		"node_modules/pdfjs-dist/build/pdf.worker.mjs",
		"node_modules/openai/src/LICENSE",
		"node_modules/zod/v4/core.js",
		"node_modules/pdf-parse/dist/pdf-parse/esm/PDFParse.js",
		"browsers/chromium_headless_shell-1234/chrome-headless-shell/locales/zh-CN.pak",
		"browsers/chromium/index.js.map",
	];
	try {
		for (const file of [...remove, ...keep]) {
			await mkdir(dirname(join(root, file)), { recursive: true });
			await writeFile(join(root, file), "fixture");
		}
		const result = await pruneDesktopRuntime(root, "win32", "x64");
		assert.equal(result.removedFiles, remove.length);
		assert.equal(result.removedBytes, remove.length * 7);
		for (const file of remove) await assert.rejects(access(join(root, file)), { code: "ENOENT" });
		for (const file of keep) await access(join(root, file));
		assert.equal(runtimePruneReason("workspace/user.pdb"), undefined);
		assert.equal(runtimePruneReason("workspace/user.d.ts"), undefined);
	} finally {
		assert.equal(dirname(root), parent);
		assert.ok(basename(root).startsWith("wuming-prune-test-"));
		assert.equal(await realpath(root), root);
		await rm(root, { recursive: true, force: true });
	}
});
