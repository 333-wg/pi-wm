const REFERENCE_TYPE = "wuming-reference-context";
const REFERENCE_HEADING = "## Current host reference snapshot\n";

function includesSnapshot(content: unknown): boolean {
	if (typeof content === "string") return content.includes(REFERENCE_HEADING);
	return Array.isArray(content) && content.some((part) => part?.type === "text" && includesSnapshot(part.text));
}

/** Inspect active messages, not the durable branch: compacted snapshots must be resent. */
export function pendingReferenceMessage(
	content: string | undefined,
	messages: readonly { role: string; customType?: string; content?: unknown }[]
) {
	if (content === undefined) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const entry = messages[index]!;
		// Streaming steer/follow-up requests carry a snapshot inline, not via the
		// before-agent-start hook. Re-send once to supersede that newer snapshot.
		if (entry.role === "user" && includesSnapshot(entry.content)) break;
		if (entry.role === "custom" && entry.customType === REFERENCE_TYPE) {
			if (entry.content === content) return undefined;
			break;
		}
	}
	return { customType: REFERENCE_TYPE, content, display: false };
}
