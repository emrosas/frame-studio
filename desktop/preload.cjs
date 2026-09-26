// The viewer window's preload (ADR 0008): the desktop bridge, and nothing
// else. The page gets the studio server's pairing token once, and asks main
// for native features: Reveal in Finder and the folder picker. Plain
// CommonJS, since sandboxed preloads can't be modules or TypeScript.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frameStudioDesktop', {
  token: ipcRenderer.sendSync('frame-studio:token'),
  reveal: (path) => ipcRenderer.invoke('frame-studio:reveal', String(path)),
  openFolder: () => ipcRenderer.invoke('frame-studio:open-folder'),
});
