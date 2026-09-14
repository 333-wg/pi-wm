import { describe, expect, it } from "vitest";
import type { ThinkingLevel } from "@wuming/protocol";
import {
	DEFAULT_THINKING,
	isThinkingLevel,
	readStoredThinking,
	THINKING_LEVELS,
	THINKING_STORAGE_KEY,
	thinkingLevelForModel,
	writeStoredThinking,
} from "../src/lib/thinking-preference.js";

function readableStorage(value: string | null, throws = false): Pick<Storage, "getItem"> {
	return {
		getItem() {
			if (throws) throw new Error("storage is blocked");
			return value;
		},
	};
}

describe("thinking preference", () => {
	it("reads every level the protocol accepts", () => {
		for (const level of THINKING_LEVELS) {
			expect(readStoredThinking(readableStorage(level))).toBe(level);
		}
	});

	it("falls back when the stored value is missing, unknown, or inaccessible", () => {
		expect(readStoredThinking(readableStorage(null))).toBe(DEFAULT_THINKING);
		expect(readStoredThinking(readableStorage(""))).toBe(DEFAULT_THINKING);
		expect(readStoredThinking(readableStorage("ultra"))).toBe(DEFAULT_THINKING);
		expect(readStoredThinking(readableStorage(JSON.stringify("high")))).toBe(DEFAULT_THINKING);
		expect(readStoredThinking(readableStorage(null, true))).toBe(DEFAULT_THINKING);
		expect(readStoredThinking(undefined)).toBe(DEFAULT_THINKING);
	});

	it("writes the level bare and tolerates blocked storage", () => {
		const entries = new Map<string, string>();
		writeStoredThinking({ setItem: (key, value) => entries.set(key, value) }, "xhigh");
		expect(entries.get(THINKING_STORAGE_KEY)).toBe("xhigh");
		writeStoredThinking({ setItem: (key, value) => entries.set(key, value) }, "nonsense" as ThinkingLevel);
		expect(entries.get(THINKING_STORAGE_KEY)).toBe("xhigh");
		expect(() =>
			writeStoredThinking(
				{
					setItem: () => {
						throw new Error("storage is blocked");
					},
				},
				"max"
			)
		).not.toThrow();
	});

	it("recognises only protocol levels", () => {
		expect(isThinkingLevel("medium")).toBe(true);
		expect(isThinkingLevel("MEDIUM")).toBe(false);
		expect(isThinkingLevel(undefined)).toBe(false);
		expect(isThinkingLevel(3)).toBe(false);
	});

	it("pins non-reasoning models to off and carries a reasoning choice over verbatim", () => {
		expect(thinkingLevelForModel({ reasoning: false }, "max")).toBe("off");
		expect(thinkingLevelForModel(undefined, "max")).toBe("off");
		for (const level of THINKING_LEVELS) {
			expect(thinkingLevelForModel({ reasoning: true }, level)).toBe(level);
		}
		expect(thinkingLevelForModel({ reasoning: true, thinkingLevels: ["off", "low", "medium", "high"] }, "xhigh")).toBe(
			"high"
		);
	});

	it("clamps like Pi, preferring the next stronger available level", () => {
		expect(thinkingLevelForModel({ reasoning: true, thinkingLevels: ["off", "high"] }, "medium")).toBe("high");
		expect(thinkingLevelForModel({ reasoning: true, thinkingLevels: ["low", "high"] }, "off")).toBe("low");
		expect(thinkingLevelForModel({ reasoning: true, thinkingLevels: ["off", "low", "high", "max"] }, "medium")).toBe(
			"high"
		);
	});
});
