import { describe, expect, it } from "vitest";
import {
	CHAT_APPEARANCE_KEY,
	DEFAULT_CHAT_APPEARANCE,
	chatAppearanceStyle,
	normalizeChatAppearance,
	readChatAppearance,
	writeChatAppearance,
} from "../src/lib/chat-appearance.js";

describe("device-local chat appearance", () => {
	it("recovers defaults from missing, corrupt or blocked storage", () => {
		for (const value of [null, "bad JSON", "null", "[]", '{"font":"bad","width":"bad","fontSize":"24"}']) {
			expect(readChatAppearance({ getItem: () => value })).toEqual(DEFAULT_CHAT_APPEARANCE);
		}
		expect(readChatAppearance()).toEqual(DEFAULT_CHAT_APPEARANCE);
		expect(
			readChatAppearance({
				getItem: () => {
					throw new Error("blocked");
				},
			})
		).toEqual(DEFAULT_CHAT_APPEARANCE);
	});
	it("validates every choice and clamps finite font sizes", () => {
		for (const font of ["system", "sans", "serif", "mono"])
			for (const width of ["standard", "wide", "full"]) {
				expect(normalizeChatAppearance({ font, width, fontSize: 20 })).toEqual({ font, width, fontSize: 20 });
			}
		for (const [input, expected] of [
			[-10, 12],
			[100, 24],
			[15.6, 16],
			[NaN, 14],
			[Infinity, 14],
		]) {
			expect(normalizeChatAppearance({ fontSize: input }).fontSize).toBe(expected);
		}
	});
	it("persists only validated local data and reports failed writes", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		};
		const settings = { font: "serif", fontSize: 24, width: "wide" } as const;
		expect(writeChatAppearance(storage, settings)).toBe(true);
		expect([...values.keys()]).toEqual([CHAT_APPEARANCE_KEY]);
		expect(readChatAppearance(storage)).toEqual(settings);
		expect(writeChatAppearance(undefined, settings)).toBe(false);
		expect(
			writeChatAppearance(
				{
					setItem: () => {
						throw new Error("quota");
					},
				},
				settings
			)
		).toBe(false);
		expect(chatAppearanceStyle(settings)).toMatchObject({ "--chat-font-size": "24px", "--chat-width": "1100px" });
	});
});
