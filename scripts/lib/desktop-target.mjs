export function desktopTarget(platform = process.platform, arch = process.arch) {
	if (platform === "win32" && arch === "x64") return { platform, arch, targets: ["nsis"] };
	if (platform === "darwin" && ["x64", "arm64"].includes(arch))
		return {
			platform,
			arch,
			targets: ["dmg", "zip"],
		};
	throw new Error(
		`Unsupported desktop build host: ${platform}-${arch}. Build natively on Windows x64 or macOS x64/arm64.`
	);
}
