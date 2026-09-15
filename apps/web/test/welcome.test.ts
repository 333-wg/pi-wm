import { describe, expect, it } from "vitest";
import { DESKTOP_WELCOME_KEY, isDesktopWelcomePassword, readDesktopWelcome } from "../src/lib/welcome.js";

describe("desktop first-use gate", () => {
	it("accepts only the requested password, without changing the gateway credential", () => {
		expect(isDesktopWelcomePassword("wuming")).toBe(true);
		for (const value of ["", "Wuming", " wuming", "wuming ", "wrong-password"]) {
			expect(isDesktopWelcomePassword(value)).toBe(false);
		}
	});
	it("requires a completed first-use marker", () => {
		expect(readDesktopWelcome(undefined)).toBe(false);
		for (const value of [null, "false", "1", ""]) {
			expect(readDesktopWelcome({ getItem: () => value })).toBe(false);
		}
		expect(readDesktopWelcome({ getItem: (key) => (key === DESKTOP_WELCOME_KEY ? "true" : null) })).toBe(true);
	});
	it("stays locked if storage is unavailable", () => {
		expect(
			readDesktopWelcome({
				getItem: () => {
					throw new Error("blocked");
				},
			})
		).toBe(false);
	});
});
