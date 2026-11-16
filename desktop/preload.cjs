const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('sowalifDesktop', {
    pickDirectory: () => ipcRenderer.invoke('sowalif:pick-directory'),
  });
}
