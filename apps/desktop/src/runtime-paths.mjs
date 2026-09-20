export function runtimeNodeName(platform = process.platform) {
	return platform === "win32" ? "node.exe" : "node";
}
