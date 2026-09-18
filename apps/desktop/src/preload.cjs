const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wumingDesktop", {
	connect: () => ipcRenderer.invoke("desktop:connect"),
	browser: {
		invoke: (request) => ipcRenderer.invoke("desktop:browser", request),
		onFocusAddress: (callback) => {
			const listener = (_event, owner) => callback(owner);
			ipcRenderer.on("desktop:browser-focus", listener);
			return () => ipcRenderer.removeListener("desktop:browser-focus", listener);
		},
		onState: (callback) => {
			const listener = (_event, state) => callback(state);
			ipcRenderer.on("desktop:browser-state", listener);
			return () => ipcRenderer.removeListener("desktop:browser-state", listener);
		},
	},
	windowChrome: process.platform === "win32",
	openMenu: () => ipcRenderer.invoke("desktop:window-chrome", "menu"),
	setWindowTheme: (theme) => ipcRenderer.invoke("desktop:window-chrome", "theme", theme),
	notifications: {
		show: (value) => ipcRenderer.invoke("desktop:notify-task", value),
		onOpen: (callback) => {
			const listener = (_event, target) => callback(target);
			ipcRenderer.on("desktop:open-task", listener);
			return () => ipcRenderer.removeListener("desktop:open-task", listener);
		},
	},
	updates: {
		invoke: (action, value) => ipcRenderer.invoke("desktop:updates", action, value),
		onState: (callback) => {
			const listener = (_event, state) => callback(state);
			ipcRenderer.on("desktop:update-state", listener);
			return () => ipcRenderer.removeListener("desktop:update-state", listener);
		},
		onOpen: (callback) => {
			const listener = () => callback();
			ipcRenderer.on("desktop:open-updates", listener);
			return () => ipcRenderer.removeListener("desktop:open-updates", listener);
		},
	},
});
