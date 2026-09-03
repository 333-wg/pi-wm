import { describe, expect, it } from "vitest";
import {
	isThemeChoice,
	readStoredChoice,
	resolveTheme,
	themeLabel,
	toggleChoice,
	type ThemeChoice,
} from "../src/lib/theme.js";

/** Storage stand-in that can also fail the way a blocked slot does. */
function storage(value: string | null, throws = false): Pick<Storage, "getItem"> {
	return {
		getItem() {
			if (throws) throw new Error("storage is blocked");
			return value;
		},
	};
}

describe("readStoredChoice", () => {
	it("returns each stored choice", () => {
		for (const choice of ["system", "light", "dark"] as ThemeChoice[]) {
			expect(readStoredChoice(storage(choice))).toBe(choice);
		}
	});

	it("falls back to following the system", () => {
		// An unset slot, a value from an older build, and a storage that throws all
		// have to degrade to the same safe default rather than to a fixed theme.
		expect(readStoredChoice(storage(null))).toBe("system");
		expect(readStoredChoice(storage("solarized"))).toBe("system");
		expect(readStoredChoice(storage("", true))).toBe("system");
		expect(readStoredChoice(undefined)).toBe("system");
	});
});

describe("resolveTheme", () => {
	it("defers to the operating system only for the system choice", () => {
		expect(resolveTheme("system", true)).toBe("dark");
		expect(resolveTheme("system", false)).toBe("light");
		expect(resolveTheme("light", true)).toBe("light");
		expect(resolveTheme("dark", false)).toBe("dark");
	});
});

describe("toggleChoice", () => {
	it("flips what the user is currently looking at", () => {
		expect(toggleChoice("light", false)).toBe("dark");
		expect(toggleChoice("dark", false)).toBe("light");
		// "system" resolves first, so the tap never jumps to the theme already shown.
		expect(toggleChoice("system", true)).toBe("light");
		expect(toggleChoice("system", false)).toBe("dark");
	});

	it("always lands on an explicit choice", () => {
		for (const choice of ["system", "light", "dark"] as ThemeChoice[]) {
			for (const dark of [true, false]) {
				expect(toggleChoice(choice, dark)).not.toBe("system");
			}
		}
	});
});

describe("isThemeChoice", () => {
	it("accepts the three choices and nothing else", () => {
		expect(isThemeChoice("system")).toBe(true);
		expect(isThemeChoice("light")).toBe(true);
		expect(isThemeChoice("dark")).toBe(true);
		expect(isThemeChoice("Dark")).toBe(false);
		expect(isThemeChoice(null)).toBe(false);
		expect(isThemeChoice(undefined)).toBe(false);
		expect(isThemeChoice(0)).toBe(false);
	});
});

describe("themeLabel", () => {
	it("names every choice", () => {
		expect(themeLabel("system")).toBe("跟随系统");
		expect(themeLabel("light")).toBe("浅色");
		expect(themeLabel("dark")).toBe("深色");
	});
});
