import { describe, expect, it } from "vitest";
import { terminalTheme, withAlpha } from "../src/lib/terminal-theme.js";

/** Stands in for `getComputedStyle(element).getPropertyValue`, which returns "" for a missing property. */
function reader(tokens: Record<string, string>): (name: string) => string {
	return (name) => tokens[name] ?? "";
}

/** The committed values of the three terminal colour tokens. */
const TOKENS = { "--term-bg": "#17201a", "--term-text": "#e7eee9", "--term-ready": "#a8d6b5" };

const RESOLVED = {
	background: "#17201a",
	foreground: "#e7eee9",
	cursor: "#a8d6b5",
	selectionBackground: "rgba(168, 214, 181, 0.32)",
};

describe("terminalTheme", () => {
	it("hands xterm what the token block says", () => {
		expect(terminalTheme(reader(TOKENS))).toStrictEqual(RESOLVED);
	});

	it("trims the value the browser hands back", () => {
		// Custom properties keep the whitespace they were authored with, so a token
		// can arrive padded; every slot has to survive that, not just the parsed one.
		const padded = reader({
			"--term-bg": " #17201a",
			"--term-text": "#e7eee9 ",
			"--term-ready": " #a8d6b5 ",
		});
		expect(terminalTheme(padded)).toStrictEqual(RESOLVED);
	});

	it("leaves a slot out when its token is missing", () => {
		// Not a fallback colour: xterm's own default is the honest answer when the
		// stylesheet has nothing to say.
		expect(terminalTheme(reader({}))).toStrictEqual({});
		expect(terminalTheme(reader({ "--term-bg": "#17201a", "--term-text": "   " }))).toStrictEqual({
			background: "#17201a",
		});
	});

	it("passes an unwashable accent through but skips the selection", () => {
		// A token that is not plain hex still means something to xterm, so it goes
		// through; only the wash, which needs the channels, has to be dropped.
		expect(terminalTheme(reader({ ...TOKENS, "--term-ready": "color-mix(in srgb, #fff, #000)" }))).toStrictEqual({
			background: "#17201a",
			foreground: "#e7eee9",
			cursor: "color-mix(in srgb, #fff, #000)",
		});
	});
});

describe("withAlpha", () => {
	it("expands the three-digit form", () => {
		expect(withAlpha("#abc", 0.5)).toBe("rgba(170, 187, 204, 0.5)");
		expect(withAlpha("#000", 1)).toBe("rgba(0, 0, 0, 1)");
	});

	it("reads either case", () => {
		expect(withAlpha("#A8D6B5", 0.32)).toBe("rgba(168, 214, 181, 0.32)");
	});

	it("refuses anything that is not a hex colour", () => {
		expect(withAlpha("rgb(1, 2, 3)", 0.5)).toBeUndefined();
		expect(withAlpha("#12345", 0.5)).toBeUndefined();
		expect(withAlpha("#ggg", 0.5)).toBeUndefined();
		expect(withAlpha("", 0.5)).toBeUndefined();
		// Trimming belongs to the caller, so a padded value is not a colour here.
		expect(withAlpha(" #abc", 0.5)).toBeUndefined();
	});
});
