import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { copyFiles, getFileMatchers } from "app-builder-lib/out/fileMatcher.js";
import { INVENTORY_NAME, runtimeFiles, verifyRuntimeFiles } from "../../../scripts/lib/runtime-inventory.mjs";
import { prepareDesktopRelease, releaseEnvironment } from "../../../scripts/lib/desktop-release.mjs";
import { runtimeNodeName } from "../src/runtime-paths.mjs";
import verifyDesktopPackage from "../../../scripts/verify-desktop-package.mjs";

async function fixture(t, platform = "win32") {
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
		runtimeNodeName(platform),
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
	if (platform !== "win32") await chmod(join(runtime, runtimeNodeName(platform)), 0o755);
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
	assert.equal(await verifyRuntimeFiles(runtime, "win32"), 8);
	const executable = join(output, "Wuming.exe");
	await writeFile(executable, "fixture");
	const release = await prepareDesktopRelease(executable, root, "win32");
	try {
		assert.notEqual(release.executable, executable);
		assert.equal(await verifyRuntimeFiles(join(release.directory, "resources", "runtime"), "win32"), 8);
	} finally {
		await release.dispose();
	}
	await assert.rejects(realpath(release.directory), { code: "ENOENT" });
	await unlink(join(runtime, "node_modules", "@wuming", "artifacts", "package.json"));
	await assert.rejects(verifyRuntimeFiles(runtime, "win32"), /missing 1 file.*[\s\S]*@wuming\/artifacts/);
	await assert.rejects(prepareDesktopRelease(executable, root, "win32"), /missing 1 file/);
});

test("runtime inventory rejects path traversal instead of checking files outside the package", async (t) => {
	const { runtime } = await fixture(t);
	await writeFile(join(runtime, INVENTORY_NAME), JSON.stringify({ files: ["../outside.txt"] }));
	await assert.rejects(verifyRuntimeFiles(runtime), /Invalid runtime inventory path/);
});

test("release checks remove developer Node paths and injected Node options case-insensitively", () => {
	const env = releaseEnvironment(
		{
			Path: "developer",
			NODE_PATH: "checkout",
			node_options: "--import inject",
			ELECTRON_RUN_AS_NODE: "1",
			SystemRoot: "C:\\Windows",
		},
		"win32"
	);
	assert.deepEqual(env, { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32;C:\\Windows" });
});

test("macOS verifies Contents/Resources and relocates the complete app bundle", async (t) => {
	const { root, runtime } = await fixture(t, "darwin");
	const output = join(root, "mac-arm64");
	const app = join(output, "Pi-Wm.app");
	const packagedRuntime = join(app, "Contents", "Resources", "runtime");
	await cp(runtime, packagedRuntime, { recursive: true });
	const executable = join(app, "Contents", "MacOS", "Pi-Wm");
	await mkdir(dirname(executable), { recursive: true });
	await writeFile(executable, "fixture");
	await verifyDesktopPackage({
		appOutDir: output,
		electronPlatformName: "darwin",
		packager: { appInfo: { productFilename: "Pi-Wm" } },
	});
	const release = await prepareDesktopRelease(executable, root, "darwin");
	try {
		assert.ok(release.directory.endsWith(".app"));
		assert.equal(release.executable, join(release.directory, "Contents", "MacOS", "Pi-Wm"));
		assert.equal(await verifyRuntimeFiles(release.runtime, "darwin"), 8);
		await assert.rejects(verifyRuntimeFiles(release.runtime, "win32"), { code: "ENOENT" });
	} finally {
		await release.dispose();
	}
	await unlink(join(packagedRuntime, "node"));
	await assert.rejects(prepareDesktopRelease(executable, root, "darwin"), /missing 1 file/);
});

test("Mac release verification excludes Homebrew and developer Node from PATH", () => {
	assert.deepEqual(
		releaseEnvironment({ PATH: "/opt/homebrew/bin", NODE_OPTIONS: "--import inject", HOME: "/Users/test" }, "darwin"),
		{
			HOME: "/Users/test",
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		}
	);
});
