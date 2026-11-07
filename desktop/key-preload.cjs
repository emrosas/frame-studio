// The key entry window's preload (ADR 0017). This window is the app's own file,
// never the viewer, so no project code can watch a key being pasted. It can
// save or cancel, and open the provider's key page. Plain CommonJS, since
// sandboxed preloads can't be modules.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frameStudioKeyEntry', {
  provider: ipcRenderer.sendSync('frame-studio:key-entry-provider'),
  save: (key) => ipcRenderer.invoke('frame-studio:key-entry-save', String(key)),
  cancel: () => ipcRenderer.send('frame-studio:key-entry-cancel'),
  openKeyPage: () => ipcRenderer.send('frame-studio:key-entry-page'),
});
