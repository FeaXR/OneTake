// `window.studio` for the web build: the same calls the preload script makes over Electron IPC,
// sent to the One Take server (src/server/server.ts) over HTTP, with its events as Server-Sent Events.
import type { StudioApi } from '../shared/api.ts';
import { t } from '../shared/i18n/index.ts';
import { DEVELOPER_PAGE, RELEASES_PAGE, REPOSITORY_PAGE } from '../shared/links.ts';
import type { UpdateState } from '../shared/types.ts';
import { CALL_HEADER, type BrowseResult } from '../shared/web.ts';
import { decodeJson, decodePlanes, encodeJson, encodePlanes } from '../shared/wire.ts';
import { browse, uploadWav } from './files.ts';

/** Dropped WAVs are uploaded here, inside the data folder. */
const UPLOADS_FOLDER = 'Uploads';
const headers = { [CALL_HEADER]: '1' };
const dirname = (p: string) => p.replace(/\/[^/]*$/, '');

async function post(route: string, body: BodyInit, keepalive = false): Promise<Response> {
  const res = await fetch(`api/${route}`, { method: 'POST', headers, body, keepalive });
  if (!res.ok) throw new Error((await res.json().catch(() => null) as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  return res;
}

export async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return decodeJson<T>(await (await post(channel, encodeJson(args))).text());
}

/** Sends a file to `dir` on the server; resolves to the path it was saved as (renamed if the name was taken). */
export function upload(file: File, dir: string, onProgress: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader(CALL_HEADER, '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 200) return resolve(decodeJson<string>(xhr.responseText));
      try {
        reject(new Error(decodeJson<{ error: string }>(xhr.responseText).error));
      } catch {
        reject(new Error(`${xhr.status} ${xhr.statusText}`));
      }
    };
    xhr.onerror = () => reject(new Error(t('web.uploadFailed')));
    xhr.send(file);
  });
}

const listeners = new Map<string, Set<(value: never) => void>>();
const events = new EventSource('api/events');

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set());
    events.addEventListener(channel, (e) => {
      const value = decodeJson<never>((e as MessageEvent<string>).data);
      for (const l of listeners.get(channel)!) l(value);
    });
  }
  const set = listeners.get(channel)!;
  set.add(cb as (value: never) => void);
  return () => set.delete(cb as (value: never) => void);
}

let dirty = false;
let recording = false;

// Closing the tab or reloading would lose unsaved edits, or leave a recording without samples.
window.addEventListener('beforeunload', (e) => {
  if (dirty || recording) e.preventDefault();
});
window.addEventListener('pagehide', () => {
  if (recording) void post('rec:stop', '[]', true).catch(() => {});
});

const api: StudioApi = {
  pickWav: () => browse('wav', null),
  droppedFilePath: async (file) => {
    const { root } = await call<BrowseResult>('fs:browse', null);
    return uploadWav(file, `${root}/${UPLOADS_FOLDER}`);
  },
  loadAudio: (path) => call('audio:load', path),
  onLoadProgress: (cb) => subscribe('audio:loadProgress', cb),
  readAudio: async (start, count) =>
    decodePlanes(new Uint8Array(await (await post(`audio:read?start=${start}&count=${count}`, '')).arrayBuffer())),
  // The browser asks for the input itself; it only lets a secure page (HTTPS or localhost) ask.
  allowMicrophone: async () => {
    if (!window.isSecureContext || !navigator.mediaDevices) throw new Error(t('web.needsHttps'));
    return true;
  },
  startRecording: async (dir, name, sampleRate, channels) => {
    const info = await call<Awaited<ReturnType<StudioApi['startRecording']>>>('rec:start', dir, name, sampleRate, channels);
    recording = true;
    return info;
  },
  appendRecording: async (planes) => decodeJson<number>(await (await post('rec:append', encodePlanes(planes))).text()),
  stopRecording: async () => {
    recording = false;
    return call('rec:stop');
  },
  takeStartupFile: async () => null,
  onOpenFile: () => () => {},

  saveProject: (wavPath, project) => call('project:save', wavPath, project),
  getSettings: () => call('settings:get'),
  saveSettings: (settings) => call('settings:save', settings),
  getShortcutOverrides: () => call('shortcuts:get'),
  saveShortcutOverrides: (overrides) => call('shortcuts:save', overrides),

  pickFolder: (defaultPath) => browse('folder', defaultPath),
  existingFiles: (dir, names) => call('fs:existing', dir, names),
  listFiles: (dir) => call('fs:list', dir),
  listFolders: (dir) => call('fs:listFolders', dir),
  showInFolder: async (path) => void (await browse('view', dirname(path))),

  startExport: (req) => call('export:start', req),
  cancelExport: () => call('export:cancel'),
  onExportProgress: (cb) => subscribe('export:progress', cb),

  appVersion: () => call('app:version'),
  getUpdateState: () => call('update:state'),
  checkForUpdates: () => call('update:check'),
  onUpdateState: (cb) => subscribe('update:state', cb),
  // A server is updated by pulling the new image, so a new version is only announced.
  installUpdate: () => call<UpdateState>('update:state'),
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
