import { Tray } from "electron";

// Capture the real native tray without exposing test hooks in the shipped app.
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
	globalThis.testTray = this;
	globalThis.testTrayMenu = menu;
	return setContextMenu.call(this, menu);
};
await import("../../src/main.mjs");
