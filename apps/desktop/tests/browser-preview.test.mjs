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
		"javascript:123",
		"file:123",
		"wuming:3000",
		"https://example.com:99999",
		"https://user:pass@example.com",
		null,
	])
		assert.throws(() => browserUrl(value));
	assert.match(browserPartition("workspace"), /^persist:preview-[a-f0-9]{64}$/);
	assert.equal(browserPartition("workspace"), browserPartition("workspace"));
	assert.notEqual(browserPartition("workspace"), browserPartition("other"));
});

test("address shorthand distinguishes host ports and loopback from URL schemes", () => {
	for (const [input, expected] of [
		["example.com:8080", "https://example.com:8080/"],
		["example.com:8443/path?q=1#section", "https://example.com:8443/path?q=1#section"],
		["localhost?x=1", "http://localhost/?x=1"],
		["localhost#section", "http://localhost/#section"],
		["127.0.0.2:3000", "http://127.0.0.2:3000/"],
		["127.2.3.4/path", "http://127.2.3.4/path"],
		["[::1]?x=1", "http://[::1]/?x=1"],
		[" https://localhost:3000 ", "https://localhost:3000/"],
	])
		assert.equal(browserUrl(input), expected, input);
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
					wc.emit("did-start-navigation", {}, url, false, true);
					wc.url = url;
					wc.emit("did-navigate", {}, url, 200, "OK");
					wc.emit("did-stop-loading");
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
	const sent = [];
	window.webContents = Object.assign(new EventEmitter(), {
		send(channel, value) {
			sent.push({ channel, value });
		},
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
	return { service, created, permissions, window, dispatch, sent };
}

function deferNavigation(wc) {
	const pending = [];
	wc.loadURL = (url) => {
		wc.emit("did-start-navigation", {}, url, false, true);
		return new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
	};
	return pending;
}

test("main-frame SPA routes update the address while subresources are still loading", async () => {
	const { dispatch, created, sent } = fixture();
	const { activeId: tabId } = await dispatch({ action: "open" });
	const wc = created[0].webContents;
	const pending = deferNavigation(wc);
	wc.isLoading = () => true;
	await dispatch({ action: "navigate", tabId, url: "http://localhost/spa" });
	wc.url = "http://localhost/spa";
	wc.emit("did-navigate", {}, wc.url, 200, "OK");
	for (const target of ["http://localhost/route", "http://localhost/replaced", "http://localhost/replaced#section"]) {
		wc.url = target;
		wc.emit("did-navigate-in-page", {}, target, true);
		const state = (await dispatch({ action: "state" })).tabs[0];
		assert.equal(state.url, target);
		assert.equal(state.loading, true);
		assert.equal(sent.at(-1).value.tabs[0].url, target);
	}
	const updates = sent.length;
	wc.emit("did-navigate-in-page", {}, "http://localhost/child-frame", false);
	assert.equal(sent.length, updates);
	assert.equal((await dispatch({ action: "state" })).tabs[0].url, wc.url);
	wc.isLoading = () => false;
	wc.emit("did-stop-loading");
	pending[0].resolve();
	assert.equal((await dispatch({ action: "state" })).tabs[0].url, wc.url);
});

test("the old document's SPA navigation cannot replace an uncommitted destination", async () => {
	const { dispatch, created } = fixture();
	const { activeId: tabId } = await dispatch({ action: "open", url: "http://localhost/first" });
	const wc = created[0].webContents;
	const pending = deferNavigation(wc);
	await dispatch({ action: "navigate", tabId, url: "http://localhost/slow" });
	wc.url = "http://localhost/first#section";
	wc.emit("did-navigate-in-page", {}, wc.url, true);
	assert.equal((await dispatch({ action: "state" })).tabs[0].url, "http://localhost/slow");
	await dispatch({ action: "stop", tabId });
	pending[0].reject(Object.assign(new Error("Cancelled"), { code: "ERR_FAILED" }));
	await new Promise(setImmediate);
	const stopped = (await dispatch({ action: "state" })).tabs[0];
	assert.equal(stopped.url, wc.url);
	assert.equal(stopped.error, undefined);
	const reopened = await dispatch({ action: "open", url: "http://localhost/slow" });
	assert.notEqual(reopened.activeId, tabId);
	assert.equal(reopened.tabs.length, 2);
});

test("opening a pending destination reuses its task's tab without restarting navigation", async () => {
	const { dispatch, created } = fixture();
	const { activeId: tabId } = await dispatch({ action: "open", url: "http://localhost/first" });
	const pending = deferNavigation(created[0].webContents);
	await dispatch({ action: "navigate", tabId, url: "http://localhost/slow" });
	const reopened = await dispatch({ action: "open", url: "localhost/slow" });
	assert.equal(reopened.activeId, tabId);
	assert.equal(reopened.tabs.length, 1);
	assert.equal(created.length, 1);
	assert.equal(pending.length, 1);
	const oldAddress = await dispatch({ action: "open", url: "http://localhost/first" });
	assert.notEqual(oldAddress.activeId, tabId);
	assert.equal(oldAddress.tabs.length, 2);
	pending[0].resolve();
});

test("redirected pending destinations deduplicate without crossing task or workspace boundaries", async () => {
	const { dispatch, created } = fixture();
	const { activeId: tabId } = await dispatch({ action: "open", url: "http://localhost/first" });
	const wc = created[0].webContents;
	const pending = deferNavigation(wc);
	await dispatch({ action: "navigate", tabId, url: "http://localhost/redirect" });
	const url = "http://localhost/destination";
	wc.emit("did-redirect-navigation", {}, url, false, true);
	const reopened = await dispatch({ action: "open", url });
	assert.equal(reopened.activeId, tabId);
	assert.equal(reopened.tabs[0].url, url);
	assert.equal(reopened.tabs.length, 1);
	assert.notEqual((await dispatch({ action: "open", url, sessionId: "other" })).activeId, tabId);
	assert.notEqual((await dispatch({ action: "open", url, workspaceId: "other" })).activeId, tabId);
	assert.equal(created.length, 3);
	pending[0].resolve();
});

test("stopping a pending navigation preserves the committed page and ignores cancellation failures", async () => {
	const { dispatch, created } = fixture();
	const { activeId: tabId } = await dispatch({ action: "open", url: "http://localhost/first" });
	const wc = created[0].webContents;
	const pending = deferNavigation(wc);
	await dispatch({ action: "navigate", tabId, url: "http://localhost/slow" });
	assert.equal((await dispatch({ action: "state" })).tabs[0].url, "http://localhost/slow");
	await dispatch({ action: "stop", tabId });
	wc.emit("did-fail-load", {}, -2, "ERR_FAILED", pending[0].url, true);
	pending[0].reject(Object.assign(new Error("ERR_FAILED"), { code: "ERR_FAILED" }));
	await new Promise(setImmediate);
	const state = await dispatch({ action: "state" });
	assert.equal(state.tabs[0].error, undefined);
	assert.equal(state.tabs[0].url, "http://localhost/first");
	await dispatch({ action: "bounds", tabId, bounds: { x: 0, y: 0, width: 400, height: 400 } });
	assert.equal(created[0].visible, true);
	await dispatch({ action: "navigate", tabId, url: "http://localhost/real-failure" });
	pending[1].reject(Object.assign(new Error("Connection refused"), { code: "ERR_FAILED" }));
	await new Promise(setImmediate);
	assert.equal((await dispatch({ action: "state" })).tabs[0].error, "Connection refused");
});

test("stopping the first navigation restores the blank tab", async () => {
	const { dispatch, created } = fixture();
	const { activeId: tabId } = await dispatch({ action: "open" });
	const pending = deferNavigation(created[0].webContents);
	await dispatch({ action: "navigate", tabId, url: "http://localhost/slow" });
	await dispatch({ action: "stop", tabId });
	pending[0].reject(Object.assign(new Error("ERR_FAILED"), { code: "ERR_FAILED" }));
	await new Promise(setImmediate);
	assert.equal((await dispatch({ action: "state" })).tabs[0].url, "");
	assert.equal((await dispatch({ action: "state" })).tabs[0].error, undefined);
});

test("late failures cannot overwrite newer navigation and redirect errors remain visible", async () => {
	const { dispatch, created } = fixture();
	const { activeId: tabId } = await dispatch({ action: "open" });
	const wc = created[0].webContents;
	const pending = deferNavigation(wc);
	await dispatch({ action: "navigate", tabId, url: "http://localhost/old" });
	await dispatch({ action: "navigate", tabId, url: "http://localhost/new" });
	wc.emit("did-fail-load", {}, -2, "Old failure", pending[0].url, true);
	pending[0].reject(Object.assign(new Error("Old failure"), { code: "ERR_FAILED" }));
	await new Promise(setImmediate);
	assert.equal((await dispatch({ action: "state" })).tabs[0].error, undefined);
	wc.emit("did-redirect-navigation", {}, "http://localhost/redirected", false, true);
	wc.emit("did-fail-load", {}, -105, "DNS failure", "http://localhost/redirected", true);
	assert.equal((await dispatch({ action: "state" })).tabs[0].error, "DNS failure");
	pending[1].resolve();
});

test("native zoom shortcuts and wheel requests use bounded factors and broadcast shared state", async () => {
	const { dispatch, created, sent } = fixture();
	await dispatch({ action: "open", url: "http://localhost/first" });
	await dispatch({ action: "open", sessionId: "other", url: "http://localhost/second" });
	const wc = created[0].webContents;
	let prevented = 0;
	const key = (value) =>
		wc.emit(
			"before-input-event",
			{
				preventDefault() {
					prevented++;
				},
			},
			{
				type: "keyDown",
				key: value,
				control: true,
			}
		);
	sent.length = 0;
	key("+");
	assert.equal(wc.zoom, 1.25);
	assert.deepEqual(
		sent.map(({ value }) => value.sessionId),
		["task", "other"]
	);
	key("-");
	assert.equal(wc.zoom, 1);
	key("=");
	key("0");
	assert.equal(wc.zoom, 1);
	assert.equal(prevented, 4);
	for (let i = 0; i < 10; i++) wc.emit("zoom-changed", {}, "in");
	assert.equal(wc.zoom, 2);
	for (let i = 0; i < 10; i++) wc.emit("zoom-changed", {}, "out");
	assert.equal(wc.zoom, 0.5);
});

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
