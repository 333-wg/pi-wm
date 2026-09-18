import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_PALETTES,
	PALETTES,
	PALETTE_STORAGE_KEY,
	THEME_STORAGE_KEY,
	paletteMode,
	readStoredChoice,
	readStoredPalettes,
	resolveTheme,
} from "../src/lib/theme.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

describe("palette preferences", () => {
	it("keeps every palette preview aligned with its green accent", () => {
		const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
		for (const palette of PALETTES) {
			const opener = palette.id === "light" ? ":root {" : ':root[data-theme="' + palette.id + '"] {';
			const start = css.indexOf(opener);
			expect(start).toBeGreaterThanOrEqual(0);
			const block = css.slice(start + opener.length, css.indexOf("}", start));
			const accent = block.match(/--green:\s*([^;]+);/)?.[1];
			const expected = palette.id === "warm-classic" ? "#1e714d" : palette.mode === "light" ? "#217a54" : "#4fc48c";
			expect(palette.accent).toBe(expected);
			expect(accent).toBe(palette.accent);
		}
	});
	for (const palette of PALETTES) {
		it("restores " + palette.id + " in its own mode", () => {
			const stored = { ...DEFAULT_PALETTES, [palette.mode]: palette.id };
			expect(readStoredPalettes({ getItem: () => JSON.stringify(stored) })).toEqual(stored);
			expect(paletteMode(palette.id)).toBe(palette.mode);
		});
	}
	it("rejects invalid, blocked and wrong-mode values without losing valid preferences", () => {
		for (const value of [null, "null", "[]", "broken", '"paper"', '{"light":"ink-blue","dark":"paper"}']) {
			expect(readStoredPalettes({ getItem: () => value })).toEqual(DEFAULT_PALETTES);
		}
		expect(readStoredPalettes(undefined)).toEqual(DEFAULT_PALETTES);
		expect(
			readStoredPalettes({
				getItem: () => {
					throw new Error("blocked");
				},
			})
		).toEqual(DEFAULT_PALETTES);
		expect(readStoredPalettes({ getItem: () => '{"light":"paper","dark":"bad"}' })).toEqual({
			light: "paper",
			dark: "dark",
		});
	});
});

describe("pre-paint bootstrap parity", () => {
	for (const palette of PALETTES) {
		for (const choice of ["light", "dark", "system", "invalid", null]) {
			for (const systemDark of [false, true]) {
				it([palette.id, choice, systemDark].join(" / "), () => {
					const values: Record<string, string | null> = {
						[THEME_STORAGE_KEY]: choice,
						[PALETTE_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_PALETTES, [palette.mode]: palette.id }),
					};
					const storage = { getItem: (key: string) => values[key] ?? null };
					const root = { dataset: {} as Record<string, string>, lang: "" };
					let background = "";
					runInNewContext(script, {
						localStorage: storage,
						matchMedia: () => ({ matches: systemDark }),
						document: {
							documentElement: root,
							querySelector: () => ({
								setAttribute: (_key: string, value: string) => {
									background = value;
								},
							}),
						},
					});
					const expected = readStoredPalettes(storage)[resolveTheme(readStoredChoice(storage), systemDark)];
					expect(root.dataset.theme).toBe(expected);
					expect(background).toBe(PALETTES.find((entry) => entry.id === expected)!.background);
				});
			}
		}
	}
	it("still follows the OS when the storage getter throws", () => {
		const root = { dataset: {} as Record<string, string>, lang: "" };
		runInNewContext(script, {
			get localStorage() {
				throw new Error("blocked");
			},
			matchMedia: () => ({ matches: true }),
			document: {
				documentElement: root,
				querySelector: () => ({ setAttribute() {} }),
			},
		});
		expect(root.dataset.theme).toBe("dark");
	});
});
