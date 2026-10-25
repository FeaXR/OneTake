import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, shell } from 'electron';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codedError, resolveLanguage, setLanguage, t } from '../shared/i18n/index.ts';
import type { AudioInfo, ExportRequest, LoadedAudio, Project, Settings } from '../shared/types.ts';
import { runExport } from './exporter.ts';
import { loadPeaks, savePeaks } from './peaks.ts';
import { WavRecorder } from './recorder.ts';
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
/** The recording in progress, if any, and the sleep blocker held while it runs. */
let recording: { rec: WavRecorder; blocker: number; started: number } | null = null;

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

function audioInfo(layout: WavLayout, modified: number): AudioInfo {
  const { path, sampleRate, channels, bitsPerSample, sampleFormat, frames, duration } = layout;
  return { path, sampleRate, channels, bitsPerSample, sampleFormat, frames, duration, modified };
}

/**
 * Finishes the recording: final header, file closed, peaks cached so reopening the WAV is
 * instant, sleep allowed again. Also runs when the window closes or the page goes away, so
 * the file is always left complete.
 */
async function stopRecording(): Promise<AudioInfo | null> {
  const r = recording;
  if (!r) return null;
  recording = null;
  powerSaveBlocker.stop(r.blocker);
  win?.webContents.setBackgroundThrottling(true);
  const layout = await r.rec.finish();
  if (openedWav?.path === layout.path) openedWav = layout;
  await savePeaks(layout.path, peaksCacheDir(), r.rec.peakData());
  return audioInfo(layout, r.started);
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

  // A reload or a crashed page sends no more samples; the file is finished with what it has.
  win.webContents.on('did-start-loading', () => void stopRecording());
  win.webContents.on('render-process-gone', () => void stopRecording());

  win.on('close', (e) => {
    if (recording) {
      e.preventDefault();
      const choice = dialog.showMessageBoxSync(win!, {
        type: 'warning',
        buttons: [t('btn.stopAndClose'), t('btn.cancel')],
        defaultId: 1,
        cancelId: 1,
        title: t('dlg.recClose.title'),
        message: t('dlg.recClose.message'),
      });
      if (choice === 0) void stopRecording().finally(() => win?.close());
      return;
    }
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
    return { info: audioInfo(openedWav, statSync(path).mtimeMs), peaks, project: await loadProject(path) };
  });

  ipcMain.handle('rec:start', async (_e, dir: string, name: string, sampleRate: number, channels: number): Promise<AudioInfo> => {
    if (recording) throw codedError('err.alreadyRecording');
    const path = resolve(dir, name);
    let rec: WavRecorder;
    try {
      rec = await WavRecorder.create(path, sampleRate, channels);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw codedError('err.recExists', { name });
      throw err;
    }
    recording = { rec, blocker: powerSaveBlocker.start('prevent-app-suspension'), started: Date.now() };
    // A minimized window must keep passing samples on at full speed.
    win?.webContents.setBackgroundThrottling(false);
    openedWav = rec.layout();
    return audioInfo(openedWav, recording.started);
  });
  ipcMain.handle('rec:append', async (_e, planes: Float32Array[]): Promise<number> => {
    const r = recording;
    if (!r) return openedWav?.frames ?? 0;
    const frames = await r.rec.append(planes);
    if (recording === r && openedWav?.path === r.rec.path) openedWav = r.rec.layout();
    return frames;
  });
  ipcMain.handle('rec:stop', () => stopRecording());

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
  ipcMain.handle('fs:list', (_e, dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
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

app.on('window-all-closed', () => void stopRecording().finally(() => app.quit()));
