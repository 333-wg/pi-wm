import { Ellipsis } from "lucide-react";
import { useEffect } from "react";
import { paletteMode } from "../lib/theme.js";
import clover from "../assets/wuming-clover.png";
import "./desktop-titlebar.css";

export function DesktopTitlebar() {
	useEffect(() => {
		const root = document.documentElement;
		const syncTheme = () => {
			const theme = paletteMode(root.dataset.theme ?? "light");
			void window.wumingDesktop?.setWindowTheme?.(theme).catch(console.error);
		};
		syncTheme();
		const observer = new MutationObserver(syncTheme);
		observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);

	return (
		<header className="desktop-titlebar" aria-label="Pi-Wm">
			<div className="desktop-titlebar-brand">
				<img src={clover} alt="" width={18} height={18} />
				<span>Pi-Wm</span>
			</div>
			<button
				type="button"
				className="desktop-titlebar-menu"
				aria-label="应用菜单"
				title="应用菜单"
				aria-haspopup="menu"
				onClick={() => void window.wumingDesktop?.openMenu?.().catch(console.error)}
			>
				<Ellipsis size={18} />
			</button>
		</header>
	);
}
