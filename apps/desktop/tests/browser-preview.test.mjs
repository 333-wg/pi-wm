import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserPreview, browserUrl, browserBounds, browserPartition } from "../src/browser-preview.mjs";

test("browser addresses accept real web URLs and reject privileged schemes and credentials", () => {
	assert.equal(browserUrl("localhost:3000/path?q=1"), "http://localhost:3000/path?q=1");
	assert.equal(browserUrl("[::1]:4000"), "http://[::1]:4000/");
	assert.equal(browserUrl("example.com"), "https://example.com/");
	for (const value of [
		"",
		"javascript:alert(1)",
		"file:///C:/secret",
		"wuming://app/api",
		"data:text/html,hi",
		"https://user:pass@example.com",
		null,
	])
		assert.throws(() => browserUrl(value));
	assert.match(browserPartition("workspace"), /^persist:preview-[a-f0-9]{64}$/);
	assert.equal(browserPartition("workspace"), browserPartition("workspace"));
	assert.notEqual(browserPartition("workspace"), browserPartition("other"));
});

test("native bounds account for app zoom and stay within the content area", () => {
	assert.deepEqual(browserBounds({ x: 100, y: 50, width: 300, height: 400 }, [500, 500], 2), {
		x: 200,
		y: 100,
		width: 300,
		height: 400,
	});
	assert.deepEqual(browserBounds({ x: -30, y: 700, width: -10, height: 200 }, [500, 500]), {
		x: 0,
		y: 500,
		width: 0,
		height: 0,
	});
	assert.throws(() => browserBounds({ x: NaN, y: 0, width: 2, height: 2 }, [500, 500]));
});

function fixture() {
	const created = [];
	class WebContentsView {
		constructor(options) {
			this.options = options;
			const wc = (this.webContents = new EventEmitter());
			wc.url = "";
			wc.zoom = 1;
			Object.assign(wc, {
				getURL: () => wc.url,
				getTitle: () => "",
				isLoading: () => false,
				getZoomFactor: () => wc.zoom,
				setZoomFactor: (value) => {
					wc.zoom = value;
				},
				isDestroyed: () => Boolean(wc.dead),
				loadURL: async (url) => {
					wc.url = url;
				},
				setWindowOpenHandler: (handler) => {
					wc.open = handler;
				},
				close: () => {
					wc.dead = true;
					wc.emit("destroyed");
				},
				reload() {},
				stop() {},
				openDevTools() {},
				navigationHistory: { canGoBack: () => false, canGoForward: () => false },
			});
			created.push(this);
		}
		setVisible(value) {
			this.visible = value;
		}
		setBounds(value) {
			this.bounds = value;
		}
	}
	const window = new EventEmitter();
	window.webContents = Object.assign(new EventEmitter(), {
		send() {},
		focus() {
			this.focused = true;
		},
		getZoomFactor: () => 1,
	});
	window.contentView = { addChildView() {}, removeChildView() {} };
	window.isDestroyed = () => false;
	window.getContentSize = () => [1200, 900];
	const permissions = [];
	const service = new BrowserPreview({
		window,
		WebContentsView,
		session: {
			fromPartition: () => ({
				setPermissionRequestHandler: (handler) => permissions.push(handler),
				setPermissionCheckHandler: (handler) => permissions.push(handler),
			}),
		},
		shell: { openExternal: async () => {} },
	});
	const owner = { workspaceId: "workspace", sessionId: "task" };
	const dispatch = (request) => service.dispatch({ ...owner, ...request });
	return { service, created, permissions, window, dispatch };
}

test("tabs deduplicate URLs, enforce task ownership and retain pages when hidden", async () => {
	const { service, dispatch, created, permissions } = fixture();
	const first = await dispatch({ action: "open", url: "http://localhost:3000" });
	const tabId = first.activeId;
	assert.equal((await dispatch({ action: "open", url: "http://localhost:3000" })).tabs.length, 1);
	assert.equal(created[0].options.webPreferences.nodeIntegration, false);
	assert.equal(created[0].options.webPreferences.sandbox, true);
	assert.equal(created[0].options.webPreferences.preload, undefined);
	let granted;
	permissions[0](null, "camera", (value) => {
		granted = value;
	});
	assert.equal(granted, false);
	await dispatch({ action: "bounds", tabId, bounds: { x: 500, y: 100, width: 700, height: 800 } });
	assert.equal(created[0].visible, true);
	await dispatch({ action: "hide", sessionId: "other" });
	assert.equal(created[0].visible, true);
	await assert.rejects(
		dispatch({ action: "navigate", tabId, sessionId: "other", url: "https://example.com" }),
		/belong/
	);
	await assert.rejects(dispatch({ action: "navigate", tabId, url: "wuming://app" }));
	await assert.rejects(dispatch({ action: "zoom", tabId, zoom: 10 }));
	await dispatch({ action: "hide" });
	assert.equal(created[0].visible, false);
	assert.equal(service.tabs.size, 1);
	await dispatch({ action: "close", tabId });
	assert.equal(service.tabs.size, 0);
	assert.equal(created[0].webContents.dead, true);
});

test("native page shortcuts target the preview, not the workbench window", async () => {
	const { dispatch, created, window, service } = fixture();
	await dispatch({ action: "open", url: "http://localhost:3000" });
	let prevented = 0;
	const event = {
		preventDefault() {
			prevented++;
		},
	};
	created[0].webContents.emit("before-input-event", event, { type: "keyDown", key: "l", control: true });
	assert.equal(window.webContents.focused, true);
	created[0].webContents.emit("before-input-event", event, { type: "keyDown", key: "w", control: true });
	assert.equal(prevented, 2);
	assert.equal(service.tabs.size, 0);
	assert.equal(created[0].webContents.dead, true);
});

test("popup pages stay with their owner and cannot grant privileged renderer options", async () => {
	const { dispatch, created, service } = fixture();
	await dispatch({ action: "open", url: "http://localhost:3000" });
	const opener = created[0].webContents;
	assert.equal(opener.open({ url: "file:///secret" }).action, "deny");
	const popup = opener.open({ url: "http://localhost:3000/login" });
	assert.equal(popup.action, "deny");
	await new Promise(setImmediate);
	assert.equal(created[1].options.webPreferences.nodeIntegration, false);
	assert.equal(created[1].options.webPreferences.preload, undefined);
	assert.equal(created[1].options.webPreferences.partition, created[0].options.webPreferences.partition);
	assert.equal((await dispatch({ action: "state" })).tabs.length, 2);
	opener.emit(
		"will-navigate",
		{
			preventDefault: () => {
				opener.blocked = true;
			},
		},
		"wuming://app"
	);
	assert.equal(opener.blocked, true);
	service.dispose();
	assert.equal(service.tabs.size, 0);
});
