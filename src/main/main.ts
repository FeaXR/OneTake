import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExportRequest, LoadedAudio, Project, Settings } from '../shared/types.ts';
import { runExport } from './exporter.ts';
import { handleMediaScheme, registerMediaScheme } from './media-protocol.ts';
import { loadPeaks } from './peaks.ts';
import {
  loadProject, loadSettings, loadShortcutOverrides, peaksCacheDir, saveProject, saveSettings, saveShortcutOverrides,
} from './store.ts';
import { readWavLayout } from './wav.ts';

registerMediaScheme();

let win: BrowserWindow | null = null;
let openedWav: string | null = null;
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

/** File to open once the UI is ready; handed over (once) when the renderer asks. */
let startupFile = wavFromArgs(process.argv);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#17191d',
    title: 'Studio Audio Editor',
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
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (forceClose || !dirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'question',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved changes',
      message: 'Save the changes to this project before closing?',
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
      title: 'Open WAV file',
      properties: ['openFile'],
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('audio:load', async (e, path: string): Promise<LoadedAudio> => {
    const layout = readWavLayout(path);
    const peaks = await loadPeaks(layout, peaksCacheDir(), join(__dirname, 'peaks-worker.cjs'), (fraction) =>
      e.sender.send('audio:loadProgress', fraction),
    );
    openedWav = resolve(path);
    const { sampleRate, channels, bitsPerSample, sampleFormat, frames, duration } = layout;
    const info = { path: openedWav, sampleRate, channels, bitsPerSample, sampleFormat, frames, duration };
    return { info, peaks, project: await loadProject(path) };
  });

  ipcMain.handle('project:save', (_e, wavPath: string, project: Project) => saveProject(wavPath, project));
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (_e, settings: Settings) => saveSettings(settings));
  ipcMain.handle('shortcuts:get', () => loadShortcutOverrides());
  ipcMain.handle('shortcuts:save', (_e, overrides: Record<string, string[]>) => saveShortcutOverrides(overrides));

  ipcMain.handle('dialog:pickFolder', async (_e, defaultPath: string | null) => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose output folder',
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

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    handleMediaScheme((path) => openedWav !== null && resolve(path) === openedWav);
    registerIpc();
    createWindow();
  });
}

app.on('window-all-closed', () => app.quit());
