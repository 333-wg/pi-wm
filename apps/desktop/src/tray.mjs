export function installTray({ app, window, Tray, Menu, icon, focusWindow, isQuitting }) {
	const tray = new Tray(icon);
	try {
		tray.setToolTip("Pi-Wm");
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: "打开 Pi-Wm", click: focusWindow },
				{ type: "separator" },
				{ label: "退出", click: () => app.quit() },
			])
		);
	} catch (error) {
		tray.destroy();
		throw error;
	}
	let sessionEnding = false;
	const close = (event) => {
		// Never hide the only window unless a working tray can bring it back.
		if (isQuitting() || sessionEnding || tray.isDestroyed()) return;
		event.preventDefault();
		window.hide();
	};
	const sessionEnd = () => {
		sessionEnding = true;
		app.quit();
	};
	const dispose = () => {
		window.off("close", close);
		window.off("session-end", sessionEnd);
		window.off("closed", dispose);
		app.off("will-quit", dispose);
		if (!tray.isDestroyed()) tray.destroy();
	};
	tray.on("click", focusWindow);
	tray.on("double-click", focusWindow);
	window.on("close", close);
	// Do not intercept query-session-end: a cancelled shutdown must leave the app usable.
	window.on("session-end", sessionEnd);
	window.once("closed", dispose);
	app.once("will-quit", dispose);
	return { tray, dispose };
}
