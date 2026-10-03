import { Check } from "lucide-react";
import type { CSSProperties } from "react";
import { PALETTES, themeLabel } from "../lib/theme.js";
import type { ThemeState } from "../use-theme.js";
import "./theme-settings.css";
import { WallpaperSettings } from "./WallpaperSettings.js";
import type { WallpaperState } from "../use-wallpaper.js";

export function ThemeSettings({
	theme,
	locale,
	wallpaper,
}: {
	theme: ThemeState;
	locale: "zh" | "en";
	wallpaper: WallpaperState;
}) {
	return (
		<section className="theme-settings" aria-label={locale === "zh" ? "外观" : "Appearance"}>
			<div className="theme-setting">
				<span className="settings-section-title">{locale === "zh" ? "外观" : "Appearance"}</span>
				<div className="segmented" role="group" aria-label={locale === "zh" ? "主题" : "Theme"}>
					{(["system", "light", "dark"] as const).map((choice) => (
						<button
							key={choice}
							type="button"
							className={theme.choice === choice ? "active" : ""}
							aria-pressed={theme.choice === choice}
							onClick={() => theme.setChoice(choice)}
						>
							{themeLabel(choice, locale)}
						</button>
					))}
				</div>
			</div>
			{wallpaper.settings.kind !== "none" && (
				<p className="wallpaper-help">
					{locale === "zh"
						? "壁纸主题已启用：配色随背景协调，明暗模式仍可切换。关闭壁纸将恢复已保存的经典配色。"
						: "Wallpaper colours are coordinated automatically. Switch light/dark above; turning off wallpaper restores your saved classic palettes."}
				</p>
			)}
			{wallpaper.settings.kind === "none" &&
				(["light", "dark"] as const).map((mode) => (
					<fieldset className="theme-palette-group" key={mode}>
						<legend>
							{locale === "zh"
								? mode === "light"
									? "浅色配色"
									: "深色配色"
								: mode === "light"
									? "Light palette"
									: "Dark palette"}
						</legend>
						<div className="theme-palette-grid">
							{PALETTES.filter((entry) => entry.mode === mode).map((entry) => (
								<button
									key={entry.id}
									type="button"
									className="theme-palette"
									aria-pressed={theme.palettes[mode] === entry.id}
									title={entry[locale]}
									onClick={() => theme.setPalette(entry.id)}
								>
									<span
										className="theme-swatch"
										aria-hidden="true"
										style={{ "--swatch-bg": entry.background, "--swatch-accent": entry.accent } as CSSProperties}
									>
										<span />
										{theme.palettes[mode] === entry.id && <Check size={14} />}
									</span>
									<span>{entry[locale]}</span>
								</button>
							))}
						</div>
					</fieldset>
				))}
			<WallpaperSettings wallpaper={wallpaper} locale={locale} />
		</section>
	);
}
