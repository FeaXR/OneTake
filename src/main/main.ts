import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, shell, systemPreferences } from 'electron';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codedError, resolveLanguage, setLanguage, t } from '../shared/i18n/index.ts';
import type { AudioInfo, ExportRequest, LoadedAudio, Project, Settings } from '../shared/types.ts';
import { runExport } from './exporter.ts';
import { loadPeaks, savePeaks } from './peaks.ts';
import { LEGACY_FOLDER, moveLegacyFolder } from './legacy-folders.ts';
import { WavRecorder } from './recorder.ts';
import { Updater } from './updates.ts';
import { APP_FOLDER } from './session-path.ts';
import {
  loadProject, loadSettings, loadShortcutOverrides, peaksCacheDir, saveProject, saveSettings, saveShortcutOverrides,
} from './store.ts';
import { readFrames, readWavLayout, type WavLayout } from './wav.ts';
import { trimDir } from '../shared/naming.ts';

let win: BrowserWindow | null = null;
/** The WAV the renderer has open; playback reads its samples. */
let openedWav: WavLayout | null = null;
let dirty = false;
let forceClose = false;
let exportAbort: AbortController | null = null;
/** The recording in progress, if any, and the sleep blocker held while it runs. */
let recording: { rec: WavRecorder; blocker: number; started: number } | null = null;
let updater: Updater | null = null;
/** The startup check waits a moment, so it does not compete with opening a file. */
const UPDATE_CHECK_DELAY_MS = 3000;
/** The app can stay open for days (a recording, a long edit), so it looks again now and then. */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

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

/**
 * The window's own icon. Windows and macOS take it from the app, but on Linux the title bar
 * only finds one through a launcher named exactly like the app, and AppImage managers rename
 * theirs (one-take-1.1.0-x86_64.desktop). So the packaged Linux app hands its icon over itself.
 */
function windowIcon(): string | undefined {
  if (existsSync(devIcon)) return devIcon;
  const packaged = join(process.resourcesPath, 'icon.png');
  return process.platform === 'linux' && existsSync(packaged) ? packaged : undefined;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#17191d',
    icon: windowIcon(),
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

  // macOS asks the user once before any app may record; other systems need no permission.
  ipcMain.handle('media:allowMicrophone', () =>
    process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true,
  );

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
    // Some folder dialogs (the Linux desktop portal) can return the path with a slash at the end.
    return result.canceled ? null : trimDir(result.filePaths[0]);
  });
  ipcMain.handle('fs:list', (_e, dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  });
  ipcMain.handle('fs:listFolders', (_e, dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
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

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:state', () => updater?.state ?? { status: 'idle' });
  ipcMain.handle('update:check', () => updater!.check());
  ipcMain.handle('update:install', () => {
    updater!.install();
    return updater!.state;
  });
  ipcMain.handle('update:openDownloadPage', () => updater!.openDownloadPage());

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

// The app used to be called Studio Audio Editor. Its settings (with the peaks cache) and its
// Documents folder (sessions) move to the new names before anything reads them.
moveLegacyFolder(join(app.getPath('appData'), LEGACY_FOLDER), app.getPath('userData'));
moveLegacyFolder(join(app.getPath('documents'), LEGACY_FOLDER), join(app.getPath('documents'), APP_FOLDER));

/**
 * No menu bar on Windows and Linux: everything is in the toolbar. A Mac always has a menu bar,
 * and without one Cmd+Q and copy and paste in text fields do not work. Undo and redo are left
 * out, so Cmd+Z reaches the app's own undo.
 */
function appMenu(): Menu | null {
  if (process.platform !== 'darwin') return null;
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      role: 'editMenu',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
  ]);
}

// On a Mac, a WAV dropped on the Dock icon or opened with "Open With" arrives here, not in argv.
app.on('open-file', (e, path) => {
  e.preventDefault();
  if (!/\.wav$/i.test(path)) return;
  if (win) win.webContents.send('app:openFile', path);
  else startupFile = path;
});

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
    Menu.setApplicationMenu(appMenu());
    updater = new Updater((state) => win?.webContents.send('update:state', state));
    registerIpc();
    createWindow();
    const checkForUpdates = () =>
      void loadSettings().then((s) => {
        if (s.checkUpdates) void updater!.check();
      });
    setTimeout(checkForUpdates, UPDATE_CHECK_DELAY_MS);
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  });
}

app.on('window-all-closed', () => void stopRecording().finally(() => app.quit()));
