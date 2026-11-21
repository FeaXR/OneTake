import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, shell, systemPreferences } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { codedError, resolveLanguage, setLanguage, t } from '../shared/i18n/index.ts';
import type { AudioInfo, ExportRequest, LoadedAudio, Project, Settings, UpdateState } from '../shared/types.ts';
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
import { CLI_USAGE, parseCli, withWav, type CliCommand } from '../shared/cli.ts';

/** A recording in progress: the file being written and the sleep blocker held while it runs. */
interface Recording {
  rec: WavRecorder;
  blocker: number;
  started: number;
  /** The marker file that says this recording is not finished yet (see recoverRecordings). */
  marker: string;
}

/** What the main process keeps for one window: each window has its own file, edits, export and recording. */
interface WindowState {
  win: BrowserWindow;
  /** The WAV this window has open; playback reads its samples. */
  openedWav: WavLayout | null;
  dirty: boolean;
  forceClose: boolean;
  exportAbort: AbortController | null;
  recording: Recording | null;
  /** A WAV, or a command-line command, to hand to the page once it is ready (once). */
  startupFile: string | null;
  startupCommand: CliCommand | null;
}

/** Open windows by their page's id, which is how IPC messages say where they come from. */
const windows = new Map<number, WindowState>();
/** The window used last, which gets files and commands from outside first. */
let lastFocused: WindowState | null = null;
/** The whole app is quitting (not just a window being closed by the user). */
let quitting = false;
let updater: Updater | null = null;
/** The startup check waits a moment, so it does not compete with opening a file. */
const UPDATE_CHECK_DELAY_MS = 3000;
/** The app can stay open for days (a recording, a long edit), so it looks again now and then. */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** The state of the window a message came from. */
function stateOf(sender: Electron.WebContents): WindowState {
  const ws = windows.get(sender.id);
  if (!ws) throw new Error('Unknown window');
  return ws;
}

/** Busy windows are not taken over by files or recordings from outside. */
const idle = (ws: WindowState) => !ws.recording && !ws.exportAbort && !ws.dirty;

/** Sends to every window's page. */
function broadcast(channel: string, value: unknown, except?: Electron.WebContents): void {
  for (const ws of windows.values()) if (ws.win.webContents !== except) ws.win.webContents.send(channel, value);
}

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
 * Finishes a window's recording: final header, file closed, peaks cached so reopening the WAV
 * is instant, sleep allowed again. Also runs when the window closes or the page goes away, so
 * the file is always left complete.
 */
async function stopRecording(ws: WindowState): Promise<AudioInfo | null> {
  const r = ws.recording;
  if (!r) return null;
  ws.recording = null;
  powerSaveBlocker.stop(r.blocker);
  if (!ws.win.isDestroyed()) ws.win.webContents.setBackgroundThrottling(true);
  const layout = await r.rec.finish();
  await rm(r.marker, { force: true });
  if (ws.openedWav?.path === layout.path) ws.openedWav = layout;
  await savePeaks(layout.path, peaksCacheDir(), r.rec.peakData());
  return audioInfo(layout, r.started);
}

/** Finishes every window's recording (shutdown, last window closed). */
function stopAllRecordings(): Promise<unknown> {
  return Promise.all([...windows.values()].map((ws) => stopRecording(ws)));
}

/** File to open in the first window (handed over when its page asks). */
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
/** A recording to start (or a stop) from the command line, for the first window. */
const startupCommand: CliCommand | null = cli.command;

/**
 * One marker per recording lies in this folder next to the settings while it runs, and is
 * removed when it is finished. Finding one at startup means the app did not get to finish that
 * file (crash, power cut), so it is repaired.
 */
const markerDir = () => join(app.getPath('userData'), 'recordings');
/** Where 1.10 kept its single marker; still read at startup. */
const legacyMarker = () => join(app.getPath('userData'), 'recording.json');
interface RecordingMarker {
  path: string;
  sampleRate: number;
  channels: number;
}
/** Recordings repaired at startup, for the first window to mention. */
let recovered: { path: string; duration: number }[] = [];

async function recoverRecordings(): Promise<void> {
  let names: string[] = [];
  try {
    names = (await readdir(markerDir())).filter((n) => n.endsWith('.json')).map((n) => join(markerDir(), n));
  } catch {
    // No folder: nothing was recording.
  }
  for (const file of [legacyMarker(), ...names]) {
    let marker: RecordingMarker;
    try {
      marker = JSON.parse(await readFile(file, 'utf8')) as RecordingMarker;
    } catch {
      continue;
    }
    try {
      const frames = await repairRecording(marker.path, marker.sampleRate, marker.channels);
      const duration = frames / marker.sampleRate;
      recovered.push({ path: marker.path, duration });
      console.log(`One Take: repaired ${marker.path}, cut off at ${duration.toFixed(1)} s`);
    } catch (err) {
      console.error(`One Take: could not repair ${marker.path}: ${(err as Error).message}`);
    }
    await rm(file, { force: true });
  }
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

/**
 * Opens a window, which then opens `file` or carries out `command` once its page is ready.
 * The first window is maximized; later ones open a little offset, so both can be seen.
 */
function createWindow(open: { file?: string | null; command?: CliCommand | null } = {}): WindowState {
  const first = windows.size === 0;
  const offset = lastFocused && !lastFocused.win.isDestroyed() ? lastFocused.win.getBounds() : null;
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    ...(offset && !first ? { x: offset.x + 40, y: offset.y + 40 } : {}),
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
  const ws: WindowState = {
    win, openedWav: null, dirty: false, forceClose: false, exportAbort: null, recording: null,
    startupFile: open.file ?? null, startupCommand: open.command ?? null,
  };
  const id = win.webContents.id;
  windows.set(id, ws);
  lastFocused = ws;
  if (first) win.maximize();
  win.on('focus', () => (lastFocused = ws));

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));

  // Keep the page from navigating away when a file is dropped outside the drop zone.
  // Reloading the app's own page (used to switch language) is allowed.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  // A reload or a crashed page sends no more samples; the file is finished with what it has.
  win.webContents.on('did-start-loading', () => void stopRecording(ws));
  win.webContents.on('render-process-gone', () => void stopRecording(ws));

  win.on('close', (e) => {
    if (ws.recording) {
      e.preventDefault();
      // Shutting down, logging out or a kill must not hang on a question: the file is finished.
      if (quitting) {
        void stopRecording(ws)
          .then((info) => info && console.log(`One Take: recording saved on quit: ${info.path} (${info.duration.toFixed(1)} s)`))
          .finally(() => win.close());
        return;
      }
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: [t('btn.stopAndClose'), t('btn.cancel')],
        defaultId: 1,
        cancelId: 1,
        title: t('dlg.recClose.title'),
        message: t('dlg.recClose.message'),
      });
      if (choice === 0) void stopRecording(ws).finally(() => win.close());
      return;
    }
    if (ws.forceClose || !ws.dirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: [t('btn.save'), t('btn.dontSave'), t('btn.cancel')],
      defaultId: 0,
      cancelId: 2,
      title: t('dlg.unsaved.title'),
      message: t('dlg.unsaved.closeMessage'),
    });
    if (choice === 0) win.webContents.send('app:saveAndClose');
    else if (choice === 1) {
      ws.forceClose = true;
      win.close();
    }
  });
  win.on('closed', () => {
    ws.exportAbort?.abort();
    windows.delete(id);
    if (lastFocused === ws) lastFocused = [...windows.values()].at(-1) ?? null;
  });
  return ws;
}

/** Brings a window to the front. */
function show(ws: WindowState): void {
  if (ws.win.isMinimized()) ws.win.restore();
  ws.win.focus();
}

/** The window a WAV from outside opens in: the one that has it open, else an idle one, else a new one. */
function openFromOutside(path: string): void {
  const open = [...windows.values()].find((ws) => ws.openedWav?.path === path);
  if (open) return show(open);
  const target = [lastFocused, ...windows.values()].find((ws) => ws && !ws.recording);
  if (!target) {
    createWindow({ file: path });
    return;
  }
  show(target);
  target.win.webContents.send('app:openFile', path);
}

/**
 * Carries out a command-line command in the running app. A recording goes to the window used
 * last if it is idle, else to another idle window, else to a new one, so a recording or unsaved
 * work is never interrupted. A stop goes to every recording window, or the one recording `name`.
 */
function runCommand(command: CliCommand): void {
  if (command.kind === 'record') {
    const target = [lastFocused, ...windows.values()].find((ws) => ws && idle(ws));
    if (!target) {
      createWindow({ command });
      return;
    }
    show(target);
    target.win.webContents.send('app:command', command);
    return;
  }
  if (command.kind !== 'stop') return;
  const recordingWindows = [...windows.values()].filter((ws) => ws.recording);
  const targets = command.name ? recordingWindows.filter((ws) => recordingMatches(ws.recording!.rec.path, command.name!)) : recordingWindows;
  if (!targets.length) {
    console.error(command.name ? `One Take: no recording called ${command.name} is running.` : 'One Take: nothing is being recorded.');
    return;
  }
  for (const ws of targets) ws.win.webContents.send('app:command', command);
}

/** Whether a recording's file is the one `--stop --name` means: the name itself, or that name with a number added. */
function recordingMatches(path: string, name: string): boolean {
  const file = basename(path).toLowerCase();
  const wanted = withWav(name).toLowerCase();
  if (file === wanted) return true;
  const base = wanted.replace(/\.wav$/, '');
  return file.startsWith(`${base} (`) && /^ \(\d+\)\.wav$/.test(file.slice(base.length));
}

function registerIpc(): void {
  ipcMain.handle('dialog:pickWav', async (e) => {
    const result = await dialog.showOpenDialog(stateOf(e.sender).win, {
      title: t('dlg.openWav.title'),
      properties: ['openFile'],
      filters: [{ name: t('dlg.openWav.filter'), extensions: ['wav'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('audio:load', async (e, path: string): Promise<LoadedAudio> => {
    const ws = stateOf(e.sender);
    // One file, one window: two windows would overwrite each other's session.
    const elsewhere = [...windows.values()].find((other) => other !== ws && other.openedWav?.path === resolve(path));
    if (elsewhere) {
      show(elsewhere);
      throw codedError('err.openInOtherWindow', { name: basename(path) });
    }
    const layout = readWavLayout(path);
    const peaks = await loadPeaks(layout, peaksCacheDir(), join(__dirname, 'peaks-worker.cjs'), (fraction) =>
      e.sender.send('audio:loadProgress', fraction),
    );
    ws.openedWav = { ...layout, path: resolve(path) };
    return { info: audioInfo(ws.openedWav, statSync(path).mtimeMs), peaks, project: await loadProject(path) };
  });

  // macOS asks the user once before any app may record; other systems need no permission.
  ipcMain.handle('media:allowMicrophone', () =>
    process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true,
  );

  ipcMain.handle('rec:start', async (e, dir: string, name: string, sampleRate: number, channels: number): Promise<AudioInfo> => {
    const ws = stateOf(e.sender);
    if (ws.recording) throw codedError('err.alreadyRecording');
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
    const marker = join(markerDir(), `${randomUUID()}.json`);
    ws.recording = { rec, blocker: powerSaveBlocker.start('prevent-app-suspension'), started: Date.now(), marker };
    await mkdir(markerDir(), { recursive: true });
    await writeFile(marker, JSON.stringify({ path, sampleRate, channels } satisfies RecordingMarker));
    // A minimized or hidden window must keep passing samples on at full speed.
    ws.win.webContents.setBackgroundThrottling(false);
    ws.openedWav = rec.layout();
    return audioInfo(ws.openedWav, ws.recording.started);
  });
  ipcMain.handle('rec:append', async (e, planes: Float32Array[]): Promise<number> => {
    const ws = stateOf(e.sender);
    const r = ws.recording;
    if (!r) return ws.openedWav?.frames ?? 0;
    const frames = await r.rec.append(planes);
    if (ws.recording === r && ws.openedWav?.path === r.rec.path) ws.openedWav = r.rec.layout();
    return frames;
  });
  ipcMain.handle('rec:stop', (e) => stopRecording(stateOf(e.sender)));

  ipcMain.handle('audio:read', (e, start: number, count: number): Float32Array[] => {
    const wav = stateOf(e.sender).openedWav;
    return wav ? readFrames(wav, start, count) : [];
  });

  ipcMain.handle('project:save', (_e, wavPath: string, project: Project) => saveProject(wavPath, project));
  ipcMain.handle('settings:get', () => loadSettings());
  // The other windows take a change at once, so their next save does not undo it.
  ipcMain.handle('settings:save', async (e, settings: Settings) => {
    await saveSettings(settings);
    applyLanguage(settings);
    broadcast('settings:changed', settings, e.sender);
  });
  ipcMain.handle('shortcuts:get', () => loadShortcutOverrides());
  ipcMain.handle('shortcuts:save', async (e, overrides: Record<string, string[]>) => {
    await saveShortcutOverrides(overrides);
    broadcast('shortcuts:changed', overrides, e.sender);
  });

  ipcMain.handle('dialog:pickFolder', async (e, defaultPath: string | null) => {
    const result = await dialog.showOpenDialog(stateOf(e.sender).win, {
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
    const ws = stateOf(e.sender);
    ws.exportAbort?.abort();
    const abort = new AbortController();
    ws.exportAbort = abort;
    try {
      return await runExport(req, (p) => e.sender.send('export:progress', p), abort.signal);
    } finally {
      if (ws.exportAbort === abort) ws.exportAbort = null;
    }
  });
  ipcMain.handle('export:cancel', (e) => stateOf(e.sender).exportAbort?.abort());

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:state', () => updater?.state ?? { status: 'idle' });
  ipcMain.handle('update:check', () => updater!.check());
  ipcMain.handle('update:install', (e): UpdateState => {
    // The asking window has made sure of its own work; a restart must not cut off another's.
    const busy = [...windows.values()].some((ws) => ws.win.webContents !== e.sender && (ws.recording || ws.exportAbort || ws.dirty));
    if (busy) return { status: 'error', message: t('update.otherWindowBusy') };
    updater!.install();
    return updater!.state;
  });
  ipcMain.handle('update:openDownloadPage', () => updater!.openDownloadPage());
  ipcMain.handle('shell:openProjectLink', (_e, link: 'developer' | 'repository') =>
    shell.openExternal(link === 'developer' ? DEVELOPER_PAGE : REPOSITORY_PAGE));

  ipcMain.on('app:setDirty', (e, value: boolean) => {
    stateOf(e.sender).dirty = value;
  });
  ipcMain.on('app:setTitle', (e, title: string) => stateOf(e.sender).win.setTitle(title));
  ipcMain.on('app:closeNow', (e) => {
    const ws = stateOf(e.sender);
    ws.forceClose = true;
    ws.win.close();
  });
  ipcMain.on('app:toggleDevTools', (e) => e.sender.toggleDevTools());
  ipcMain.on('app:newWindow', () => void createWindow());
  ipcMain.handle('app:takeStartupFile', (e) => {
    const ws = stateOf(e.sender);
    const file = ws.startupFile;
    ws.startupFile = null;
    return file;
  });
  ipcMain.handle('app:takeCommand', (e) => {
    const ws = stateOf(e.sender);
    const command = ws.startupCommand;
    ws.startupCommand = null;
    return command;
  });
  ipcMain.handle('app:takeRecovered', () => {
    const r = recovered;
    recovered = [];
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
  if (windows.size) openFromOutside(path);
  else startupFile = path;
});

// One app, several windows: launching again (a WAV dropped on the icon, a command) hands over
// to the running app instead of starting a second copy. The command goes over already parsed:
// Chromium reorders the arguments it passes on (switches first), which would split "--dir folder".
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
    const command = (additionalData as { command?: CliCommand | null } | null)?.command ?? null;
    if (command?.kind === 'record' || command?.kind === 'stop') return runCommand(command);
    const file = wavFromArgs(argv, workingDirectory);
    if (file) return openFromOutside(file);
    const ws = lastFocused ?? createWindow();
    show(ws);
  });

  // The app is told to quit (shutdown, logout, a kill, Cmd+Q) rather than its windows being
  // closed: recordings are then finished without asking (see the window's close handler).
  app.on('before-quit', () => (quitting = true));

  app.whenReady().then(async () => {
    powerMonitor.on('shutdown', () => void stopAllRecordings());
    await recoverRecordings();
    applyLanguage(await loadSettings());
    Menu.setApplicationMenu(appMenu());
    updater = new Updater((state) => broadcast('update:state', state));
    registerIpc();
    createWindow({ file: startupFile, command: startupCommand });
    startupFile = null;
    const checkForUpdates = () =>
      void loadSettings().then((s) => {
        if (s.checkUpdates) void updater!.check();
      });
    setTimeout(checkForUpdates, UPDATE_CHECK_DELAY_MS);
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  });
}

app.on('window-all-closed', () => void stopAllRecordings().finally(() => app.quit()));
