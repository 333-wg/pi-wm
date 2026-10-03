import { describe, expect, it } from "vitest";
import { FALLBACK_WALLPAPER_ACCENT, sampleWallpaperAccent, wallpaperPalette } from "../src/lib/wallpaper-palette.js";
function luminance(hex: string): number {
	const c = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return c[0]! * 0.2126 + c[1]! * 0.7152 + c[2]! * 0.0722;
}
function contrast(a: string, b: string): number {
	const x = luminance(a),
		y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
describe("wallpaper palette", () => {
	it("ignores transparent pixels, neutral extremes and invalid seed strings", () => {
		expect(sampleWallpaperAccent([255, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 100, 100, 100, 255])).toBe(
			FALLBACK_WALLPAPER_ACCENT
		);
		expect(wallpaperPalette("url(https://invalid)", "light")).toEqual(
			wallpaperPalette(FALLBACK_WALLPAPER_ACCENT, "light")
		);
	});
	it("uses a dominant hue instead of a bright outlier", () => {
		const blue = [50, 100, 180, 255];
		expect(sampleWallpaperAccent([...Array.from({ length: 20 }, () => blue).flat(), 255, 0, 0, 255])).toBe("#3264b4");
	});
	it("generates distinct image-coordinated accents with stable semantic colours", () => {
		for (const mode of ["light", "dark"] as const) {
			const warm = wallpaperPalette("#cc6633", mode),
				cold = wallpaperPalette("#3366cc", mode);
			expect(warm["--green"]).not.toBe(cold["--green"]);
			expect(warm["--red"]).toBe(cold["--red"]);
			expect(warm["--amber"]).toBe(cold["--amber"]);
		}
	});
	it("keeps text, syntax, accents and filled buttons readable across sampled hues", () => {
		for (const seed of ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#999999", "#cc8844"])
			for (const mode of ["light", "dark"] as const) {
				const p = wallpaperPalette(seed, mode);
				for (const key of ["--text", "--muted", "--green", "--red", "--amber", "--tok-string", "--tok-keyword"])
					expect(contrast(p[key]!, p["--panel"]!), `${seed}/${mode}/${key}`).toBeGreaterThanOrEqual(4.5);
				expect(contrast(p["--solid"]!, p["--solid-text"]!)).toBeGreaterThanOrEqual(4.5);
			}
	});
});
