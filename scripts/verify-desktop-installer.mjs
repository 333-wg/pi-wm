import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRuntimeFiles } from "./lib/runtime-inventory.mjs";
import { getPath7za } from "app-builder-lib/out/toolsets/7zip.js";
import { verifyBundledRuntime } from "./lib/verify-bundled-runtime.mjs";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Verify the installer on Windows x64");
const root = fileURLToPath(new URL("..", import.meta.url));
const { version, productName } = JSON.parse(await readFile(join(root, "apps", "desktop", "package.json"), "utf8"));
const installer = resolve(process.argv[2] ?? join(root, "release", `${productName}-${version}-Setup-x64.exe`));
const sevenZip = join(root, "node_modules", "electron-winstaller", "vendor", "7z-x64.exe");
const parent = await realpath(tmpdir());
const temporary = await mkdtemp(join(parent, "wuming-installer-"));
const output = join(root, "test-results", "desktop-installer");
const report = { installer, version, installed: false, passed: false };
async function dispose() {
	if (
		dirname(temporary) !== parent ||
		!basename(temporary).startsWith("wuming-installer-") ||
		(await realpath(temporary)) !== temporary
	)
		throw new Error("Unsafe installer verification cleanup path");
	await rm(temporary, { recursive: true, force: true });
}
function run(executable, args) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(executable, args, { cwd: temporary, windowsHide: true, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolveRun() : reject(new Error(`Installer verification command failed (${code})`))
		);
	});
}
try {
	report.sha256 = createHash("sha256")
		.update(await readFile(installer))
		.digest("hex");
	// Extract the actual installer payload without executing NSIS or changing installed apps/registry.
	await run(sevenZip, ["x", installer, `-o${temporary}`, "$PLUGINSDIR/app-64.7z", "-y"]);
	const payload = join(temporary, "payload");
	await run(await getPath7za(), ["x", join(temporary, "$PLUGINSDIR", "app-64.7z"), `-o${payload}`, "-y"]);
	report.runtimeFiles = await verifyRuntimeFiles(join(payload, "resources", "runtime"));
	await verifyBundledRuntime(join(payload, "resources", "runtime"));
	report.nativeRuntimePassed = true;
	await run(process.execPath, [
		join(root, "scripts", "verify-desktop-workflows.mjs"),
		`--packaged=${join(payload, `${productName}.exe`)}`,
	]);
	await run(process.execPath, [
		join(root, "scripts", "verify-desktop-browser.mjs"),
		`--packaged=${join(payload, `${productName}.exe`)}`,
	]);
	report.browserPassed = true;
	report.passed = true;
	console.log(
		"Installer payload passed isolated desktop workflows and browser checks; NSIS installation was not executed."
	);
} catch (error) {
	report.error = error.message;
	throw error;
} finally {
	await mkdir(output, { recursive: true });
	await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
	await dispose();
}
