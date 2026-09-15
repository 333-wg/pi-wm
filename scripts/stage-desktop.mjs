import { spawn } from "node:child_process";
import { cp, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY_NAME, runtimeFiles } from "./lib/runtime-inventory.mjs";
import { pruneDesktopRuntime } from "./lib/prune-desktop-runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const staging = resolve(root, ".desktop-stage");
const runtime = join(staging, "runtime");
if (process.platform !== "win32" || process.arch !== "x64")
	throw new Error("Build the Windows x64 package on Windows x64");
if (Number(process.versions.node.split(".")[0]) !== 22)
	throw new Error("Build with Node 22.19+ to preserve the tested native ABI");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run npm run desktop:stage");
const insideRoot = relative(await realpath(root), staging);
if (insideRoot !== ".desktop-stage") throw new Error("Unsafe staging directory");
try {
	if ((await realpath(staging)) !== staging) throw new Error("Staging directory must not redirect through a link");
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
// This generated directory is never used for user data.
await rm(staging, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });

function run(args, env = process.env) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(process.execPath, args, { cwd: runtime, env, windowsHide: true, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolveRun() : reject(new Error(`Runtime preparation failed (${code})`))
		);
	});
}

for (const name of ["package.json", "package-lock.json"]) await copyFile(join(root, name), join(runtime, name));
const workspaces = [];
for (const group of ["apps", "packages"]) {
	for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const source = join(root, group, entry.name);
		let manifest;
		try {
			manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		const target = join(runtime, group, entry.name);
		await mkdir(target, { recursive: true });
		await copyFile(join(source, "package.json"), join(target, "package.json"));
		workspaces.push({ name: manifest.name, target });
		if (entry.name === "desktop" && group === "apps") continue;
		await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
		if (group === "apps" && entry.name === "gateway")
			await cp(join(source, "builtin-skills"), join(target, "builtin-skills"), { recursive: true });
	}
}
// Reinstall from the existing lock, not the developer's mutable node_modules.
// Only node-pty needs its install step; do not run project or arbitrary dependency hooks.
await run([
	npmCli,
	"ci",
	"--workspace=@wuming/gateway",
	"--include-workspace-root=false",
	"--omit=dev",
	"--ignore-scripts",
	"--no-audit",
	"--no-fund",
]);
await run([npmCli, "rebuild", "node-pty"]);
// Workspace links must not retain absolute build-machine paths in the package.
for (const workspace of workspaces) {
	const link = join(runtime, "node_modules", ...workspace.name.split("/"));
	try {
		await lstat(link);
	} catch (error) {
		if (error.code === "ENOENT") continue;
		throw error;
	}
	const rel = relative(runtime, link);
	if (!rel.startsWith(`node_modules${sep}`)) throw new Error("Unsafe workspace link");
	if ((await realpath(link)) !== (await realpath(workspace.target)))
		throw new Error("Unexpected workspace link target");
	await rm(link, { recursive: true, force: true });
	await cp(workspace.target, link, { recursive: true, dereference: true });
}
await copyFile(process.execPath, join(runtime, "node.exe"));
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
if (!license.ok) throw new Error("Unable to fetch the bundled Node license");
await writeFile(join(runtime, "NODE-LICENSE.txt"), await license.text());
const browserCache = join(root, "release", "browser-cache");
await run([join(runtime, "node_modules", "playwright", "cli.js"), "install", "--only-shell", "chromium"], {
	...process.env,
	PLAYWRIGHT_BROWSERS_PATH: browserCache,
});
await cp(browserCache, join(runtime, "browsers"), {
	recursive: true,
	filter: (path) => !path.split(sep).includes(".links"),
});
const pruning = await pruneDesktopRuntime(runtime);
console.log(
	`Runtime pruning: ${pruning.removedFiles} files, ${(pruning.removedBytes / 1024 / 1024).toFixed(1)} MiB removed`
);
await run([
	"--input-type=module",
	"-e",
	"import { DatabaseSync } from 'node:sqlite'; import pty from 'node-pty'; new DatabaseSync(':memory:').close(); if (!pty.spawn) throw new Error('PTY missing'); console.log('Bundled runtime imports passed');",
]);
await writeFile(
	join(runtime, "runtime-manifest.json"),
	JSON.stringify(
		{
			pruning,
			node: process.versions.node,
			platform: process.platform,
			arch: process.arch,
			nodeSha256: createHash("sha256")
				.update(await readFile(process.execPath))
				.digest("hex"),
			lockSha256: createHash("sha256")
				.update(await readFile(join(root, "package-lock.json")))
				.digest("hex"),
		},
		null,
		2
	)
);
await writeFile(join(runtime, INVENTORY_NAME), JSON.stringify({ files: await runtimeFiles(runtime) }, null, 2));
console.log(`Desktop runtime staged at ${runtime}`);
