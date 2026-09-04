import type { ITheme } from "@xterm/xterm";

/**
 * The terminal's colours, resolved from the token block.
 *
 * xterm paints its own markup, so unlike the rest of the app it cannot inherit a
 * custom property: the values have to be read out and handed over, then handed
 * over again whenever the token block changes underneath it. Keeping the literals
 * next to the terminal instead would let `--term-*` drift from what is actually
 * on screen — the chrome around the terminal would restyle while the surface
 * inside it stayed put, and `check:contrast` would go on passing either way
 * because it only ever sees the tokens.
 */

/** Selection has no token of its own; it is the accent washed over the background. */
const SELECTION_ALPHA = 0.32;

/**
 * `rgba()` from a `#rgb` or `#rrggbb` colour, or `undefined` for anything else.
 *
 * Expects an already-trimmed value: the one place that trims is the token read
 * below, so a second trim here would be an untestable duplicate.
 */
export function withAlpha(color: string, alpha: number): string | undefined {
	const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
	if (digits === undefined) return undefined;
	const pairs =
		digits.length === 3
			? [...digits].map((digit) => digit + digit)
			: [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
	const channels = pairs.map((pair) => Number.parseInt(pair, 16));
	return `rgba(${channels.join(", ")}, ${alpha})`;
}

/** Shaped like `getComputedStyle(element).getPropertyValue`. */
export type TokenReader = (name: string) => string;

export function terminalTheme(read: TokenReader): ITheme {
	// A missing token leaves its slot out so xterm keeps its own default. Naming a
	// fallback colour here would put back the duplication this module removes.
	const token = (name: string): string | undefined => read(name).trim() || undefined;
	const background = token("--term-bg");
	const foreground = token("--term-text");
	const accent = token("--term-ready");
	const selection = accent === undefined ? undefined : withAlpha(accent, SELECTION_ALPHA);
	// Assigned one by one rather than spread so a misspelled key is a type error.
	const theme: ITheme = {};
	if (background !== undefined) theme.background = background;
	if (foreground !== undefined) theme.foreground = foreground;
	if (accent !== undefined) theme.cursor = accent;
	if (selection !== undefined) theme.selectionBackground = selection;
	return theme;
}
