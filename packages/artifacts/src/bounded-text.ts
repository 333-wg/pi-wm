/**
 * Normalize extracted attachment text and bound it to a character budget.
 * Shared by the in-process extractors and the isolated PDF worker.
 */
export function boundedText(value: string, maxChars: number): string {
	const normalized = value.replaceAll("\0", "").replaceAll("\r\n", "\n").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}\n\n[Attachment text truncated after ${maxChars} characters]`;
}
