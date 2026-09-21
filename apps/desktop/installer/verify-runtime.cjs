const { lstatSync, readFileSync } = require("node:fs");
const { isAbsolute, join, relative, resolve } = require("node:path");

function verifyInstalledRuntime(root) {
	const { files } = JSON.parse(readFileSync(join(root, "runtime-files.json"), "utf8"));
	if (!Array.isArray(files) || files.length === 0) throw new Error("Runtime inventory is empty");
	const missing = [];
	const required = [...new Set([...files, "node.exe", "apps/gateway/dist/main.js", "apps/web/dist/index.html", "verify-install.cjs"])];
	for (const file of required) {
		if (typeof file !== "string" || isAbsolute(file) || file.includes(":") || file.split(/[\\/]/).some((part) => !part || part === "." || part === ".."))
			throw new Error("Invalid runtime inventory path");
		const path = resolve(root, file);
		const rel = relative(root, path);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Runtime inventory escapes installation");
		try {
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink()) missing.push(file);
		} catch {
			missing.push(file);
		}
	}
	if (missing.length) throw new Error(`Runtime missing ${missing.length} files: ${missing.slice(0, 3).join(", ")}`);
	return required.length;
}

module.exports = { verifyInstalledRuntime };
if (require.main === module) {
	try {
		console.log(`Runtime inventory verified: ${verifyInstalledRuntime(__dirname)} files`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
