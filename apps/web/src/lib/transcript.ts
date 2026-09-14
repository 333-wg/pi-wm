// Pure helpers for the per-message actions in the transcript.

import type { ContentPart, TranscriptItem } from "@wuming/protocol";

/**
 * The text a copy button should put on the clipboard for one message: its text
 * parts, in order, separated by a blank line.
 *
 * Thinking is left out on purpose — it is the model's scratch space, is often
 * redacted, and is not what someone reaching for "copy" means. Tool calls and
 * artifacts are left out because they have their own affordances (a card, a
 * download button) and no useful plain-text form.
 */
export function messageText(parts: ContentPart[]): string {
	const texts: string[] = [];
	for (const part of parts) {
		if (part.type !== "text") continue;
		const text = part.text.trim();
		if (text !== "") texts.push(text);
	}
	return texts.join("\n\n");
}

/**
 * Whether a transcript item still has something user-facing to render.
 * Thinking deltas are intentionally excluded: they are internal model output,
 * while tool calls and artifacts have their own transcript affordances.
 */
export function hasVisibleContent(parts: ContentPart[], renderedToolCalls?: Set<string>): boolean {
	return parts.some((part) => {
		if (part.type === "text") return part.text.trim() !== "";
		if (part.type === "thinking") return false;
		if (part.type === "artifact") return true;
		return renderedToolCalls?.has(part.toolCallId) !== true;
	});
}

/**
 * The item a fork has to stop at for the new session to end *before* `itemId` —
 * what re-sending an edited message needs, since the edited text replaces the
 * original rather than following it.
 *
 * `undefined` means there is nothing to keep: `itemId` is the first item, or it
 * is not in this transcript at all. Callers must not pass that `undefined` on
 * to a fork — `session.fork` reads an absent anchor as "copy the whole
 * transcript", the exact opposite — and should start a fresh session instead.
 */
export function anchorBefore(transcript: TranscriptItem[], itemId: string): string | undefined {
	const index = transcript.findIndex((item) => item.id === itemId);
	return index > 0 ? transcript[index - 1]?.id : undefined;
}

/** The latest user message starts the turn whose live trace is still changing. */
export function latestUserItemIndex(transcript: TranscriptItem[]): number {
	return transcript.findLastIndex((item) => item.type === "user");
}

function clock(at: Date): string {
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The short time shown next to a message: clock time for today, month and day
 * ahead of it for anything older. Formatted by hand rather than through `Intl`
 * because the whole UI is Chinese, which makes the locale a constant and the
 * output stable enough to assert on.
 */
export function formatItemTime(timestamp: number, now: number): string {
	const at = new Date(timestamp);
	if (at.toDateString() === new Date(now).toDateString()) return clock(at);
	return `${at.getMonth() + 1} 月 ${at.getDate()} 日 ${clock(at)}`;
}

/** The full timestamp, for the `title` of the short one. */
export function formatItemTimestamp(timestamp: number): string {
	const at = new Date(timestamp);
	const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
	return `${date} ${clock(at)}:${String(at.getSeconds()).padStart(2, "0")}`;
}
