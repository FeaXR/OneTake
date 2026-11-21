import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, shell, systemPreferences } from 'electron';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { codedError, resolveLanguage, setLanguage, t } from '../shared/i18n/index.ts';
import type { AudioInfo, ExportRequest, LoadedAudio, Project, Settings } from '../shared/types.ts';
import { runExport } from './exporter.ts';
import { loadPeaks, savePeaks } from './peaks.ts';
import { LEGACY_FOLDER, moveLegacyFolder } from './legacy-folders.ts';
import { repairRecording, WavRecorder } from './recorder.ts';
import { Updater } from './updates.ts';
import { DEVELOPER_PAGE, REPOSITORY_PAGE } from '../shared/links.ts';
import { APP_FOLDER } from './session-path.ts';
import {
  configureStore, loadProject, loadSettings, loadShortcutOverrides, peaksCacheDir, saveProject, saveSettings, saveShortcutOverrides,
} from './store.ts';
import { readFrames, readWavLayout, type WavLayout } from './wav.ts';
import { trimDir } from '../shared/naming.ts';
import { CLI_USAGE, parseCli, type CliCommand } from '../shared/cli.ts';

let win: BrowserWindow | null = null;
/** The WAV the renderer has open; playback reads its samples. */
let openedWav: WavLayout | null = null;
let dirty = false;
let forceClose = false;
/** The whole app is quitting (not just the window being closed by the user). */
let quitting = false;
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
  await rm(recordingMarker(), { force: true });
  if (openedWav?.path === layout.path) openedWav = layout;
  await savePeaks(layout.path, peaksCacheDir(), r.rec.peakData());
  return audioInfo(layout, r.started);
}

/** File to open once the UI is ready; handed over (once) when the renderer asks. */
let startupFile = wavFromArgs(process.argv);

// The command line can start a recording or stop the running one (see CLI_USAGE).
const cli = parseCli(process.argv.slice(1), process.cwd(), resolve);
if ('error' in cli) {
  console.error(`One Take: ${cli.error}\n\n${CLI_USAGE}`);
  process.exit(2);
}
if (cli.command?.kind === 'help') {
  console.log(CLI_USAGE);
  process.exit(0);
}
/** A recording to start (or a stop) from the command line, handed over once the UI is ready. */
let startupCommand: CliCommand | null = cli.command;

/**
 * Lies next to the settings while a recording runs and is removed when it is finished. Finding
 * it at startup means the app did not get to finish the file (crash, power cut), so it is repaired.
 */
const recordingMarker = () => join(app.getPath('userData'), 'recording.json');
interface RecordingMarker {
  path: string;
  sampleRate: number;
  channels: number;
}
/** A recording repaired at startup, for the renderer to mention. */
let recovered: { path: string; duration: number } | null = null;

async function recoverRecording(): Promise<void> {
  let marker: RecordingMarker;
  try {
    marker = JSON.parse(await readFile(recordingMarker(), 'utf8')) as RecordingMarker;
  } catch {
    return;
  }
  try {
    const frames = await repairRecording(marker.path, marker.sampleRate, marker.channels);
    recovered = { path: marker.path, duration: frames / marker.sampleRate };
    console.log(`One Take: repaired ${marker.path}, cut off at ${recovered.duration.toFixed(1)} s`);
  } catch (err) {
    console.error(`One Take: could not repair ${marker.path}: ${(err as Error).message}`);
  }
  await rm(recordingMarker(), { force: true });
}

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
      // Shutting down, logging out or a kill must not hang on a question: the file is finished.
      if (quitting) {
        void stopRecording()
          .then((info) => info && console.log(`One Take: recording saved on quit: ${info.path} (${info.duration.toFixed(1)} s)`))
          .finally(() => win?.close());
        return;
      }
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
      // A folder given on the command line may not exist yet.
      await mkdir(dir, { recursive: true });
      rec = await WavRecorder.create(path, sampleRate, channels);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw codedError('err.recExists', { name });
      throw err;
    }
    recording = { rec, blocker: powerSaveBlocker.start('prevent-app-suspension'), started: Date.now() };
    await writeFile(recordingMarker(), JSON.stringify({ path, sampleRate, channels } satisfies RecordingMarker));
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
  ipcMain.handle('shell:openFolder', async (_e, dir: string) => {
    if (!existsSync(dir)) throw codedError('err.folderMissing', { dir });
    const error = await shell.openPath(dir);
    if (error) throw new Error(error);
  });

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
  ipcMain.handle('shell:openProjectLink', (_e, link: 'developer' | 'repository') =>
    shell.openExternal(link === 'developer' ? DEVELOPER_PAGE : REPOSITORY_PAGE));

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
  ipcMain.handle('app:takeCommand', () => {
    const command = startupCommand;
    startupCommand = null;
    return command;
  });
  ipcMain.handle('app:takeRecovered', () => {
    const r = recovered;
    recovered = null;
    return r;
  });
  // What a command-line recording does is also printed in the terminal that started the app.
  ipcMain.on('app:cliLog', (_e, text: string, error: boolean) => (error ? console.error : console.log)(`One Take: ${text}`));
}

// The app used to be called Studio Audio Editor. Its settings (with the peaks cache) and its
// Documents folder (sessions) move to the new names before anything reads them.
moveLegacyFolder(join(app.getPath('appData'), LEGACY_FOLDER), app.getPath('userData'));
moveLegacyFolder(join(app.getPath('documents'), LEGACY_FOLDER), join(app.getPath('documents'), APP_FOLDER));
configureStore({ userData: app.getPath('userData'), sessions: join(app.getPath('documents'), APP_FOLDER, 'Sessions') });

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
// A second launch hands its command over already parsed: Chromium reorders the arguments it
// passes on (switches first), which would split "--dir folder" apart.
if (!app.requestSingleInstanceLock({ command: startupCommand })) {
  // The running copy carries out the command and prints what happens in its own terminal.
  if (startupCommand?.kind === 'record') console.log('One Take: already running; the recording starts there.');
  if (startupCommand?.kind === 'stop') console.log('One Take: asked the running app to stop recording.');
  app.quit();
} else if (startupCommand?.kind === 'stop') {
  console.error('One Take: not running, so nothing is being recorded.');
  process.exit(1);
} else {
  app.on('second-instance', (_e, argv, workingDirectory, additionalData) => {
    if (!win) return;
    const command = (additionalData as { command?: CliCommand | null } | null)?.command ?? null;
    if (command?.kind === 'record' || command?.kind === 'stop') {
      win.webContents.send('app:command', command);
      if (command.kind === 'stop') return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = command ? null : wavFromArgs(argv, workingDirectory);
    if (file) win.webContents.send('app:openFile', file);
  });

  // The app is told to quit (shutdown, logout, a kill, Cmd+Q) rather than its window being
  // closed: a recording is then finished without asking (see the window's close handler).
  app.on('before-quit', () => (quitting = true));

  app.whenReady().then(async () => {
    powerMonitor.on('shutdown', () => void stopRecording());
    await recoverRecording();
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
