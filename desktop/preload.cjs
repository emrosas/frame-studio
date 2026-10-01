// The viewer window's preload (ADR 0008): the desktop bridge, and nothing
// else. The page gets the studio server's pairing token once, and asks main
// for native features: Reveal in Finder, the project switcher (ADR 0013), and
// updates (ADR 0009) when the app can update. Plain CommonJS, since sandboxed
// preloads can't be modules or TypeScript.

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

contextBridge.exposeInMainWorld('frameStudioDesktop', {
  token: ipcRenderer.sendSync('frame-studio:token'),
  reveal: (path) => ipcRenderer.invoke('frame-studio:reveal', String(path)),
  openFolder: () => ipcRenderer.invoke('frame-studio:open-folder'),
  projects: () => ipcRenderer.invoke('frame-studio:projects'),
  newProject: () => ipcRenderer.invoke('frame-studio:new-project'),
  openProject: (path) => ipcRenderer.invoke('frame-studio:open-recent', String(path)),
  ...(ipcRenderer.sendSync('frame-studio:updates') ? { updates: updates() } : {}),
});
