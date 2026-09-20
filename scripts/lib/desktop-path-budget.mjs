// Leave room for ordinary per-user installation roots in legacy NSIS source paths.
// Rollback destinations use the extended namespace; this limit also prevents future package growth.
export const MAX_DESKTOP_RELATIVE_PATH = 190;

export function verifyDesktopPathBudget(files) {
	let longest = "";
	for (const value of files) {
		if (typeof value !== "string") throw new Error("Invalid desktop package path");
		const path = value.replaceAll("\\", "/");
		if (path.split("/").some((part) => !part || part === "." || part === "..") || path.includes(":"))
			throw new Error(`Invalid desktop package path: ${path}`);
		if (path.length > MAX_DESKTOP_RELATIVE_PATH)
			throw new Error(`Desktop package path exceeds ${MAX_DESKTOP_RELATIVE_PATH} characters (${path.length}): ${path}`);
		if (path.length > longest.length) longest = path;
	}
	return { maxRelativeLength: longest.length, longestPath: longest, maxInstallRootLength: 258 - longest.length };
}
