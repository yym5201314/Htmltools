// Bridge between the UI (renderer process) and native dialogs. The UI keeps
// working in a plain browser too: it falls back to <input type="file"> when
// window.h2m is missing.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('h2m', {
  desktop: true,
  pickFile: () => ipcRenderer.invoke('h2m:pick-file'),
  pickFolder: () => ipcRenderer.invoke('h2m:pick-folder'),
  pickOutput: (suggested) => ipcRenderer.invoke('h2m:pick-output', suggested),
  pickAudio: () => ipcRenderer.invoke('h2m:pick-audio'),
  openPath: (target) => ipcRenderer.invoke('h2m:open-path', target),
  version: () => ipcRenderer.invoke('h2m:version'),
});
