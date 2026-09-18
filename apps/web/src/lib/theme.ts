/**
 * Theme preference: a stored three-way choice ("跟随系统" / 浅色 / 深色) that
 * resolves to a light/dark mode, each with its own remembered palette.
 *
 * The resolved value is written to `document.documentElement.dataset.theme`,
 * which is the hook `styles.css` swaps its token block on. `index.html` runs the
 * same resolution inline before first paint so there is no light flash; the
 * constants below are duplicated there and must stay in sync.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "wuming.theme";
export const PALETTE_STORAGE_KEY = "wuming.theme.palettes";

export const PALETTES = [
	{ id: "light", mode: "light", zh: "原有浅色", en: "Original Light", background: "#f7f8f6", accent: "#217a54" },
	{ id: "white", mode: "light", zh: "纯白", en: "Pure White", background: "#ffffff", accent: "#217a54" },
	{ id: "paper", mode: "light", zh: "纸墨", en: "Paper & Ink", background: "#fbf9f4", accent: "#217a54" },
	{ id: "warm-classic", mode: "light", zh: "经典暖色", en: "Classic Warm", background: "#f6f0e1", accent: "#1e714d" },
	{ id: "celadon", mode: "light", zh: "青瓷", en: "Celadon", background: "#f5f8f5", accent: "#217a54" },
	{ id: "dark", mode: "dark", zh: "原有深色", en: "Original Dark", background: "#0e120f", accent: "#4fc48c" },
	{ id: "ink-night", mode: "dark", zh: "墨夜", en: "Ink Night", background: "#201d17", accent: "#4fc48c" },
	{ id: "ink-blue", mode: "dark", zh: "墨夜蓝", en: "Ink Blue", background: "#1a1d24", accent: "#4fc48c" },
] as const;

export type ThemePalette = (typeof PALETTES)[number]["id"];
export type PalettePreferences = Record<ResolvedTheme, ThemePalette>;
export const DEFAULT_PALETTES: PalettePreferences = { light: "light", dark: "dark" };

export function paletteMode(palette: string): ResolvedTheme {
	return PALETTES.find((entry) => entry.id === palette)?.mode ?? "light";
}

export function readStoredPalettes(storage: Pick<Storage, "getItem"> | undefined): PalettePreferences {
	try {
		const value: unknown = JSON.parse(storage?.getItem(PALETTE_STORAGE_KEY) ?? "null");
		const result = { ...DEFAULT_PALETTES };
		if (value && typeof value === "object") {
			for (const mode of ["light", "dark"] as const) {
				const id = (value as Record<string, unknown>)[mode];
				const palette = PALETTES.find((entry) => entry.id === id && entry.mode === mode);
				if (palette) result[mode] = palette.id;
			}
		}
		return result;
	} catch {
		return { ...DEFAULT_PALETTES };
	}
}

export function themeStorage(): Storage | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

const CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

export function isThemeChoice(value: unknown): value is ThemeChoice {
	return typeof value === "string" && (CHOICES as readonly string[]).includes(value);
}

/** Tolerates a missing, blocked, or garbage-filled storage slot. */
export function readStoredChoice(storage: Pick<Storage, "getItem"> | undefined): ThemeChoice {
	if (!storage) return "system";
	try {
		const raw = storage.getItem(THEME_STORAGE_KEY);
		return isThemeChoice(raw) ? raw : "system";
	} catch {
		return "system";
	}
}

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
	if (choice === "system") return systemPrefersDark ? "dark" : "light";
	return choice;
}

/**
 * What the one-tap toggle should switch to. "system" resolves first so the tap
 * always flips what the user is currently looking at rather than jumping to a
 * fixed theme.
 */
export function toggleChoice(choice: ThemeChoice, systemPrefersDark: boolean): ThemeChoice {
	return resolveTheme(choice, systemPrefersDark) === "dark" ? "light" : "dark";
}

export function themeLabel(choice: ThemeChoice, locale: "zh" | "en" = "zh"): string {
	if (locale === "en") {
		if (choice === "light") return "Light";
		if (choice === "dark") return "Dark";
		return "Follow system";
	}
	if (choice === "light") return "浅色";
	if (choice === "dark") return "深色";
	return "跟随系统";
}

/** Applies the resolved theme to the document. Safe to call repeatedly. */
export function applyTheme(theme: ThemePalette): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", PALETTES.find((entry) => entry.id === theme)!.background);
}
