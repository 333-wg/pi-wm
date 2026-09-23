export function redactDiagnostic(value: string): string {
	return value
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [已隐藏]")
		.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "$1-[已隐藏]")
		.replace(/((?:api[_ -]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]");
}
