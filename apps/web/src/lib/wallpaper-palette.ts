import type { ResolvedTheme } from "./theme.js";

export const FALLBACK_WALLPAPER_ACCENT = "#66849b";
type RGB = readonly [number, number, number];
function hsl([r, g, b]: RGB): [number, number, number] {
	const [red, green, blue] = [r / 255, g / 255, b / 255];
	const max = Math.max(red!, green!, blue!),
		min = Math.min(red!, green!, blue!);
	const delta = max - min,
		light = (max + min) / 2;
	if (!delta) return [210, 0, light];
	const hue =
		max === red
			? ((green! - blue!) / delta + 6) % 6
			: max === green
				? (blue! - red!) / delta + 2
				: (red! - green!) / delta + 4;
	return [hue * 60, delta / (1 - Math.abs(2 * light - 1)), light];
}
function hex(h: number, s: number, l: number): string {
	const c = (1 - Math.abs(2 * l - 1)) * s,
		hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1)),
		m = l - c / 2;
	const rgb =
		hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	return `#${rgb
		.map((v) =>
			Math.round((v + m) * 255)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

/** Dominant chromatic family, not a single brightest pixel. Transparent, near-black
 * and near-white pixels cannot dictate the UI; grayscale falls back to neutral blue. */
export function sampleWallpaperAccent(pixels: ArrayLike<number>): string {
	const bins = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
	for (let i = 0; i + 3 < pixels.length; i += 4) {
		const r = pixels[i]!,
			g = pixels[i + 1]!,
			b = pixels[i + 2]!,
			alpha = pixels[i + 3]! / 255;
		const [h, s, l] = hsl([r, g, b]);
		if (alpha < 0.5 || s < 0.12 || l < 0.08 || l > 0.92) continue;
		const weight = alpha * Math.min(s, 0.65) * (1 - Math.abs(l - 0.5));
		const bin = bins[Math.floor(h / 15) % 24]!;
		bin.weight += weight;
		bin.r += r * weight;
		bin.g += g * weight;
		bin.b += b * weight;
	}
	const winner = bins.reduce((a, b) => (b.weight > a.weight ? b : a));
	if (!winner.weight) return FALLBACK_WALLPAPER_ACCENT;
	return `#${[winner.r, winner.g, winner.b]
		.map((v) =>
			Math.round(v / winner.weight)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

/** Bounded local sampling; no upload, full-resolution canvas or stored image data. */
export async function readWallpaperAccent(blob: Blob): Promise<string> {
	const image = await createImageBitmap(blob, { resizeWidth: 48, resizeHeight: 48 });
	try {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 48;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return FALLBACK_WALLPAPER_ACCENT;
		context.drawImage(image, 0, 0, 48, 48);
		return sampleWallpaperAccent(context.getImageData(0, 0, 48, 48).data);
	} finally {
		image.close();
	}
}

/** Wallpaper owns its palette while active. Inline overrides are removed on exit;
 * the user's classic data-theme and saved palette preferences are never rewritten. */
export function wallpaperPalette(seed: string, mode: ResolvedTheme): Record<string, string> {
	const safe = /^#[0-9a-f]{6}$/i.test(seed) ? seed : FALLBACK_WALLPAPER_ACCENT;
	const [h, saturation] = hsl([
		parseInt(safe.slice(1, 3), 16),
		parseInt(safe.slice(3, 5), 16),
		parseInt(safe.slice(5, 7), 16),
	]);
	const dark = mode === "dark",
		s = Math.min(0.52, Math.max(0.25, saturation));
	const neutral = (light: number, shade: number) => hex(h, 0.045, dark ? shade : light);
	const accent = hex(h, s, dark ? 0.76 : 0.29);
	const text = neutral(0.09, 0.96),
		muted = neutral(0.25, 0.79);
	const tokens: Record<string, string> = {
		bg: neutral(0.965, 0.065),
		panel: neutral(0.985, 0.095),
		surface: neutral(0.985, 0.115),
		"surface-muted": neutral(0.95, 0.1),
		"surface-sunken": neutral(0.93, 0.075),
		"surface-hover": neutral(0.89, 0.19),
		"surface-code": neutral(0.975, 0.07),
		sidebar: neutral(0.94, 0.08),
		fill: neutral(0.89, 0.19),
		track: neutral(0.87, 0.22),
		ink: text,
		text,
		"text-soft": neutral(0.18, 0.88),
		muted,
		faint: muted,
		"faint-soft": neutral(0.37, 0.64),
		dot: neutral(0.38, 0.67),
		line: neutral(0.77, 0.29),
		"line-soft": neutral(0.86, 0.21),
		"line-strong": neutral(0.63, 0.43),
		green: accent,
		"green-strong": accent,
		"green-mute": accent,
		"green-soft": hex(h, 0.17, dark ? 0.19 : 0.91),
		"green-border": hex(h, 0.2, dark ? 0.39 : 0.73),
		solid: hex(h, s, dark ? 0.72 : 0.31),
		"solid-hover": hex(h, s, dark ? 0.8 : 0.24),
		"solid-text": dark ? "#101010" : "#ffffff",
		"solid-off": neutral(0.79, 0.26),
		"focus-line": accent,
		"focus-ring": `0 0 0 3px ${accent}40`,
		"accent-glow": `${accent}30`,
		"accent-glow-off": `${accent}00`,
		"code-inline": neutral(0.91, 0.16),
		"code-inline-text": text,
		"term-text": text,
		"term-muted": muted,
		"term-ready": accent,
		"term-bg": neutral(0.975, 0.07),
		"term-head": neutral(0.95, 0.1),
		"term-line": neutral(0.77, 0.29),
		overlay: dark ? "#00000088" : "#10182044",
		scrim: "#00000055",
	};
	// Semantic and syntax colours retain their meaning, independently of image hue.
	for (const [name, hue] of [
		["blue", 210],
		["amber", 38],
		["red", 4],
	] as const) {
		tokens[name] = hex(hue, 0.55, dark ? 0.77 : 0.3);
		tokens[`${name}-ink`] = tokens[name]!;
		tokens[`${name}-soft`] = hex(hue, 0.2, dark ? 0.14 : 0.96);
		tokens[`${name}-fill`] = hex(hue, 0.24, dark ? 0.19 : 0.92);
		tokens[`${name}-border`] = hex(hue, 0.25, dark ? 0.38 : 0.75);
	}
	for (const [name, hue] of [
		["string", 145],
		["number", 35],
		["keyword", 290],
		["builtin", 210],
		["function", 220],
		["property", 165],
		["tag", 5],
	] as const)
		tokens[`tok-${name}`] = hex(hue, 0.42, dark ? 0.77 : 0.3);
	tokens["tok-comment"] = muted;
	tokens["tok-punct"] = muted;
	tokens["tok-meta"] = muted;
	tokens["term-error-bg"] = tokens["red-fill"]!;
	tokens["term-error-text"] = tokens.red!;
	return Object.fromEntries(Object.entries(tokens).map(([key, value]) => [`--${key}`, value]));
}
