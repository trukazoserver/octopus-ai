import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("octopus", {
	ping: () => ipcRenderer.invoke("octopus:ping"),
	getConfig: () => ipcRenderer.invoke("octopus:getConfig"),
	minimize: () => ipcRenderer.send("window-minimize"),
	maximize: () => ipcRenderer.send("window-maximize"),
	close: () => ipcRenderer.send("window-close"),
});
