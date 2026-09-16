const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wumingDesktop", {
	connect: () => ipcRenderer.invoke("desktop:connect"),
	windowChrome: process.platform === "win32",
	openMenu: () => ipcRenderer.invoke("desktop:window-chrome", "menu"),
	setWindowTheme: (theme) => ipcRenderer.invoke("desktop:window-chrome", "theme", theme),
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
