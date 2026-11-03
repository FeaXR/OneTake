// One Take as a web app: serves the renderer to a browser and does what the Electron main
// process does on the desktop, over HTTP. Everything it reads or writes stays inside the data
// folder (ONETAKE_DATA_DIR); settings, sessions and the peaks cache live in ONETAKE_CONFIG_DIR.
// One user at a time: like the desktop app it holds one open WAV, recording and export.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { codedError } from '../shared/i18n/index.ts';
import { APP_VERSION, REPO } from '../shared/links.ts';
import type { AudioInfo, ExportRequest, LoadedAudio, Project, Settings, UpdateState } from '../shared/types.ts';
import { outputFilename } from '../shared/validate.ts';
import { compareVersions } from '../shared/version.ts';
import { decodeJson, decodePlanes, encodeJson, encodePlanes } from '../shared/wire.ts';
import { CALL_HEADER, type BrowseResult } from '../shared/web.ts';
import { runExport } from '../main/exporter.ts';
import { loadPeaks, savePeaks } from '../main/peaks.ts';
import { WavRecorder } from '../main/recorder.ts';
import {
  configureStore, loadProject, loadSettings, loadShortcutOverrides, peaksCacheDir, saveProject, saveSettings, saveShortcutOverrides,
} from '../main/store.ts';
import { readFrames, readWavLayout, type WavLayout } from '../main/wav.ts';

const DATA_DIR = resolve(process.env.ONETAKE_DATA_DIR ?? join(process.cwd(), 'data'));
const CONFIG_DIR = resolve(process.env.ONETAKE_CONFIG_DIR ?? join(DATA_DIR, '.one-take'));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
/** When set, the browser asks for it (any user name) before showing anything. */
const PASSWORD = process.env.ONETAKE_PASSWORD ?? '';
const TLS_CERT = process.env.ONETAKE_TLS_CERT;
const TLS_KEY = process.env.ONETAKE_TLS_KEY;
const WEB_DIR = join(__dirname, '..', 'web');
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** A recording left without a page sending it samples is finished after this long. */
const ORPHAN_RECORDING_MS = 5000;

configureStore({ userData: CONFIG_DIR, sessions: join(CONFIG_DIR, 'Sessions') });

let openedWav: WavLayout | null = null;
let recording: { rec: WavRecorder; started: number } | null = null;
let exportAbort: AbortController | null = null;
let update: UpdateState = { status: 'idle' };

// ---------- Paths ----------

const dataRoot = (() => {
  mkdirSync(DATA_DIR, { recursive: true });
  return realpathSync(DATA_DIR);
})();

const within = (path: string) => path === dataRoot || path.startsWith(dataRoot + sep);

/**
 * The path, absolute, when it lies in the data folder; throws otherwise. Links are followed
 * as far as the path exists, so a symlink cannot lead out of the folder either.
 */
function safePath(path: unknown): string {
  if (typeof path !== 'string' || !path) throw new Error('No path given');
  const full = resolve(dataRoot, path);
  let existing = full;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const real = join(realpathSync(existing), full.slice(existing.length));
  if (!within(full) || !within(real)) throw new Error(`${path} is outside the data folder`);
  return full;
}

// ---------- Events (Server-Sent Events) ----------

const clients = new Set<ServerResponse>();
let orphanTimer: NodeJS.Timeout | null = null;

function broadcast(event: string, value: unknown): void {
  const message = `event: ${event}\ndata: ${encodeJson(value)}\n\n`;
  for (const res of clients) res.write(message);
}

function openEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': hello\n\n');
  clients.add(res);
  if (orphanTimer) clearTimeout(orphanTimer);
  orphanTimer = null;
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    // No page is left to send samples: finish the file with what it has, as the desktop app does.
    if (!clients.size && recording) orphanTimer = setTimeout(() => void stopRecording(), ORPHAN_RECORDING_MS);
  });
}

// ---------- What the desktop main process does ----------

function audioInfo(layout: WavLayout, modified: number): AudioInfo {
  const { path, sampleRate, channels, bitsPerSample, sampleFormat, frames, duration } = layout;
  return { path, sampleRate, channels, bitsPerSample, sampleFormat, frames, duration, modified };
}

async function stopRecording(): Promise<AudioInfo | null> {
  const r = recording;
  if (!r) return null;
  recording = null;
  const layout = await r.rec.finish();
  if (openedWav?.path === layout.path) openedWav = layout;
  await savePeaks(layout.path, peaksCacheDir(), r.rec.peakData());
  return audioInfo(layout, r.started);
}

function setUpdate(state: UpdateState): UpdateState {
  update = state;
  broadcast('update:state', state);
  return state;
}

/** The server cannot replace itself: a newer release is announced, and pulled as a new image. */
async function checkForUpdates(): Promise<UpdateState> {
  setUpdate({ status: 'checking' });
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OneTake' },
    });
    if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
    const latest = String((await res.json() as { tag_name?: string }).tag_name ?? '').replace(/^v/i, '');
    return setUpdate(latest && compareVersions(latest, APP_VERSION) > 0 ? { status: 'available', version: latest } : { status: 'none' });
  } catch (err) {
    return setUpdate({ status: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

async function listDir(dir: string, folders: boolean): Promise<string[]> {
  try {
    const entries = await readdir(safePath(dir), { withFileTypes: true });
    return entries.filter((d) => !folders || d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** A name for an uploaded file that is not taken yet: "take.wav", then "take (2).wav", … */
function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/** A single file or folder name; anything with a separator or `..` could leave its folder. */
function plainName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error(`"${String(name)}" is not a valid name`);
  }
  return name.trim();
}

type Handler = (...args: never[]) => unknown;

/** The same channels the preload script uses, plus the web build's own file browser. */
const handlers: Record<string, Handler> = {
  'audio:load': async (path: string): Promise<LoadedAudio> => {
    const full = safePath(path);
    const layout = readWavLayout(full);
    const peaks = await loadPeaks(layout, peaksCacheDir(), join(__dirname, 'peaks-worker.cjs'), (fraction) =>
      broadcast('audio:loadProgress', fraction));
    openedWav = { ...layout, path: full };
    return { info: audioInfo(openedWav, statSync(full).mtimeMs), peaks, project: await loadProject(full) };
  },
  'rec:start': async (dir: string, name: string, sampleRate: number, channels: number): Promise<AudioInfo> => {
    if (recording) throw codedError('err.alreadyRecording');
    const path = safePath(join(safePath(dir), plainName(name)));
    let rec: WavRecorder;
    try {
      rec = await WavRecorder.create(path, sampleRate, channels);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw codedError('err.recExists', { name });
      throw err;
    }
    recording = { rec, started: Date.now() };
    openedWav = rec.layout();
    return audioInfo(openedWav, recording.started);
  },
  'rec:stop': () => stopRecording(),
  'project:save': (wavPath: string, project: Project) => saveProject(safePath(wavPath), project),
  'settings:get': () => loadSettings(),
  'settings:save': (settings: Settings) => saveSettings(settings),
  'shortcuts:get': () => loadShortcutOverrides(),
  'shortcuts:save': (overrides: Record<string, string[]>) => saveShortcutOverrides(overrides),
  'fs:list': (dir: string) => listDir(dir, false),
  'fs:listFolders': (dir: string) => listDir(dir, true),
  'fs:existing': (dir: string, names: string[]) => {
    const base = safePath(dir);
    return names.filter((n) => existsSync(safePath(join(base, n))));
  },
  'fs:browse': async (dir: string | null): Promise<BrowseResult> => {
    let path = dataRoot;
    try {
      if (dir) path = safePath(dir);
    } catch {
      // A folder from settings that is not on this server: start at the top instead.
    }
    while (path !== dataRoot && !(existsSync(path) && statSync(path).isDirectory())) path = dirname(path);
    const entries = await readdir(path, { withFileTypes: true });
    const visible = entries.filter((d) => !d.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    return {
      root: dataRoot,
      dir: path,
      folders: visible.filter((d) => d.isDirectory()).map((d) => d.name),
      files: visible.filter((d) => d.isFile()).map((d) => ({ name: d.name, size: statSync(join(path, d.name)).size })),
    };
  },
  'fs:mkdir': async (dir: string, name: string): Promise<string> => {
    const path = safePath(join(safePath(dir), plainName(name)));
    await mkdir(path, { recursive: true });
    return path;
  },
  'export:start': async (req: ExportRequest) => {
    safePath(req.wavPath);
    for (const seg of req.segments) safePath(join(safePath(seg.outputDir), outputFilename(seg.filename)));
    exportAbort?.abort();
    const abort = new AbortController();
    exportAbort = abort;
    try {
      return await runExport(req, (p) => broadcast('export:progress', p), abort.signal);
    } finally {
      if (exportAbort === abort) exportAbort = null;
    }
  },
  'export:cancel': () => exportAbort?.abort(),
  'app:version': () => APP_VERSION,
  'update:state': () => update,
  'update:check': () => checkForUpdates(),
};

// ---------- HTTP ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: string | Uint8Array, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  if (!PASSWORD) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), 'base64').toString('utf8').replace(/^[^:]*:/, ''));
  const expected = Buffer.from(PASSWORD);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function serveStatic(url: URL, res: ServerResponse): void {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
  // Built assets have a hash in their name and never change; the page itself is always fetched fresh.
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="One Take", charset="UTF-8"' });
    return void res.end();
  }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(url, res);
  }
  const route = url.pathname.slice('/api/'.length);
  if (route === 'events') return openEvents(req, res);
  if (route === 'download') {
    const path = safePath(url.searchParams.get('path'));
    if (!existsSync(path) || !statSync(path).isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': statSync(path).size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
    });
    return void createReadStream(path).pipe(res);
  }
  if (!req.headers[CALL_HEADER.toLowerCase()]) return send(res, 403, encodeJson({ error: 'Missing call header' }));
  if (req.method === 'PUT' && route === 'upload') {
    const dir = safePath(url.searchParams.get('dir'));
    const name = plainName(url.searchParams.get('name'));
    if (!/\.wav$/i.test(name)) throw codedError('toast.onlyWav');
    await mkdir(dir, { recursive: true });
    const path = join(dir, freeName(dir, name));
    try {
      await pipeline(req, createWriteStream(path, { flags: 'wx' }));
    } catch (err) {
      await rm(path, { force: true });
      throw err;
    }
    return send(res, 200, encodeJson(path));
  }
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed', 'text/plain');
  if (route === 'audio:read') {
    const start = Number(url.searchParams.get('start'));
    const count = Number(url.searchParams.get('count'));
    return send(res, 200, encodePlanes(openedWav ? readFrames(openedWav, start, count) : []), 'application/octet-stream');
  }
  if (route === 'rec:append') {
    const planes = decodePlanes(await readBody(req));
    const r = recording;
    if (!r) return send(res, 200, encodeJson(openedWav?.frames ?? 0));
    const frames = await r.rec.append(planes);
    if (recording === r && openedWav?.path === r.rec.path) openedWav = r.rec.layout();
    return send(res, 200, encodeJson(frames));
  }
  const handler = handlers[route] as ((...args: unknown[]) => unknown) | undefined;
  if (!handler) return send(res, 404, encodeJson({ error: `Unknown call ${route}` }));
  const args = decodeJson<unknown[]>((await readBody(req)).toString('utf8') || '[]');
  send(res, 200, encodeJson(await handler(...args)));
}

function onRequest(req: IncomingMessage, res: ServerResponse): void {
  handle(req, res).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) send(res, 500, encodeJson({ error: message }));
    else res.destroy();
  });
}

const server = TLS_CERT && TLS_KEY
  ? createHttpsServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, onRequest)
  : createHttpServer(onRequest);

server.listen(PORT, HOST, () => {
  console.log(`One Take ${APP_VERSION} on ${TLS_CERT && TLS_KEY ? 'https' : 'http'}://${HOST}:${PORT}`);
  console.log(`Data folder: ${dataRoot}, settings: ${CONFIG_DIR}${PASSWORD ? ', password required' : ''}`);
});

const checkIfEnabled = () => void loadSettings().then((s) => {
  if (s.checkUpdates) void checkForUpdates();
});
setTimeout(checkIfEnabled, 3000);
setInterval(checkIfEnabled, UPDATE_CHECK_INTERVAL_MS);

// `docker stop` sends SIGTERM: a recording in progress is finished properly first.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    exportAbort?.abort();
    void stopRecording().finally(() => process.exit(0));
  });
}
