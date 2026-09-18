import { app, BrowserWindow, WebContentsView, session, dialog, globalShortcut, ipcMain, Menu, Notification, protocol, shell } from "electron";
import { appendFileSync, mkdirSync, renameSync, statSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayHost } from "./gateway-host.mjs";
import { APP_URL, createAppProtocol, isAppUrl } from "./app-protocol.mjs";
import electronUpdater from "electron-updater";
import { DesktopUpdates, readUpdatePreferences, saveUpdatePreferences } from "./updates.mjs";
import { installDesktopUpdate } from "./install-update.mjs";
import { TaskNotifications } from "./notifications.mjs";
import { BrowserPreview } from "./browser-preview.mjs";

protocol.registerSchemesAsPrivileged([
	{
		scheme: "wuming",
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
	},
]);
app.setName("Pi-Wm");
const profileOverride = app.commandLine.getSwitchValue("user-data-dir");
if (profileOverride && !isAbsolute(profileOverride)) throw new Error("--user-data-dir must be absolute");
// Keep existing profiles and the single-instance lock compatible with the previous product name.
app.setPath("userData", profileOverride || join(app.getPath("appData"), "Wuming"));

let window;
let host;
let quitting = false;
let allowQuit = false;
let bootPromise;
let failureDialog = false;
let connection;
let updates;
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");
const runtimeRoot = app.isPackaged ? join(process.resourcesPath, "runtime") : repositoryRoot;
const manifest = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));

function focusWindow() {
	if (!window || window.isDestroyed()) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

function openExternal(value) {
	try {
		const url = new URL(value);
		if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) void shell.openExternal(url.href);
	} catch {
		/* Unknown protocols must not reach the operating system. */
	}
}

async function fail(error) {
	if (quitting || failureDialog) return;
	failureDialog = true;
	const { response } = await dialog.showMessageBox({
		type: "error",
		title: "Pi-Wm",
		message: "The local service could not run.",
		detail: `${error.message}\nLogs: ${join(app.getPath("userData"), "logs", "gateway.log")}`,
		buttons: ["Restart Pi-Wm", "Quit"],
		defaultId: 0,
		cancelId: 1,
	});
	if (response === 0) app.relaunch();
	app.quit();
}

async function boot() {
	const profile = app.getPath("userData");
	const dataDirectory = join(profile, "data");
	const workspace = join(profile, "workspace");
	const logs = join(profile, "logs");
	for (const path of [dataDirectory, workspace, logs]) mkdirSync(path, { recursive: true });
	const logPath = join(logs, "gateway.log");
	const log = (text) => {
		try {
			if (existsSync(logPath) && statSync(logPath).size > 2 * 1024 * 1024) renameSync(logPath, `${logPath}.previous`);
			appendFileSync(logPath, text);
		} catch {
			/* Logging must not terminate a user's task. */
		}
	};
	host = new GatewayHost({
		nodeExecutable: app.isPackaged ? join(runtimeRoot, "node.exe") : process.env.WUMING_DESKTOP_NODE,
		entry: join(runtimeRoot, "apps", "gateway", "dist", "main.js"),
		dataDirectory,
		workspace,
		log,
		...(app.isPackaged ? { browserDirectory: join(runtimeRoot, "browsers") } : {}),
		...(!app.isPackaged && process.env.WUMING_DESKTOP_TEST_RUNTIME === "demo" ? { runtime: "demo" } : {}),
		pickProject: async (kind) => {
			const options = { title: "Open project", properties: [kind === "file" ? "openFile" : "openDirectory"] };
			const selected = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
			if (selected.canceled || !selected.filePaths[0]) return undefined;
			return { path: selected.filePaths[0], kind: kind === "file" ? "file" : "directory" };
		},
	});
	host.on("failure", (error) => void fail(error));
	if (!host.options.nodeExecutable) throw new Error("Start development with npm run desktop");
	connection = await host.start();
	if (quitting) return;
	const stopShortcut = globalShortcut.register("CommandOrControl+Alt+F12", () => {
		void fetch(`${connection.baseUrl}/api/computer-use/stop`, {
			method: "POST", headers: { Authorization: `Bearer ${connection.token}` },
			signal: AbortSignal.timeout(3000),
		}).then((response) => { if (!response.ok) log(`Computer Use stop failed: ${response.status}\n`); })
			.catch((error) => log(`Computer Use stop failed: ${error.message}\n`));
	});
	if (!stopShortcut) log("Computer Use: Ctrl+Alt+F12 could not be registered; use the stop button.\n");
	protocol.handle("wuming", await createAppProtocol({ webRoot: join(runtimeRoot, "apps", "web", "dist"), connection }));
	ipcMain.handle("desktop:connect", (event) => {
		if (
			!window ||
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			!isAppUrl(event.senderFrame.url)
		)
			throw new Error("Forbidden");
		return { token: connection.token, websocketUrl: connection.websocketUrl };
	});
	window = new BrowserWindow({
		width: 1360,
		height: 900,
		minWidth: 800,
		minHeight: 600,
		show: false,
		title: "Pi-Wm",
		icon: join(here, "../resources", process.platform === "win32" ? "icon.ico" : "icon.png"),
		...(process.platform === "win32"
			? {
					titleBarStyle: "hidden",
					titleBarOverlay: { color: "#f7f8f6", symbolColor: "#202522", height: 36 },
					autoHideMenuBar: true,
				}
			: {}),
		backgroundColor: "#f7f8f6",
		webPreferences: {
			preload: join(here, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			webviewTag: false,
			spellcheck: false,
		},
	});
	const browserPreview = new BrowserPreview({ window, WebContentsView, session, shell });
	ipcMain.handle("desktop:browser", (event, request) => {
		if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url))
			throw new Error("Forbidden");
		return browserPreview.dispatch(request);
	});
	const preferencesPath = join(profile, "desktop-updates.json");
	const repository = manifest.desktopUpdateRepository;
	const disabledReason = !app.isPackaged
		? "development"
		: process.platform !== "win32"
			? "platform"
			: !repository || !existsSync(join(process.resourcesPath, "app-update.yml"))
				? "unconfigured"
				: undefined;
	const updater = disabledReason ? undefined : electronUpdater.autoUpdater;
	updates = new DesktopUpdates({
		updater,
		createCancellationToken: () => new electronUpdater.CancellationToken(),
		version: app.isPackaged ? app.getVersion() : manifest.version,
		platform: process.platform,
		arch: process.arch,
		disabledReason,
		repository,
		preferences: await readUpdatePreferences(preferencesPath),
		savePreferences: (value) => saveUpdatePreferences(preferencesPath, value),
	});
	updates.on("state", (state) => {
		if (window && !window.isDestroyed()) window.webContents.send("desktop:update-state", state);
	});
	ipcMain.handle("desktop:updates", async (event, action, value) => {
		if (
			!window ||
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			!isAppUrl(event.senderFrame.url)
		)
			throw new Error("Forbidden");
		if (action === "activity") {
			try {
				updates.patch({
					busy: (await host.updateStatus()).busy,
					activityUnknown: false,
					...(updates.state.error === "service" || updates.state.error === "busy" ? { error: undefined } : {}),
				});
			} catch {
				updates.patch({ busy: true, activityUnknown: true });
			}
			return updates.snapshot();
		}
		if (action === "restart") {
			if (updates.state.error !== "install") throw new Error("Restart is only available after an install failure");
			app.relaunch();
			app.quit();
			return updates.snapshot();
		}
		if (action === "install")
			return installDesktopUpdate({
				updates,
				host,
				confirm: async () =>
					(
						await dialog.showMessageBox(window, {
							type: "question",
							title: "Pi-Wm",
							message: "重启并安装更新？",
							detail: "Pi-Wm 将关闭本地服务和预览服务并重新启动。请先保存外部编辑器中未保存的文件。",
							buttons: ["稍后", "重启并安装"],
							defaultId: 0,
							cancelId: 0,
						})
					).response === 1,
				install: (silent, forceRunAfter) => {
					quitting = true;
					allowQuit = true;
					updater.quitAndInstall(silent, forceRunAfter);
				},
			});
		return updates.dispatch(action, value);
	});
	ipcMain.handle("desktop:window-chrome", (event, action, value) => {
		if (
			!window ||
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			!isAppUrl(event.senderFrame.url) ||
			process.platform !== "win32"
		)
			throw new Error("Forbidden");
		if (action === "menu") Menu.getApplicationMenu()?.popup({ window, x: 8, y: 36 });
		else if (action === "theme" && (value === "light" || value === "dark"))
			window.setTitleBarOverlay({
				color: value === "dark" ? "#0e120f" : "#f7f8f6",
				symbolColor: value === "dark" ? "#dbe3dc" : "#202522",
			});
		else throw new Error("Invalid window action");
	});
	const notifications = new TaskNotifications({
		Notification,
		foreground: () => !window || window.isDestroyed() || window.isFocused(),
		onOpen: (target) => {
			focusWindow();
			if (window && !window.isDestroyed()) window.webContents.send("desktop:open-task", target);
		},
	});
	ipcMain.handle("desktop:notify-task", (event, value) => {
		if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isAppUrl(event.senderFrame.url))
			throw new Error("Forbidden");
		return notifications.show(value);
	});
	window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) =>
		callback(permission === "clipboard-sanitized-write")
	);
	window.webContents.session.setPermissionCheckHandler(
		(_contents, permission) => permission === "clipboard-sanitized-write"
	);
	window.webContents.setWindowOpenHandler(({ url }) => {
		openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		if (!isAppUrl(url)) {
			event.preventDefault();
			openExternal(url);
		}
	});
	window.webContents.on("will-attach-webview", (event) => event.preventDefault());
	window.webContents.on("render-process-gone", (_event, details) => {
		if (!quitting) void fail(new Error(`Workbench stopped (${details.reason})`));
	});
	window.once("ready-to-show", focusWindow);
	window.on("closed", () => {
		window = undefined;
	});
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: "Pi-Wm",
				submenu: [
					{
						label: "关于与更新",
						click: () => {
							focusWindow();
							window?.webContents.send("desktop:open-updates");
						},
					},
					{ label: "Open logs", click: () => void shell.openPath(logs) },
					{ type: "separator" },
					{ role: "quit" },
				],
			},
			{ role: "editMenu" },
			{
				label: "View",
				submenu: [
					{ role: "reload" },
					{ role: "resetZoom" },
					{ role: "zoomIn" },
					{ role: "zoomOut" },
					{ role: "togglefullscreen" },
				],
			},
		])
	);
	await window.loadURL(APP_URL);
	updates.start();
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", focusWindow);
	app.on("activate", focusWindow);
	app.on("window-all-closed", () => app.quit());
	app.on("before-quit", (event) => {
		globalShortcut.unregisterAll();
		updates?.dispose();
		if (allowQuit) return;
		event.preventDefault();
		if (quitting) return;
		quitting = true;
		void (async () => {
			await host?.stop();
			await bootPromise?.catch(() => {});
			await host?.stop();
			allowQuit = true;
			app.quit();
		})();
	});
	app.whenReady().then(() => {
		if (!quitting) {
			bootPromise = boot();
			void bootPromise.catch(fail);
		}
	});
}
