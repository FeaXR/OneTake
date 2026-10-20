import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveLanguage, setLanguage, t } from '../shared/i18n/index.ts';
import type { ExportRequest, LoadedAudio, Project, Settings } from '../shared/types.ts';
import { runExport } from './exporter.ts';
import { loadPeaks } from './peaks.ts';
import {
  loadProject, loadSettings, loadShortcutOverrides, peaksCacheDir, saveProject, saveSettings, saveShortcutOverrides,
} from './store.ts';
import { readFrames, readWavLayout, type WavLayout } from './wav.ts';

let win: BrowserWindow | null = null;
/** The WAV the renderer has open; playback reads its samples. */
let openedWav: WavLayout | null = null;
let dirty = false;
let forceClose = false;
let exportAbort: AbortController | null = null;

/**
 * First existing .wav among command-line arguments. Dropping a file onto the .exe or a shortcut,
 * or "Open with", starts the app with the file's path as an argument.
 */
function wavFromArgs(argv: string[], cwd = process.cwd()): string | null {
  for (const arg of argv.slice(1)) {
    if (!/\.wav$/i.test(arg)) continue;
    const path = resolve(cwd, arg);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Dialogs shown by the main process (file pickers, close prompt) follow the app language. */
function applyLanguage(settings: Settings): void {
  setLanguage(resolveLanguage(settings.language, app.getLocale()));
}

/** File to open once the UI is ready; handed over (once) when the renderer asks. */
let startupFile = wavFromArgs(process.argv);

const devIcon = join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#17191d',
    // Packaged builds take the icon from the .exe; this covers running from source.
    icon: existsSync(devIcon) ? devIcon : undefined,
    title: t('app.name'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.maximize();

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));

  // Keep the page from navigating away when a file is dropped outside the drop zone.
  // Reloading the app's own page (used to switch language) is allowed.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });

  win.on('close', (e) => {
    if (forceClose || !dirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'question',
      buttons: [t('btn.save'), t('btn.dontSave'), t('btn.cancel')],
      defaultId: 0,
      cancelId: 2,
      title: t('dlg.unsaved.title'),
      message: t('dlg.unsaved.closeMessage'),
    });
    if (choice === 0) win!.webContents.send('app:saveAndClose');
    else if (choice === 1) {
      forceClose = true;
      win!.close();
    }
  });
  win.on('closed', () => {
    exportAbort?.abort();
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle('dialog:pickWav', async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: t('dlg.openWav.title'),
      properties: ['openFile'],
      filters: [{ name: t('dlg.openWav.filter'), extensions: ['wav'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('audio:load', async (e, path: string): Promise<LoadedAudio> => {
    const layout = readWavLayout(path);
    const peaks = await loadPeaks(layout, peaksCacheDir(), join(__dirname, 'peaks-worker.cjs'), (fraction) =>
      e.sender.send('audio:loadProgress', fraction),
    );
    openedWav = { ...layout, path: resolve(path) };
    const { sampleRate, channels, bitsPerSample, sampleFormat, frames, duration } = layout;
    const info = { path: openedWav.path, sampleRate, channels, bitsPerSample, sampleFormat, frames, duration };
    return { info, peaks, project: await loadProject(path) };
  });

  ipcMain.handle('audio:read', (_e, start: number, count: number): Float32Array[] =>
    openedWav ? readFrames(openedWav, start, count) : [],
  );

  ipcMain.handle('project:save', (_e, wavPath: string, project: Project) => saveProject(wavPath, project));
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', async (_e, settings: Settings) => {
    await saveSettings(settings);
    applyLanguage(settings);
  });
  ipcMain.handle('shortcuts:get', () => loadShortcutOverrides());
  ipcMain.handle('shortcuts:save', (_e, overrides: Record<string, string[]>) => saveShortcutOverrides(overrides));

  ipcMain.handle('dialog:pickFolder', async (_e, defaultPath: string | null) => {
    const result = await dialog.showOpenDialog(win!, {
      title: t('dlg.folder.title'),
      defaultPath: defaultPath ?? undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('fs:existing', (_e, dir: string, names: string[]) => names.filter((n) => existsSync(join(dir, n))));
  ipcMain.handle('shell:showInFolder', (_e, path: string) => shell.showItemInFolder(path));

  ipcMain.handle('export:start', async (e, req: ExportRequest) => {
    exportAbort?.abort();
    const abort = new AbortController();
    exportAbort = abort;
    try {
      return await runExport(req, (p) => e.sender.send('export:progress', p), abort.signal);
    } finally {
      if (exportAbort === abort) exportAbort = null;
    }
  });
  ipcMain.handle('export:cancel', () => exportAbort?.abort());

  ipcMain.on('app:setDirty', (_e, value: boolean) => {
    dirty = value;
  });
  ipcMain.on('app:setTitle', (_e, title: string) => win?.setTitle(title));
  ipcMain.on('app:closeNow', () => {
    forceClose = true;
    win?.close();
  });
  ipcMain.on('app:toggleDevTools', () => win?.webContents.toggleDevTools());
  ipcMain.handle('app:takeStartupFile', () => {
    const file = startupFile;
    startupFile = null;
    return file;
  });
}

// One window only: launching again with a file (e.g. dropping another WAV on the icon)
// hands the file to the running app instead of opening a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = wavFromArgs(argv, workingDirectory);
    if (file) win.webContents.send('app:openFile', file);
  });

  app.whenReady().then(async () => {
    applyLanguage(await loadSettings());
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
  });
}

app.on('window-all-closed', () => app.quit());
