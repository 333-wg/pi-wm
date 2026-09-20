import { access, constants, lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runtimeNodeName } from "../../apps/desktop/src/runtime-paths.mjs";

export const INVENTORY_NAME = "runtime-files.json";

export async function runtimeFiles(root) {
	const files = [];
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			// electron-builder omits empty VCS directory placeholders, which are not runtime assets.
			if (entry.name === ".gitkeep" && entry.isFile()) continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Runtime must not contain links: ${path}`);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
		}
	}
	await visit(root);
	return files.filter((path) => path !== INVENTORY_NAME).sort();
}

export async function verifyRuntimeFiles(root, platform = process.platform) {
	const { files } = JSON.parse(await readFile(join(root, INVENTORY_NAME), "utf8"));
	if (!Array.isArray(files) || files.length === 0) throw new Error("Runtime file inventory is empty");
	const missing = [];
	for (const file of files) {
		if (
			typeof file !== "string" ||
			isAbsolute(file) ||
			file.split(/[\\/]/).some((part) => part === ".." || part === "")
		)
			throw new Error("Invalid runtime inventory path");
		const path = resolve(root, file);
		const rel = relative(root, path);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Runtime inventory escapes its directory");
		try {
			const stat = await lstat(path);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Not a regular file");
		} catch {
			missing.push(file);
		}
	}
	if (missing.length)
		throw new Error(`Packaged runtime is missing ${missing.length} file(s):\n${missing.slice(0, 20).join("\n")}`);
	// These files are mandatory even if a malformed staging inventory omits them.
	for (const file of [
		runtimeNodeName(platform),
		"apps/gateway/dist/main.js",
		"apps/web/dist/index.html",
		"node_modules/@wuming/artifacts/package.json",
		"node_modules/node-pty/package.json",
	])
		await access(join(root, file));
	if (platform !== "win32") await access(join(root, runtimeNodeName(platform)), constants.X_OK);
	return files.length;
}
