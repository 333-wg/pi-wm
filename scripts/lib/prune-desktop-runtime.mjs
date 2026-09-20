import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export function runtimePruneReason(path, platform = process.platform, arch = process.arch) {
	if (!/^(node_modules|apps|packages)\//.test(path)) return undefined;
	if (/\.(?:[cm]?js|css|[cm]?ts)\.map$/.test(path)) return "sourceMaps";
	if (/\.d\.(?:ts|cts|mts)$/.test(path)) return "typeDeclarations";
	if (/\.pdb$/i.test(path)) return "debugSymbols";
	const prebuild = /(?:^|\/)node_modules\/node-pty\/prebuilds\/([^/]+)\//.exec(path);
	if (prebuild && prebuild[1] !== `${platform}-${arch}`) return "otherPlatforms";
	const conpty = /(?:^|\/)node_modules\/node-pty\/third_party\/conpty\/[^/]+\/win10-([^/]+)\//.exec(path);
	if (conpty && (platform !== "win32" || conpty[1] !== arch)) return "otherPlatforms";
	return undefined;
}

export async function pruneDesktopRuntime(directory, platform = process.platform, arch = process.arch) {
	const root = await realpath(directory);
	const summary = { removedFiles: 0, removedBytes: 0, byReason: {} };
	async function visit(path) {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const file = join(path, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Refusing to prune through a link: ${file}`);
			if (entry.isDirectory()) {
				await visit(file);
				continue;
			}
			if (!entry.isFile()) continue;
			const relativePath = relative(root, file).replaceAll("\\", "/");
			const reason = runtimePruneReason(relativePath, platform, arch);
			if (!reason) continue;
			const checked = relative(root, await realpath(file));
			if (checked.startsWith("..") || isAbsolute(checked) || resolve(root, checked) !== file)
				throw new Error("Prune target is outside the staged runtime");
			const { size } = await lstat(file);
			await unlink(file);
			summary.removedFiles++;
			summary.removedBytes += size;
			summary.byReason[reason] = (summary.byReason[reason] ?? 0) + size;
		}
	}
	await visit(root);
	return summary;
}
