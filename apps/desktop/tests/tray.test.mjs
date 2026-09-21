import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installTray } from "../src/tray.mjs";

function fixture({ menuFailure = false } = {}) {
	const app = new EventEmitter();
	const window = new EventEmitter();
	const state = { quitting: false, hidden: 0, focused: 0, quits: 0 };
	app.quit = () => {
		state.quits++;
	};
	window.hide = () => {
		state.hidden++;
	};
	let created;
	class Tray extends EventEmitter {
		constructor(icon) {
			super();
			this.icon = icon;
			this.destroyed = false;
			created = this;
		}
		setToolTip(value) {
			this.tooltip = value;
		}
		setContextMenu(value) {
			this.menu = value;
		}
		isDestroyed() {
			return this.destroyed;
		}
		destroy() {
			this.destroyed = true;
		}
	}
	const install = () =>
		installTray({
			app,
			window,
			Tray,
			Menu: {
				buildFromTemplate: (items) => {
					if (menuFailure) throw new Error("Menu unavailable");
					return items;
				},
			},
			icon: "icon.ico",
			focusWindow: () => {
				state.focused++;
			},
			isQuitting: () => state.quitting,
		});
	const close = () => {
		let prevented = false;
		window.emit("close", {
			preventDefault: () => {
				prevented = true;
			},
		});
		return prevented;
	};
	return {
		app,
		window,
		state,
		install,
		close,
		get tray() {
			return created;
		},
	};
}

test("window close hides to tray without quitting, including repeated closes", () => {
	const f = fixture();
	f.install();
	assert.equal(f.tray.icon, "icon.ico");
	assert.equal(f.tray.tooltip, "Pi-Wm");
	assert.equal(f.close(), true);
	assert.equal(f.close(), true);
	assert.equal(f.state.hidden, 2);
	assert.equal(f.state.quits, 0);
});

test("tray click, double click and Open restore the window; Exit requests normal cleanup", () => {
	const f = fixture();
	f.install();
	f.tray.emit("click");
	f.tray.emit("double-click");
	f.tray.menu.find((item) => item.label === "打开 Pi-Wm").click();
	assert.equal(f.state.focused, 3);
	f.tray.menu.find((item) => item.label === "退出").click();
	assert.equal(f.state.quits, 1);
});

test("explicit quit and update installation bypass close-to-tray", () => {
	const f = fixture();
	f.install();
	f.state.quitting = true;
	assert.equal(f.close(), false);
	assert.equal(f.state.hidden, 0);
});

test("shutdown query is not blocked; confirmed session end requests cleanup and permits close", () => {
	const f = fixture();
	f.install();
	f.window.emit("query-session-end", { preventDefault: () => assert.fail("Shutdown blocked") });
	assert.equal(f.state.quits, 0);
	assert.equal(f.close(), true);
	f.window.emit("session-end", {});
	assert.equal(f.state.quits, 1);
	assert.equal(f.close(), false);
});

test("tray is destroyed and listeners removed on real window destruction or app exit", () => {
	for (const target of ["window", "app"]) {
		const f = fixture();
		const controller = f.install();
		f[target].emit(target === "app" ? "will-quit" : "closed");
		assert.equal(f.tray.isDestroyed(), true);
		assert.equal(f.window.listenerCount("close"), 0);
		assert.equal(f.window.listenerCount("session-end"), 0);
		assert.equal(f.app.listenerCount("will-quit"), 0);
		controller.dispose();
	}
});

test("missing tray never leaves an inaccessible hidden app", () => {
	const f = fixture();
	f.install();
	f.tray.destroy();
	assert.equal(f.close(), false);
	assert.equal(f.state.hidden, 0);
	const failed = fixture({ menuFailure: true });
	assert.throws(failed.install, /Menu unavailable/);
	assert.equal(failed.tray.isDestroyed(), true);
	assert.equal(failed.close(), false);
});
