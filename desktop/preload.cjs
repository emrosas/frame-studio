// The viewer window's preload (ADR 0008): the desktop bridge, and nothing
// else. The page gets the studio server's pairing token once, what it keeps
// between projects, and asks main for native features: Reveal in Finder, the
// sidebar's projects and converting an old film into a project (ADR 0013), and
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

const boot = ipcRenderer.sendSync('frame-studio:boot');

contextBridge.exposeInMainWorld('frameStudioDesktop', {
  token: ipcRenderer.sendSync('frame-studio:token'),
  boot,
  setPref: (key, value) => ipcRenderer.send('frame-studio:pref', String(key), String(value)),
  setDraft: (key, text) => ipcRenderer.send('frame-studio:draft', String(key), String(text)),
  poster: (path, file) => ipcRenderer.invoke('frame-studio:poster', String(path), String(file)),
  reveal: (path) => ipcRenderer.invoke('frame-studio:reveal', String(path)),
  openFolder: () => ipcRenderer.invoke('frame-studio:open-folder'),
  projects: () => ipcRenderer.invoke('frame-studio:projects'),
  newProject: () => ipcRenderer.invoke('frame-studio:new-project'),
  forgetProject: (path) => ipcRenderer.invoke('frame-studio:forget-recent', String(path)),
  openProject: (path, target) => ipcRenderer.invoke('frame-studio:open-recent', String(path), target),
  convertFilm: (id, project) => ipcRenderer.invoke('frame-studio:convert-film', String(id), project ?? null),
  ...(ipcRenderer.sendSync('frame-studio:updates') ? { updates: updates() } : {}),
});
