// The welcome window's preload: New studio folder, Open folder, the recent
// folders, and updates (ADR 0009) when the app can update, the same calls
// as the viewer's preload. Plain CommonJS, since sandboxed preloads can't be
// modules or share files.

const { contextBridge, ipcRenderer } = require('electron');

function updates() {
  return {
    state: () => ipcRenderer.invoke('frame-studio:update-state'),
    onChange: (cb) => {
      const listener = (_event, state) => cb(state);
      ipcRenderer.on('frame-studio:update-changed', listener);
      return () => ipcRenderer.removeListener('frame-studio:update-changed', listener);
    },
    check: () => ipcRenderer.invoke('frame-studio:update-check'),
    install: () => ipcRenderer.invoke('frame-studio:update-install'),
    openNotes: () => ipcRenderer.invoke('frame-studio:update-notes'),
  };
}

contextBridge.exposeInMainWorld('frameStudioWelcome', {
  recent: ipcRenderer.sendSync('frame-studio:recent'),
  newFolder: () => ipcRenderer.invoke('frame-studio:new-folder'),
  openFolder: () => ipcRenderer.invoke('frame-studio:open-folder'),
  openRecent: (path) => ipcRenderer.invoke('frame-studio:open-recent', String(path)),
  ...(ipcRenderer.sendSync('frame-studio:updates') ? { updates: updates() } : {}),
});
