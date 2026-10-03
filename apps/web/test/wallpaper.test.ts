import { describe, expect, it } from "vitest";
import {
	DEFAULT_WALLPAPER,
	normalizeWallpaper,
	readWallpaper,
	validateWallpaperFile,
	wallpaperStyle,
} from "../src/lib/wallpaper.js";

describe("wallpaper preferences", () => {
	it("fails closed for corrupted, blocked and future preferences", () => {
		for (const raw of ["broken", "null", "[]", '{"version":2,"kind":"image"}'])
			expect(readWallpaper({ getItem: () => raw })).toEqual(DEFAULT_WALLPAPER);
		expect(
			readWallpaper({
				getItem() {
					throw new Error("blocked");
				},
			})
		).toEqual(DEFAULT_WALLPAPER);
	});
	it("bounds visual values and rejects unknown backgrounds and injected URLs", () => {
		expect(
			normalizeWallpaper({
				version: 1,
				kind: "url(https://bad)",
				focusX: -9,
				focusY: 900,
				shade: NaN,
				opacity: 0,
				motion: "true",
				imageRevision: "https://bad",
			})
		).toEqual({ ...DEFAULT_WALLPAPER, focusX: 0, focusY: 100, opacity: 60 });
	});
	it("round-trips preferences without storing image bytes", () => {
		const value = { ...DEFAULT_WALLPAPER, kind: "image" as const, focusX: 76, motion: true, imageRevision: "abc-123" };
		expect(readWallpaper({ getItem: () => JSON.stringify(value) })).toEqual(value);
		expect(wallpaperStyle(value)).toHaveProperty("--wallpaper-art", "none");
		expect(wallpaperStyle(value, "blob:local")).toHaveProperty("--wallpaper-art", 'url("blob:local")');
	});
	it("rejects executable formats, empty and oversized images", () => {
		for (const type of ["image/svg+xml", "text/html", "video/mp4", ""])
			expect(() => validateWallpaperFile({ type, size: 10 })).toThrow("format");
		for (const size of [0, 10 * 1024 * 1024 + 1])
			expect(() => validateWallpaperFile({ type: "image/png", size })).toThrow("size");
		for (const type of ["image/png", "image/jpeg", "image/webp"])
			expect(() => validateWallpaperFile({ type, size: 200 })).not.toThrow();
	});
});
