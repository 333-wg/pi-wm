const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("wumingDesktop", {
	connect: () => ipcRenderer.invoke("desktop:connect"),
});
