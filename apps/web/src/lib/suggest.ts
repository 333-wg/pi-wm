/**
 * Composer autocomplete primitives: where a trigger token starts, how well a
 * candidate matches it, and what the textarea should contain once a candidate
 * is accepted. Everything here is pure so the composer stays a thin shell.
 */

export type TriggerKind = "file" | "command" | "skill";

export interface Trigger {
	kind: TriggerKind;
	/** Index of the trigger character (`@` or `/`) in the raw text. */
	start: number;
	/** Caret position, i.e. the end of the token being completed. */
	end: number;
	/** Text between the trigger character and the caret. */
	query: string;
}

/** Characters allowed inside a mention token; whitespace always ends one. */
const fileToken = /^[^\s"'`,;()[\]{}<>]*$/;
const commandToken = /^[\p{L}\p{N}:._-]*$/u;

/**
 * Slash commands only complete when they are the whole prompt, matching the
 * desktop clients: `/new` is a command, `run /new` is prose.
 */
export function detectTrigger(text: string, caret: number): Trigger | undefined {
	const position = Math.max(0, Math.min(caret, text.length));
	const before = text.slice(0, position);
	if (before.startsWith("/") && !before.includes("\n")) {
		const query = before.slice(1);
		if (commandToken.test(query)) return { kind: "command", start: 0, end: position, query };
	}
	const dollar = before.lastIndexOf("$");
	if (dollar >= 0 && (dollar === 0 || /[\s(["'`]/.test(before[dollar - 1]!))) {
		const query = before.slice(dollar + 1);
		if (commandToken.test(query)) return { kind: "skill", start: dollar, end: position, query };
	}
	const at = before.lastIndexOf("@");
	if (at === -1) return undefined;
	const query = before.slice(at + 1);
	if (!fileToken.test(query)) return undefined;
	const preceding = at === 0 ? undefined : before[at - 1];
	if (preceding !== undefined && !/[\s(["'`]/.test(preceding)) return undefined;
	return { kind: "file", start: at, end: position, query };
}

function isBoundary(character: string | undefined): boolean {
	return (
		character === undefined ||
		character === "/" ||
		character === "." ||
		character === "-" ||
		character === "_" ||
		character === " "
	);
}

/**
 * Case-insensitive subsequence score, higher is better, `undefined` when the
 * needle is not a subsequence. Mirrors the gateway's path ranking so locally
 * filtered lists feel like the server-ranked ones.
 */
export function subsequenceScore(haystack: string, needle: string): number | undefined {
	if (needle === "") return 0;
	const hay = haystack.toLowerCase();
	let score = 0;
	let cursor = 0;
	let previous = -2;
	for (const character of needle.toLowerCase()) {
		const found = hay.indexOf(character, cursor);
		if (found === -1) return undefined;
		score += 12;
		if (found === previous + 1) score += 10;
		if (isBoundary(hay[found - 1])) score += 8;
		score -= Math.min(found - cursor, 10);
		previous = found;
		cursor = found + 1;
	}
	return score;
}

/** Ranks items by the best score across the strings each item exposes. */
export function rankBy<T>(items: readonly T[], query: string, keys: (item: T) => readonly string[], limit = 12): T[] {
	const scored: { item: T; score: number; order: number }[] = [];
	for (const [order, item] of items.entries()) {
		let best: number | undefined;
		for (const key of keys(item)) {
			const score = subsequenceScore(key, query);
			if (score !== undefined && (best === undefined || score > best)) best = score;
		}
		if (best !== undefined) scored.push({ item, score: best, order });
	}
	scored.sort((left, right) => right.score - left.score || left.order - right.order);
	return scored.slice(0, limit).map((entry) => entry.item);
}

/** Paths containing separators or quotes are wrapped so the token stays whole. */
export function quoteMention(path: string): string {
	return /[\s"']/.test(path) ? `"${path.replaceAll('"', '\\"')}"` : path;
}

export interface Completion {
	text: string;
	caret: number;
}

/**
 * Replaces the trigger token with `value`, keeping a single trailing space so
 * the next keystroke starts a fresh word instead of extending the mention.
 */
export function applyCompletion(text: string, trigger: Trigger, value: string, { trailing = true } = {}): Completion {
	const marker = trigger.kind === "file" ? "@" : trigger.kind === "skill" ? "$" : "/";
	const rest = text.slice(trigger.end);
	const spaced = trailing && !rest.startsWith(" ");
	const inserted = `${marker}${value}${spaced ? " " : ""}`;
	return {
		text: `${text.slice(0, trigger.start)}${inserted}${rest}`,
		caret: trigger.start + inserted.length,
	};
}

/** Wraps an index into `[0, length)` so ↑/↓ cycle through the menu. */
export function cycleIndex(current: number, delta: number, length: number): number {
	if (length === 0) return 0;
	return (current + delta + length) % length;
}
