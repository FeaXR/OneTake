// `window.studio` for the browser-only build: everything the Electron main process does on the
// desktop, done in the page. WAVs are read from and MP3s written to the browser's own storage
// or folders on the computer (vfs.ts); settings and sessions live in IndexedDB (db.ts). Nothing
// is sent anywhere: the server only hands out these files.
import type { StudioApi } from '../shared/api.ts';
import { exportSegments, type ExportIo } from '../shared/export.ts';
import { codedError, t } from '../shared/i18n/index.ts';
import { APP_VERSION, DEVELOPER_PAGE, RELEASES_PAGE, REPO, REPOSITORY_PAGE } from '../shared/links.ts';
import { mp3Encoder } from '../shared/mp3.ts';
import { FRAMES_PER_BUCKET } from '../shared/peaks.ts';
import { completeSettings, isProject } from '../shared/settings.ts';
import type { AudioInfo, ExportProgress, PeakData, Project, Settings, UpdateState } from '../shared/types.ts';
import { compareVersions } from '../shared/version.ts';
import { decodeFrames, HEADER_BYTES, parseWavLayout, type WavLayout } from '../shared/wav.ts';
import * as db from './db.ts';
import { browse, copyFile, importWav } from './files.ts';
import type { PeaksMessage, PeaksRequest } from './peaks-worker.ts';
import type { RecorderReply, RecorderRequest } from './recorder-worker.ts';
import * as vfs from './vfs.ts';
import mp3Wasm from 'wasm-media-encoders/wasm/mp3?url';

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Recordings into a folder on the computer are written here first, then copied (see startRecording). */
const UNSAVED_FOLDER = 'Recordings in progress';

// ---------- Events ----------

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    emit: (value: T) => listeners.forEach((l) => l(value)),
    on: (cb: (value: T) => void) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  };
}

const loadProgress = emitter<number>();
const exportProgress = emitter<ExportProgress>();
const updateEvents = emitter<UpdateState>();

// ---------- The open WAV ----------

/** Bytes of the open WAV, wherever they are. */
interface Source {
  read(position: number, length: number): Promise<Uint8Array>;
}

const fileSource = (file: Blob): Source => ({
  read: async (position, length) => new Uint8Array(await file.slice(position, position + length).arrayBuffer()),
});

let opened: { layout: WavLayout; source: Source } | null = null;

async function readFrames(start: number, count: number): Promise<Float32Array[]> {
  const o = opened;
  if (!o) return [];
  const { layout } = o;
  const first = Math.max(0, Math.min(layout.frames, Math.floor(start)));
  const frames = Math.max(0, Math.min(layout.frames - first, Math.floor(count)));
  if (!frames) return Array.from({ length: layout.channels }, () => new Float32Array(0));
  const bytes = await o.source.read(layout.dataOffset + first * layout.blockAlign, frames * layout.blockAlign);
  return decodeFrames(layout, bytes);
}

const peaksKey = (path: string, file: File) => `peaks:${path}|${file.size}|${file.lastModified}|${FRAMES_PER_BUCKET}`;

function scanPeaks(file: File, layout: WavLayout): Promise<PeakData> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./peaks-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PeaksMessage>) => {
      const msg = e.data;
      if (msg.type === 'progress') return loadProgress.emit(msg.fraction);
      worker.terminate();
      if (msg.type === 'done') resolve({ framesPerBucket: FRAMES_PER_BUCKET, mins: msg.mins, maxs: msg.maxs });
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The waveform could not be read'));
    };
    worker.postMessage({ file, layout, framesPerBucket: FRAMES_PER_BUCKET } satisfies PeaksRequest);
  });
}

/** The recording's date for names and folders: the original file's for a copied one. */
async function modifiedOf(path: string, file: File): Promise<number> {
  return (await db.get<number>(`modified:${path}`)) ?? file.lastModified;
}

const audioInfo = (layout: WavLayout, modified: number): AudioInfo => {
  const { path, sampleRate, channels, bitsPerSample, sampleFormat, frames, duration } = layout;
  return { path, sampleRate, channels, bitsPerSample, sampleFormat, frames, duration, modified };
};

async function loadAudio(path: string) {
  const file = await vfs.readFile(path);
  const layout = await parseWavLayout(path, file.size, fileSource(file).read);
  let peaks = await db.get<PeakData>(peaksKey(path, file)).catch(() => null);
  if (!peaks) {
    peaks = await scanPeaks(file, layout);
    await db.set(peaksKey(path, file), peaks).catch(() => {});
  }
  opened = { layout, source: fileSource(file) };
  const project = await db.get<Project>(`session:${path}`);
  return { info: audioInfo(layout, await modifiedOf(path, file)), peaks, project: isProject(project) ? project : null };
}

// ---------- Recording ----------

class Recorder {
  private readonly worker = new Worker(new URL('./recorder-worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, (reply: RecorderReply) => void>();
  private next = 1;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<RecorderReply>) => {
      this.pending.get(e.data.id)?.(e.data);
      this.pending.delete(e.data.id);
    };
  }

  call(msg: RecorderRequest, transfer: Transferable[] = []): Promise<RecorderReply> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) => {
        if (reply.code === 'quota') reject(codedError('local.err.quota'));
        else if (reply.error) reject(Object.assign(new Error(reply.error), { code: reply.code }));
        else resolve(reply);
      });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  close(): void {
    this.worker.terminate();
  }
}

let recording: {
  rec: Recorder;
  /** Where the file is written while recording. */
  scratch: string;
  /** Where it ends up: the same, or a folder on the computer it is copied to. */
  target: string;
  started: number;
} | null = null;

function recordingLayout(path: string, sampleRate: number, channels: number, frames: number): WavLayout {
  return {
    path, sampleRate, channels, bitsPerSample: 24, sampleFormat: 'int', frames, duration: frames / sampleRate,
    dataOffset: HEADER_BYTES, dataBytes: frames * channels * 3, blockAlign: channels * 3,
  };
}

async function startRecording(dir: string, name: string, sampleRate: number, channels: number): Promise<AudioInfo> {
  if (recording) throw codedError('err.alreadyRecording');
  const target = vfs.join(dir, vfs.plainName(name));
  await vfs.dirHandle(dir, true);
  if (await vfs.exists(target)) throw codedError('err.recExists', { name });
  // Only the browser's storage can be written in place while the file is read; a recording for
  // a folder on the computer goes there first and is copied when it stops.
  const direct = vfs.split(dir)[0] === vfs.STORAGE_ROOT;
  const scratch = direct ? target : vfs.join(`/${vfs.STORAGE_ROOT}/${UNSAVED_FOLDER}`, await vfs.freeName(`/${vfs.STORAGE_ROOT}/${UNSAVED_FOLDER}`, name));
  const rec = new Recorder();
  try {
    await rec.call({ type: 'start', parts: vfs.split(scratch).slice(1), sampleRate, channels });
  } catch (err) {
    rec.close();
    if ((err as { code?: string }).code === 'exists') throw codedError('err.recExists', { name });
    throw err;
  }
  recording = { rec, scratch, target, started: Date.now() };
  opened = {
    layout: recordingLayout(target, sampleRate, channels, 0),
    source: { read: async (position, length) => (await rec.call({ type: 'read', position, length })).bytes ?? new Uint8Array(0) },
  };
  return audioInfo(opened.layout, recording.started);
}

async function appendRecording(planes: Float32Array[]): Promise<number> {
  const r = recording;
  if (!r) return opened?.layout.frames ?? 0;
  const copies = planes.map((p) => p.slice());
  const { frames = 0 } = await r.rec.call({ type: 'append', planes: copies }, copies.map((p) => p.buffer));
  if (recording === r && opened) opened.layout = { ...opened.layout, frames, duration: frames / opened.layout.sampleRate, dataBytes: frames * opened.layout.blockAlign };
  return frames;
}

async function stopRecording(): Promise<AudioInfo | null> {
  const r = recording;
  if (!r) return null;
  recording = null;
  const reply = await r.rec.call({ type: 'finish' });
  r.rec.close();
  let path = r.target;
  if (r.scratch !== r.target) {
    try {
      await copyFile(await vfs.readFile(r.scratch), r.target, t('local.savingRecording', { name: vfs.nameOf(r.target) }));
      await vfs.removeFile(r.scratch);
    } catch (err) {
      // The recording is safe where it was written; say where.
      path = r.scratch;
      toast(t('local.recordingKept', { dir: vfs.parentOf(r.target), path: r.scratch, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  const file = await vfs.readFile(path);
  const layout = await parseWavLayout(path, file.size, fileSource(file).read);
  if (reply.peaks) await db.set(peaksKey(path, file), reply.peaks).catch(() => {});
  if (opened?.layout.path === r.target) opened = { layout, source: fileSource(file) };
  return audioInfo(layout, r.started);
}

/** Toasts from here would load the dialogs early; this one is rare enough to load on demand. */
function toast(message: string): void {
  void import('../renderer/dialogs.ts').then((d) => d.toast(message, 'error', 15000));
}

// ---------- Export ----------

let exportAbort: AbortController | null = null;

/** Lets the page draw between blocks; unlike setTimeout it is not slowed down in a hidden tab. */
function pause(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

const exportIo: ExportIo = {
  read: readFrames,
  create: async (dir, filename) => {
    await vfs.dirHandle(dir, true);
    const out = await vfs.createWritable(vfs.join(dir, filename));
    const full = (err: unknown) => {
      throw vfs.storageError(err);
    };
    return {
      write: (bytes) => out.write(bytes as Uint8Array<ArrayBuffer>).catch(full),
      close: () => out.close().catch(full),
      abort: () => out.abort(),
    };
  },
  encoder: (sampleRate, channels, bitrate) => mp3Encoder(sampleRate, channels, bitrate, new URL(mp3Wasm, location.href).href),
  pause,
};

// ---------- Updates ----------

let update: UpdateState = { status: 'idle' };

function setUpdate(state: UpdateState): UpdateState {
  update = state;
  updateEvents.emit(state);
  return state;
}

/** Looks for a newer release on GitHub. The page is updated with the image that serves it, so it is only announced. */
async function checkForUpdates(): Promise<UpdateState> {
  setUpdate({ status: 'checking' });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
    const latest = String(((await res.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/i, '');
    return setUpdate(latest && compareVersions(latest, APP_VERSION) > 0 ? { status: 'available', version: latest } : { status: 'none' });
  } catch (err) {
    return setUpdate({ status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

// ---------- Settings ----------

async function getSettings(): Promise<Settings> {
  const s = completeSettings(await db.get<Partial<Settings>>('settings').catch(() => null));
  // Recordings go to the browser's storage until another folder is chosen.
  if (!s.recordFolder) s.recordFolder = `/${vfs.STORAGE_ROOT}`;
  return s;
}

// ---------- The page ----------

let dirty = false;

// Closing the tab or reloading would lose unsaved edits, or stop a recording.
window.addEventListener('beforeunload', (e) => {
  if (dirty || recording) e.preventDefault();
});

/**
 * A file dropped on the page, as a handle (Chromium only), taken while the drop event lasts.
 * The app's own drop listener runs after this one and asks for the path.
 */
let droppedHandle: Promise<FileSystemHandle | null> | null = null;
document.addEventListener('drop', (e) => {
  const item = e.dataTransfer?.items[0] as (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }) | undefined;
  droppedHandle = item?.getAsFileSystemHandle?.() ?? null;
}, true);

async function droppedFilePath(file: File): Promise<string | null> {
  const handle = await droppedHandle?.catch(() => null);
  droppedHandle = null;
  if (handle?.kind === 'file') {
    const path = await vfs.locate(handle as FileSystemFileHandle);
    if (path) return path;
  }
  return importWav(file);
}

const api: StudioApi = {
  pickWav: () => browse('wav', null),
  droppedFilePath,
  loadAudio,
  onLoadProgress: loadProgress.on,
  readAudio: readFrames,
  // The browser asks for the input itself; it only lets a secure page (HTTPS or localhost) ask.
  allowMicrophone: async () => {
    if (!window.isSecureContext || !navigator.mediaDevices) throw new Error(t('web.needsHttps'));
    return true;
  },
  startRecording,
  appendRecording,
  stopRecording,
  takeStartupFile: async () => null,
  onOpenFile: () => () => {},

  saveProject: (wavPath, project) => db.set(`session:${wavPath}`, { wavPath, ...project }),
  getSettings,
  saveSettings: (settings) => db.set('settings', settings),
  getShortcutOverrides: async () => (await db.get<Record<string, string[]>>('shortcuts')) ?? {},
  saveShortcutOverrides: (overrides) => db.set('shortcuts', overrides),

  pickFolder: (defaultPath) => browse('folder', defaultPath),
  existingFiles: async (dir, names) => {
    const there = new Set((await vfs.list(dir)).files.map((f) => f.name));
    return names.filter((n) => there.has(n));
  },
  listFiles: async (dir) => (await vfs.list(dir)).files.map((f) => f.name),
  listFolders: async (dir) => (await vfs.list(dir)).folders,
  showInFolder: async (path) => void (await browse('view', vfs.parentOf(path))),
  openFolder: async (dir) => void (await browse('view', dir)),

  startExport: async (req) => {
    if (!opened || opened.layout.path !== req.wavPath) throw codedError('local.err.notOpen');
    exportAbort?.abort();
    const abort = new AbortController();
    exportAbort = abort;
    try {
      return await exportSegments(req, opened.layout, exportIo, exportProgress.emit, abort.signal);
    } finally {
      if (exportAbort === abort) exportAbort = null;
    }
  },
  cancelExport: async () => exportAbort?.abort(),
  onExportProgress: exportProgress.on,

  appVersion: async () => APP_VERSION,
  getUpdateState: async () => update,
  checkForUpdates,
  onUpdateState: updateEvents.on,
  installUpdate: async () => update,
  openDownloadPage: async () => void window.open(RELEASES_PAGE, '_blank', 'noopener'),
  openProjectLink: async (link) => void window.open(link === 'developer' ? DEVELOPER_PAGE : REPOSITORY_PAGE, '_blank', 'noopener'),

  setDirty: (value) => {
    dirty = value;
  },
  setTitle: (title) => {
    document.title = title;
  },
  onSaveAndClose: () => () => {},
  closeNow: () => {},
  toggleDevTools: () => {},
};

window.studio = api;

const checkIfEnabled = () => void getSettings().then((s) => {
  if (s.checkUpdates) void checkForUpdates();
});
setTimeout(checkIfEnabled, 3000);
setInterval(checkIfEnabled, UPDATE_CHECK_INTERVAL_MS);

// After the first visit the page also opens without a connection to the server.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  void navigator.serviceWorker.register('sw.js').then(async () => {
    // The files this visit loaded before the worker ran are kept for the next one too.
    const ready = await navigator.serviceWorker.ready;
    const own = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => new URL(u).origin === location.origin);
    ready.active?.postMessage({ keep: [location.href.replace(/#.*$/, ''), ...own] });
  }).catch(() => {});
}

// Browsers keep files and folders only for pages on a secure connection.
if (!window.isSecureContext) setTimeout(() => toast(t('local.err.insecure')), 1000);
