import { describe, expect, it } from "vitest";
import { isLocale, localeLabel, readStoredLocale, type Locale } from "../src/lib/locale.js";

function storage(value: string | null, throws = false): Pick<Storage, "getItem"> {
	return {
		getItem() {
			if (throws) throw new Error("storage is blocked");
			return value;
		},
	};
}

describe("readStoredLocale", () => {
	it("returns each supported language", () => {
		for (const locale of ["zh", "en"] as Locale[]) {
			expect(readStoredLocale(storage(locale))).toBe(locale);
		}
	});

	it("falls back to Chinese for missing or invalid storage", () => {
		expect(readStoredLocale(storage(null))).toBe("zh");
		expect(readStoredLocale(storage("fr"))).toBe("zh");
		expect(readStoredLocale(storage("", true))).toBe("zh");
		expect(readStoredLocale(undefined)).toBe("zh");
	});
});

describe("isLocale", () => {
	it("accepts only the supported values", () => {
		expect(isLocale("zh")).toBe(true);
		expect(isLocale("en")).toBe(true);
		expect(isLocale("ZH")).toBe(false);
		expect(isLocale(null)).toBe(false);
		expect(isLocale(undefined)).toBe(false);
	});
});

describe("localeLabel", () => {
	it("uses the native language names", () => {
		expect(localeLabel("zh")).toBe("中文");
		expect(localeLabel("en")).toBe("English");
	});
});
