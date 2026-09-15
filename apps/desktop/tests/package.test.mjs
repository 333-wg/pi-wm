import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { copyFiles, getFileMatchers } from "app-builder-lib/out/fileMatcher.js";
import { INVENTORY_NAME, runtimeFiles, verifyRuntimeFiles } from "../../../scripts/lib/runtime-inventory.mjs";
import { prepareDesktopRelease, releaseEnvironment } from "../../../scripts/lib/desktop-release.mjs";

async function fixture(t) {
	const parent = await realpath(tmpdir());
	const root = await mkdtemp(join(parent, "wuming-package-test-"));
	t.after(async () => {
		assert.equal(dirname(root), parent);
		assert.ok(basename(root).startsWith("wuming-package-test-"));
		assert.equal(await realpath(root), root);
		await rm(root, { recursive: true, force: true });
	});
	const runtime = join(root, ".desktop-stage", "runtime");
	for (const file of [
		"node.exe",
		"apps/gateway/dist/main.js",
		"apps/web/dist/index.html",
		"node_modules/@wuming/artifacts/package.json",
		"node_modules/node-pty/package.json",
		"node_modules/outer/node_modules/inner/index.js",
		"node_modules/outer/.data",
		"node_modules/outer/.gitkeep",
		"node_modules/native/build/addon.node",
	]) {
		await mkdir(dirname(join(runtime, file)), { recursive: true });
		await writeFile(join(runtime, file), "fixture");
	}
	await writeFile(join(runtime, INVENTORY_NAME), JSON.stringify({ files: await runtimeFiles(runtime) }));
	return { root, runtime };
}

test("actual builder rules retain workspace, nested, hidden, and native dependency files", async (t) => {
	const { root } = await fixture(t);
	const config = JSON.parse(await readFile(new URL("../electron-builder.json", import.meta.url), "utf8"));
	const output = join(root, "output");
	const matchers = getFileMatchers(config, "extraResources", join(output, "resources"), {
		defaultSrc: root,
		macroExpander: (value) => value,
		customBuildOptions: {},
		globalOutDir: output,
	});
	await copyFiles(matchers);
	const runtime = join(output, "resources", "runtime");
	assert.equal(await verifyRuntimeFiles(runtime), 8);
	const executable = join(output, "Wuming.exe");
	await writeFile(executable, "fixture");
	const release = await prepareDesktopRelease(executable, root);
	try {
		assert.notEqual(release.executable, executable);
		assert.equal(await verifyRuntimeFiles(join(release.directory, "resources", "runtime")), 8);
	} finally {
		await release.dispose();
	}
	await assert.rejects(realpath(release.directory), { code: "ENOENT" });
	await unlink(join(runtime, "node_modules", "@wuming", "artifacts", "package.json"));
	await assert.rejects(verifyRuntimeFiles(runtime), /missing 1 file.*[\s\S]*@wuming\/artifacts/);
	await assert.rejects(prepareDesktopRelease(executable, root), /missing 1 file/);
});

test("runtime inventory rejects path traversal instead of checking files outside the package", async (t) => {
	const { runtime } = await fixture(t);
	await writeFile(join(runtime, INVENTORY_NAME), JSON.stringify({ files: ["../outside.txt"] }));
	await assert.rejects(verifyRuntimeFiles(runtime), /Invalid runtime inventory path/);
});

test("release checks remove developer Node paths and injected Node options case-insensitively", () => {
	const env = releaseEnvironment({
		Path: "developer",
		NODE_PATH: "checkout",
		node_options: "--import inject",
		ELECTRON_RUN_AS_NODE: "1",
		SystemRoot: "C:\\Windows",
	});
	assert.deepEqual(env, { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\Windows" });
});
