// Generate Voice in the app's main process (ADR 0017). The viewer asks over the
// bridge; main checks the sender, shows a native dialog the page can't draw or
// answer, decrypts the key, calls the provider's pinned host, and writes the
// file into media/ under a name it picks. There is no server route for any of
// this, and the logs get status codes. Rig code in the viewer can reach the
// bridge, which is why every spend and every removal stops at a native dialog.
// Electron main process only.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { isLoopback, pinnedFetch } from '../tools/voice/pinned.ts';
import { providers } from '../tools/voice/providers/index.ts';
import { saveVoiceFile } from '../tools/voice/save.ts';
import { estimate, finished, ProviderError, type GeneratedWord, type Provider } from '../tools/voice/types.ts';
import { KeyRefused, KeyStore } from './keys.ts';

export interface VoiceHost {
  /** The project on screen, if this came from the main frame of the viewer window; null from anything else. */
  projectOf(event: IpcMainEvent | IpcMainInvokeEvent): string | null;
  /** The window dialogs hang from. */
  window(): BrowserWindow | null;
  /** The folder holding the preloads and pages. */
  pages: string;
  log(line: string): void;
}

const MAX_TEXT = 5000;
/** Most of a provider's answer the app will write. */
const MAX_BYTES = 64 * 1024 * 1024;
/** How much of the text the dialog shows. */
const SHOWN_TEXT = 1200;

/** A test's fake provider host. Only ever a loopback address, and never in a packaged app. */
function originOf(provider: Provider): string {
  const fake = process.env.FRAME_STUDIO_FAKE_PROVIDER;
  if (fake && !app.isPackaged && isLoopback(fake)) return fake;
  return `https://${provider.host}`;
}

/** The text as the dialog prints it: nothing that hides or reorders what's around it. */
function printable(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length <= SHOWN_TEXT ? clean : `${clean.slice(0, SHOWN_TEXT)}… and ${clean.length - SHOWN_TEXT} more characters`;
}

const languages: Readonly<Record<string, string>> = { en: 'English', es: 'Spanish' };

export function registerVoice(host: VoiceHost): void {
  const store = new KeyStore(join(app.getPath('userData'), 'keys.json'), safeStorage);
  let entry: { window: BrowserWindow; provider: Provider; done: (saved: boolean) => void } | null = null;
  /** One spend at a time, so a loop in a rig can't stack dialogs. */
  let generating = false;

  const provider = (id: unknown) => providers.find((p) => p.id === id);
  const page = pathToFileURL(join(host.pages, 'key-window.html')).href;
  const fromEntry = (event: IpcMainEvent | IpcMainInvokeEvent) => entry !== null && event.sender === entry.window.webContents && event.senderFrame?.url === page;

  async function listing() {
    const keys = await store.list();
    return {
      refusal: store.refusal(),
      providers: providers.map((p) => ({
        id: p.id,
        label: p.label,
        kinds: p.kinds,
        keyPage: p.keyPage,
        usdPer1000Characters: p.price.usdPer1000Characters,
        voices: p.voices,
        key: keys.find((k) => k.provider === p.id) ?? null,
      })),
    };
  }

  /** The entry window: main's own page and preload, with no way to the viewer. Resolves to whether a key was saved. */
  function askForKey(chosen: Provider): Promise<boolean> {
    if (entry) {
      entry.window.focus();
      return Promise.resolve(false);
    }
    const parent = host.window() ?? undefined;
    const win = new BrowserWindow({
      width: 460,
      height: 330,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: `Add a ${chosen.label} key`,
      ...(parent ? { parent } : {}),
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
      webPreferences: { preload: join(host.pages, 'key-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged, spellcheck: false },
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return new Promise((done) => {
      entry = { window: win, provider: chosen, done };
      win.on('closed', () => {
        entry?.done(false);
        entry = null;
      });
      void win.loadURL(page);
    });
  }

  ipcMain.on('frame-studio:key-entry-provider', (event) => {
    event.returnValue = fromEntry(event) ? { id: entry!.provider.id, label: entry!.provider.label } : null;
  });
  ipcMain.on('frame-studio:key-entry-cancel', (event) => {
    if (fromEntry(event)) entry!.window.close();
  });
  ipcMain.on('frame-studio:key-entry-page', (event) => {
    if (fromEntry(event)) void shell.openExternal(entry!.provider.keyPage);
  });
  ipcMain.handle('frame-studio:key-entry-save', async (event, key: unknown) => {
    if (!fromEntry(event) || typeof key !== 'string') return 'This window can\'t save a key.';
    const open = entry!;
    try {
      await store.save(open.provider.id, key);
    } catch (err) {
      // KeyRefused's words are fixed. Any other message might quote the key, so only the kind of error reaches the log.
      if (err instanceof KeyRefused) return err.message;
      host.log(`could not save a key for ${open.provider.id} (${err instanceof Error ? err.name : 'unknown'})`);
      return 'The key could not be saved.';
    }
    host.log(`saved a key for ${open.provider.id}`);
    open.done(true);
    entry = null;
    open.window.close();
    return null;
  });

  ipcMain.handle('frame-studio:voice-providers', async (event) => (host.projectOf(event) ? listing() : null));
  ipcMain.handle('frame-studio:voice-add-key', async (event, id: unknown) => {
    const chosen = provider(id);
    if (!host.projectOf(event) || !chosen) return false;
    return askForKey(chosen);
  });
  ipcMain.handle('frame-studio:voice-remove-key', async (event, id: unknown) => {
    const chosen = provider(id);
    const parent = host.window();
    if (!host.projectOf(event) || !chosen || !parent) return false;
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      message: `Remove your ${chosen.label} key?`,
      detail: `This deletes it from this computer. Anything already copied from it keeps working until you revoke it at ${new URL(chosen.keyPage).host}.`,
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
    await store.remove(chosen.id);
    host.log(`removed the key for ${chosen.id}`);
    return true;
  });

  ipcMain.handle('frame-studio:voice-generate', async (event, input: unknown): Promise<{ file: string; words?: GeneratedWord[] } | { error: string } | { cancelled: true }> => {
    const folder = host.projectOf(event);
    const { provider: id, text, lang, voice } = (input ?? {}) as Record<string, unknown>;
    const chosen = provider(id);
    const parent = host.window();
    if (!folder || !parent) return { error: 'Generate from the viewer window.' };
    if (!chosen || !chosen.kinds.includes('voice')) return { error: 'There is no such provider.' };
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT) return { error: `The text must be 1 to ${MAX_TEXT} characters.` };
    if (typeof lang !== 'string' || typeof voice !== 'string') return { error: 'Pick a language and a voice.' };
    const speaker = chosen.voices.find((v) => v.id === voice && v.langs.includes(lang));
    if (!speaker) return { error: `${chosen.label} has no such voice in that language.` };
    if (generating) return { error: 'A generation is already running.' };
    generating = true;
    try {
      const { response } = await dialog.showMessageBox(parent, {
        type: 'question',
        message: `Generate voice with ${chosen.label}?`,
        detail: `Voice: ${speaker.label}, ${languages[lang] ?? lang}\nEstimated price: ${estimate(chosen, text)} for ${text.length} characters. Your ${chosen.label} plan decides the real cost.\n\n${printable(text)}`,
        buttons: ['Generate', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return { cancelled: true };
      let key: string | null = await store.reveal(chosen.id);
      if (key === null) return { error: `Add a ${chosen.label} key first.` };
      let made;
      try {
        made = await finished(await chosen.generate({ kind: 'voice', text, lang, voice }, key, pinnedFetch(originOf(chosen))));
      } finally {
        // A JavaScript string can't be wiped; this drops our one reference to it.
        key = null;
      }
      if (made.bytes.length > MAX_BYTES) return { error: `${chosen.label} sent more than the app will save.` };
      const file = await saveVoiceFile(folder, chosen.id, made.ext, made.bytes);
      host.log(`${chosen.id}: generated ${made.bytes.length} bytes`);
      return { file, ...(made.words ? { words: made.words } : {}) };
    } catch (err) {
      if (err instanceof ProviderError) {
        host.log(`${chosen.id}: status ${err.status}`);
        return { error: err.message };
      }
      // Whatever else broke may quote the request, so only its kind goes anywhere.
      host.log(`${chosen.id}: failed (${err instanceof Error ? err.name : 'unknown'})`);
      return { error: `Could not reach ${chosen.label}, or its answer made no sense.` };
    } finally {
      generating = false;
    }
  });
}
