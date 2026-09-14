import { clampModelThinkingLevel, type ThinkingLevel } from "@wuming/protocol";

/**
 * Canonical weakest-to-strongest order. The composer menu, the `/think` command
 * hint, and the stored-preference guard all read this one list so a level can
 * never be offered in one place and rejected in another.
 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const THINKING_STORAGE_KEY = "wuming.thinking";

/** Matches the level a reasoning model used to be created with implicitly. */
export const DEFAULT_THINKING: ThinkingLevel = "medium";

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

/** Stored bare rather than JSON-wrapped; the value is a single enum member. */
export function readStoredThinking(storage: Pick<Storage, "getItem"> | undefined): ThinkingLevel {
	if (!storage) return DEFAULT_THINKING;
	try {
		const raw = storage.getItem(THINKING_STORAGE_KEY);
		return isThinkingLevel(raw) ? raw : DEFAULT_THINKING;
	} catch {
		return DEFAULT_THINKING;
	}
}

export function writeStoredThinking(storage: Pick<Storage, "setItem"> | undefined, value: ThinkingLevel): void {
	if (!storage || !isThinkingLevel(value)) return;
	try {
		storage.setItem(THINKING_STORAGE_KEY, value);
	} catch {
		// The session keeps the level the gateway recorded; only the carry-over
		// to the next session is lost when browser storage is unavailable.
	}
}

export function supportedThinkingLevels(
	model:
		| {
				reasoning: boolean;
				thinkingLevels?: readonly ThinkingLevel[];
		  }
		| undefined
): readonly ThinkingLevel[] {
	if (!model?.reasoning) return ["off"];
	return model.thinkingLevels ?? THINKING_LEVELS;
}

/**
 * A non-reasoning model has no thinking budget to spend, so it is pinned to
 * "off" regardless of the preference. When a model exposes only a subset of
 * levels, carry the saved preference to the nearest supported level instead of
 * offering a setting that the provider cannot honor.
 */
export function thinkingLevelForModel(
	model: { reasoning: boolean; thinkingLevels?: readonly ThinkingLevel[] } | undefined,
	stored: ThinkingLevel
): ThinkingLevel {
	return clampModelThinkingLevel(model, stored);
}
