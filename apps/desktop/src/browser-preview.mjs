import { createHash, randomUUID } from "node:crypto";

const ZOOM_FACTORS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function browserUrl(value) {
	if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid browser address");
	const text = value.trim();
	const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?=[:/?#]|$)/i.test(text);
	const hostPort = /^[^\s/:?#]+\.[^\s/:?#]+:\d+(?=[/?#]|$)/u.test(text);
	const url = new URL(
		local ? "http://" + text : !hostPort && /^[a-z][a-z\d+.-]*:/i.test(text) ? text : "https://" + text
	);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new Error("Only HTTP(S) addresses without credentials are allowed");
	return url.href;
}

export function browserPartition(workspaceId) {
	return "persist:preview-" + createHash("sha256").update(workspaceId).digest("hex");
}

function identity(value) {
	if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid browser owner");
	return value;
}

function currentTabUrl(tab) {
	if (tab.navigation?.pending) return tab.navigation.url;
	const url = tab.view.webContents.getURL();
	return url && url !== "about:blank" ? url : tab.url;
}

export function browserBounds(value, size, zoom = 1) {
	if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite))
		throw new Error("Invalid browser bounds");
	const x = Math.max(0, Math.min(size[0], Math.round(value.x * zoom)));
	const y = Math.max(0, Math.min(size[1], Math.round(value.y * zoom)));
	return {
		x,
		y,
		width: Math.max(0, Math.min(size[0] - x, Math.round(value.width * zoom))),
		height: Math.max(0, Math.min(size[1] - y, Math.round(value.height * zoom))),
	};
}

// Preview pages never inherit the workbench preload, session, or credentials.
export class BrowserPreview {
	constructor({ window, WebContentsView, session, shell, contextMenu = () => {} }) {
		Object.assign(this, { window, WebContentsView, session, shell, contextMenu });
		this.tabs = new Map();
		this.groups = new Map();
		this.partitions = new Set();
		this.visible = undefined;
		this.revision = 0;
		window.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
			if (mainFrame) this.hide();
		});
		window.on("resize", () => this.hide());
		window.on("closed", () => this.dispose());
	}

	group(workspaceId, sessionId) {
		const key = JSON.stringify([identity(workspaceId), identity(sessionId)]);
		if (!this.groups.has(key)) this.groups.set(key, { key, workspaceId, sessionId, activeId: undefined });
		return this.groups.get(key);
	}

	snapshot(group) {
		return {
			workspaceId: group.workspaceId,
			sessionId: group.sessionId,
			revision: ++this.revision,
			activeId: group.activeId,
			tabs: [...this.tabs.values()]
				.filter((tab) => tab.group === group)
				.map((tab) => {
					const wc = tab.view.webContents;
					return {
						id: tab.id,
						url: currentTabUrl(tab),
						title: wc.getTitle(),
						loading: wc.isLoading(),
						error: tab.error,
						canGoBack: wc.navigationHistory.canGoBack(),
						canGoForward: wc.navigationHistory.canGoForward(),
						zoom: wc.getZoomFactor(),
					};
				}),
		};
	}

	emit(group) {
		if (!this.window.isDestroyed()) this.window.webContents.send("desktop:browser-state", this.snapshot(group));
	}

	create(group, url) {
		if (this.tabs.size >= 24) throw new Error("Close a browser tab before opening another (24 tab limit)");
		const partition = browserPartition(group.workspaceId);
		if (!this.partitions.has(partition)) {
			const storage = this.session.fromPartition(partition);
			storage.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
			storage.setPermissionCheckHandler(() => false);
			this.partitions.add(partition);
		}
		const view = new this.WebContentsView({
			webPreferences: {
				partition,
				nodeIntegration: false,
				nodeIntegrationInSubFrames: false,
				nodeIntegrationInWorker: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
				allowRunningInsecureContent: false,
				webviewTag: false,
				navigateOnDragDrop: false,
			},
		});
		const tab = { id: randomUUID(), group, view, url, error: undefined, navigation: undefined };
		this.tabs.set(tab.id, tab);
		group.activeId = tab.id;
		view.setVisible(false);
		this.window.contentView.addChildView(view);
		const wc = view.webContents;
		this.contextMenu(wc);
		const update = () => this.emit(group);
		wc.on("page-title-updated", update);
		wc.on("did-navigate-in-page", (_event, target, mainFrame) => {
			if (!mainFrame) return;
			tab.url = target;
			// An old document may change its route while another destination is still pending.
			if (tab.navigation?.committed) tab.navigation.url = target;
			update();
		});
		wc.on("did-start-navigation", (_event, target, inPlace, mainFrame) => {
			if (!mainFrame || inPlace) return;
			if (!tab.navigation || tab.navigation.started || tab.navigation.url !== target)
				tab.navigation = { url: target, cancelled: false, pending: true, committed: false };
			tab.navigation.started = true;
			tab.url = target;
			tab.error = undefined;
			update();
		});
		for (const name of ["did-redirect-navigation", "did-navigate"])
			wc.on(name, (_event, target, _inPlace, mainFrame) => {
				if (name === "did-redirect-navigation" && !mainFrame) return;
				if (tab.navigation) {
					tab.navigation.url = target;
					if (name === "did-navigate") tab.navigation.committed = true;
				}
				tab.url = target;
				update();
			});
		wc.on("did-stop-loading", () => {
			if (tab.navigation) tab.navigation.pending = false;
			update();
		});
		wc.on("did-start-loading", () => {
			tab.error = undefined;
			update();
		});
		wc.on("did-fail-load", (_event, code, description, target, mainFrame) => {
			if (mainFrame && code !== -3 && !tab.navigation?.cancelled && target === tab.navigation?.url) {
				tab.error = description;
				update();
			}
		});
		wc.on("render-process-gone", () => {
			tab.error = "Page process stopped. Reload to retry.";
			update();
		});
		for (const name of ["will-navigate", "will-redirect"])
			wc.on(name, (event, target) => {
				try {
					browserUrl(target);
				} catch {
					event.preventDefault();
				}
			});
		wc.on("will-attach-webview", (event) => event.preventDefault());
		wc.on("zoom-changed", (_event, direction) => this.stepZoom(tab, direction));
		wc.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown") return;
			const key = input.key.toLowerCase();
			if ((input.control || input.meta) && !input.alt && ["+", "=", "-", "_", "0"].includes(key)) {
				event.preventDefault();
				if (key === "0") this.setZoom(tab, 1);
				else this.stepZoom(tab, key === "-" || key === "_" ? "out" : "in");
			} else if ((input.control || input.meta) && ["l", "r", "w"].includes(key)) {
				event.preventDefault();
				if (key === "l") {
					this.window.webContents.focus();
					this.window.webContents.send("desktop:browser-focus", {
						workspaceId: group.workspaceId,
						sessionId: group.sessionId,
					});
				} else if (key === "r") wc.reload();
				else this.remove(tab);
			} else if (input.alt && ["arrowleft", "arrowright"].includes(key)) {
				event.preventDefault();
				if (key === "arrowleft" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
				if (key === "arrowright" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
			}
		});
		wc.setWindowOpenHandler(({ url: target }) => {
			try {
				target = browserUrl(target);
			} catch {
				return { action: "deny" };
			}
			if (this.tabs.size >= 24) return { action: "deny" };
			// Route popups into the originating task, not whichever task is now in front.
			setImmediate(() => {
				if (!this.tabs.has(tab.id) || this.tabs.size >= 24 || this.window.isDestroyed()) return;
				const popup = this.create(group, target);
				this.load(popup, target);
				this.emit(group);
			});
			return { action: "deny" };
		});
		wc.on("destroyed", () => this.remove(tab, false));
		return tab;
	}

	setZoom(tab, zoom) {
		if (!Number.isFinite(zoom) || zoom < 0.5 || zoom > 2) throw new Error("Invalid zoom");
		tab.view.webContents.setZoomFactor(zoom);
		// Chromium shares origin zoom across live tabs in the same partition.
		for (const group of this.groups.values()) this.emit(group);
	}

	stepZoom(tab, direction) {
		const current = tab.view.webContents.getZoomFactor();
		const next =
			direction === "in"
				? (ZOOM_FACTORS.find((zoom) => zoom > current + 0.001) ?? 2)
				: (ZOOM_FACTORS.findLast((zoom) => zoom < current - 0.001) ?? 0.5);
		this.setZoom(tab, next);
	}

	remove(tab, destroy = true) {
		if (!this.tabs.delete(tab.id)) return;
		if (this.visible?.id === tab.id) {
			tab.view.setVisible(false);
			this.hide();
		}
		if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
		if (tab.group.activeId === tab.id)
			tab.group.activeId = [...this.tabs.values()].filter((entry) => entry.group === tab.group).at(-1)?.id;
		if (destroy && !tab.view.webContents.isDestroyed()) tab.view.webContents.close();
		this.emit(tab.group);
	}

	hide() {
		for (const tab of this.tabs.values()) tab.view.setVisible(false);
		this.visible = undefined;
	}

	dispose() {
		for (const tab of this.tabs.values()) this.remove(tab);
		this.groups.clear();
	}

	async dispatch(request) {
		if (!request || typeof request !== "object") throw new Error("Invalid browser request");
		const group = this.group(request.workspaceId, request.sessionId);
		const { action } = request;
		if (action === "state") return this.snapshot(group);
		if (action === "open") {
			const url = request.url ? browserUrl(request.url) : "";
			let tab = url && [...this.tabs.values()].find((entry) => entry.group === group && currentTabUrl(entry) === url);
			if (!tab) {
				tab = this.create(group, url);
				if (url) this.load(tab, url);
			}
			group.activeId = tab.id;
			this.emit(group);
			return this.snapshot(group);
		}
		if (action === "hide") {
			if (this.visible?.group === group) this.hide();
			return this.snapshot(group);
		}
		const tab = this.tabs.get(request.tabId);
		if (!tab || tab.group !== group) throw new Error("Browser tab does not belong to this task");
		const wc = tab.view.webContents;
		switch (action) {
			case "activate":
				group.activeId = tab.id;
				break;
			case "close":
				this.remove(tab);
				break;
			case "navigate":
				this.load(tab, browserUrl(request.url));
				break;
			case "back":
				if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
				break;
			case "forward":
				if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
				break;
			case "reload":
				if (wc.getURL()) wc.reload();
				else if (tab.url) this.load(tab, tab.url);
				break;
			case "stop":
				if (tab.navigation) {
					tab.navigation.cancelled = true;
					tab.navigation.pending = false;
				}
				wc.stop();
				tab.url = wc.getURL() === "about:blank" ? "" : wc.getURL();
				tab.error = undefined;
				break;
			case "zoom":
				this.setZoom(tab, request.zoom);
				return this.snapshot(group);
			case "devtools":
				wc.openDevTools({ mode: "detach" });
				break;
			case "external":
				await this.shell.openExternal(browserUrl(wc.getURL() || tab.url));
				break;
			case "bounds": {
				if (group.activeId !== tab.id) return this.snapshot(group);
				const bounds = browserBounds(
					request.bounds,
					this.window.getContentSize(),
					this.window.webContents.getZoomFactor()
				);
				this.hide();
				if (bounds.width && bounds.height && !tab.error && tab.url !== "") {
					tab.view.setBounds(bounds);
					tab.view.setVisible(true);
					this.visible = tab;
				}
				return this.snapshot(group);
			}
			default:
				throw new Error("Unknown browser action");
		}
		this.emit(group);
		return this.snapshot(group);
	}

	load(tab, url) {
		tab.url = url;
		tab.error = undefined;
		const navigation = { url, started: false, cancelled: false, pending: true, committed: false };
		tab.navigation = navigation;
		void tab.view.webContents.loadURL(url).catch((error) => {
			if (
				this.tabs.has(tab.id) &&
				tab.navigation === navigation &&
				!navigation.cancelled &&
				error.code !== "ERR_ABORTED"
			) {
				navigation.pending = false;
				tab.error = error.message;
				this.emit(tab.group);
			}
		});
	}
}
