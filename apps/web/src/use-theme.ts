import { useCallback, useEffect, useState } from "react";
import {
	applyTheme,
	readStoredChoice,
	resolveTheme,
	THEME_STORAGE_KEY,
	toggleChoice,
	type ResolvedTheme,
	type ThemeChoice,
} from "./lib/theme.js";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function prefersDark(): boolean {
	if (typeof window === "undefined" || !window.matchMedia) return false;
	return window.matchMedia(DARK_QUERY).matches;
}

export interface ThemeState {
	choice: ThemeChoice;
	resolved: ResolvedTheme;
	setChoice: (next: ThemeChoice) => void;
	toggle: () => void;
}

/**
 * Owns the theme preference. The stored choice is the source of truth; the
 * resolved theme is derived from it plus the OS setting, so a "跟随系统" user
 * follows the OS live without a reload.
 */
export function useTheme(): ThemeState {
	const [choice, setChoice] = useState<ThemeChoice>(() =>
		readStoredChoice(typeof window === "undefined" ? undefined : window.localStorage),
	);
	const [systemDark, setSystemDark] = useState(prefersDark);

	// Only "system" depends on the OS setting, but the listener is cheap and
	// unconditional so the state is already correct when the choice changes back.
	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const query = window.matchMedia(DARK_QUERY);
		const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
		query.addEventListener("change", onChange);
		setSystemDark(query.matches);
		return () => query.removeEventListener("change", onChange);
	}, []);

	const resolved = resolveTheme(choice, systemDark);

	useEffect(() => {
		applyTheme(resolved);
	}, [resolved]);

	const persist = useCallback((next: ThemeChoice) => {
		setChoice(next);
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch {
			// A blocked storage slot must not break the switch for this session.
		}
	}, []);

	const toggle = useCallback(() => {
		setChoice((current) => {
			const next = toggleChoice(current, prefersDark());
			try {
				window.localStorage.setItem(THEME_STORAGE_KEY, next);
			} catch {
				// See above.
			}
			return next;
		});
	}, []);

	return { choice, resolved, setChoice: persist, toggle };
}
