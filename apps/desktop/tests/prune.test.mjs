import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pruneDesktopRuntime, runtimePruneReason } from "../../../scripts/lib/prune-desktop-runtime.mjs";

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
	];
	const keep = [
		"node_modules/lib/index.js",
		"node_modules/lib/index.cts",
		"node_modules/lib/geography.map",
		"node_modules/lib/LICENSE",
		"node_modules/node-pty/prebuilds/win32-x64/pty.node",
		"node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
		"node_modules/pdfjs-dist/build/pdf.worker.mjs",
		"browsers/chromium/index.js.map",
	];
	try {
		for (const file of [...remove, ...keep]) {
			await mkdir(dirname(join(root, file)), { recursive: true });
			await writeFile(join(root, file), "fixture");
		}
		const result = await pruneDesktopRuntime(root);
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
