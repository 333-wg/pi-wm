/**
 * Theme preference: a stored three-way choice ("跟随系统" / 浅色 / 深色) that
 * resolves to the two concrete themes the stylesheet implements.
 *
 * The resolved value is written to `document.documentElement.dataset.theme`,
 * which is the hook `styles.css` swaps its token block on. `index.html` runs the
 * same resolution inline before first paint so there is no light flash; the
 * constants below are duplicated there and must stay in sync.
 */

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "wuming.theme";

/** Matches `<meta name="theme-color">`, kept aligned with `--bg`. */
const BACKGROUND: Record<ResolvedTheme, string> = { light: "#f7f8f6", dark: "#0e120f" };

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
export function applyTheme(theme: ResolvedTheme): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", BACKGROUND[theme]);
}
