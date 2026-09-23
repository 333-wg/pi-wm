/** Keep bounded diagnostic identifiers, never headers or request/response bodies. */
export function providerErrorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const details: string[] = [];
	let candidate = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 4 && candidate && typeof candidate === "object" && !seen.has(candidate); depth++) {
		seen.add(candidate);
		const entry = candidate as Record<string, unknown>;
		const status = entry.status ?? entry.statusCode;
		if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599)
			details.push(`HTTP ${status}`);
		if (typeof entry.code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(entry.code)) details.push(entry.code);
		const requestId = entry.request_id ?? entry.requestId;
		if (typeof requestId === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(requestId))
			details.push(`request_id=${requestId}`);
		candidate = entry.cause;
	}
	return (raw.slice(0, 3000) + (details.length ? ` [${[...new Set(details)].join("; ")}]` : ""))
		.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "$1-[REDACTED]")
		.replace(/((?:api[_ -]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
		.slice(0, 4000);
}
