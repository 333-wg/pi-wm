import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { desktopTarget } from "./lib/desktop-target.mjs";
import { prepareDesktopRelease } from "./lib/desktop-release.mjs";
import { verifyBundledRuntime } from "./lib/verify-bundled-runtime.mjs";

assert.equal(process.platform, "darwin", "Verify macOS packages on a native Mac runner");
const target = desktopTarget();
const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
assert.match(version, /^\d+\.\d+\.\d+$/);
const prefix = `Pi-Wm-${version}-mac-${target.arch}`;
const run = promisify(execFile);
const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryRoot, "pi-wm-macos-"));
let relocated;
try {
	const checksums = [];
	for (const ext of ["dmg", "zip"]) {
		const filename = `${prefix}.${ext}`;
		const path = join(root, "release", filename);
		assert.ok((await stat(path)).size > 0, `${filename} must not be empty`);
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		checksums.push(`${hash.digest("hex")}  ${filename}`);
	}
	await run("/usr/bin/hdiutil", ["verify", join(root, "release", `${prefix}.dmg`)], { timeout: 120_000 });
	await run("/usr/bin/ditto", ["-x", "-k", join(root, "release", `${prefix}.zip`), temporary], { timeout: 120_000 });
	const app = join(temporary, "Pi-Wm.app");
	await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 120_000 });
	const runtime = join(app, "Contents", "Resources", "runtime");
	const manifest = JSON.parse(await readFile(join(runtime, "runtime-manifest.json"), "utf8"));
	assert.equal(manifest.platform, "darwin");
	assert.equal(manifest.arch, target.arch);
	const { stdout } = await run(join(runtime, "node"), ["-p", "process.platform + '-' + process.arch"]);
	assert.equal(stdout.trim(), `darwin-${target.arch}`);
	relocated = await prepareDesktopRelease(join(app, "Contents", "MacOS", "Pi-Wm"), root);
	await verifyBundledRuntime(relocated.runtime);
	await run(
		process.execPath,
		[join(root, "scripts/verify-desktop.mjs"), `--packaged=${join(app, "Contents", "MacOS", "Pi-Wm")}`],
		{
			cwd: root,
			timeout: 240_000,
			maxBuffer: 4 * 1024 * 1024,
		}
	);
	await writeFile(join(root, "release", `${prefix}.sha256`), checksums.join("\n") + "\n");
	console.log(
		`macOS ${target.arch} passed: archive signature, native Node, Chromium/PDF/canvas/SQLite, packaged UI and PTY.`
	);
} finally {
	await relocated?.dispose();
	assert.equal(dirname(await realpath(temporary)), temporaryRoot);
	await rm(temporary, { recursive: true, force: true });
}
