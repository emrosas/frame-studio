// The welcome window's preload: New studio folder, Open folder, and the
// recent folders. Plain CommonJS, since sandboxed preloads can't be modules.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frameStudioWelcome', {
  recent: ipcRenderer.sendSync('frame-studio:recent'),
  newFolder: () => ipcRenderer.invoke('frame-studio:new-folder'),
  openFolder: () => ipcRenderer.invoke('frame-studio:open-folder'),
  openRecent: (path) => ipcRenderer.invoke('frame-studio:open-recent', String(path)),
});
