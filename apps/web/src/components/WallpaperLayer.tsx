import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { wallpaperStyle } from "../lib/wallpaper.js";
import type { WallpaperState } from "../use-wallpaper.js";
import type { ResolvedTheme } from "../lib/theme.js";
import { wallpaperPalette } from "../lib/wallpaper-palette.js";

export function WallpaperLayer({ wallpaper, mode }: { wallpaper: WallpaperState; mode: ResolvedTheme }) {
	const [visible, setVisible] = useState(() => !document.hidden);
	useEffect(() => {
		const changed = () => setVisible(!document.hidden);
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	}, []);
	const enabled =
		wallpaper.settings.kind !== "none" && (wallpaper.settings.kind !== "image" || Boolean(wallpaper.imageUrl));
	useLayoutEffect(() => {
		const root = document.documentElement;
		const styles = {
			...wallpaperStyle(wallpaper.settings, wallpaper.imageUrl),
			...(enabled ? wallpaperPalette(wallpaper.accent, mode) : {}),
		};
		root.dataset.wallpaper = String(enabled);
		for (const [key, value] of Object.entries(styles)) root.style.setProperty(key, String(value));
		return () => {
			delete root.dataset.wallpaper;
			for (const key of Object.keys(styles)) root.style.removeProperty(key);
		};
	}, [enabled, wallpaper.settings, wallpaper.imageUrl, wallpaper.accent, mode]);
	if (!enabled) return null;
	// Outside desktop-content's paint containment: one image also spans the titlebar.
	return createPortal(
		<div className="wallpaper-layer" aria-hidden="true">
			<div
				className="wallpaper-art"
				data-moving={visible && wallpaper.settings.motion && wallpaper.settings.kind !== "image"}
			/>
			<div className="wallpaper-veil" />
		</div>,
		document.body
	);
}
