// The folders the browser-only build can read and write, as paths like the desktop app's:
// "/<root>/<folder>/<file>". The first root is the browser's own storage for this site (the
// origin private file system), which every current browser has. Chromium-based browsers can
// also be given folders on the computer; each becomes a root of its own, by its name.
import { codedError } from '../shared/i18n/index.ts';
import * as db from './db.ts';

/** The browser's own storage, always there. A name of its own, so paths never change meaning. */
export const STORAGE_ROOT = 'One Take';
/** Hidden folder in the browser's storage for recordings into a folder on the computer. */
export const SCRATCH_FOLDER = '.recording';

interface PermissionHandle {
  queryPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

export interface Root {
  name: string;
  handle: FileSystemDirectoryHandle;
  /** True for a folder on the computer, false for the browser's storage. */
  onDisk: boolean;
}

export interface Listing {
  folders: string[];
  files: { name: string; size: number }[];
}

const ROOT_KEY = 'root:';

/** Only Chromium-based browsers let a page use a folder on the computer. */
export const canUseDiskFolders = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function' && window.isSecureContext;

let storageRoot: Promise<FileSystemDirectoryHandle> | null = null;

function storage(): Promise<FileSystemDirectoryHandle> {
  storageRoot ??= (async () => {
    if (!navigator.storage?.getDirectory) throw codedError('local.err.noStorage');
    // Asks the browser not to clear the storage when the disk runs low (it may still say no).
    void navigator.storage.persist?.().catch(() => false);
    return navigator.storage.getDirectory();
  })();
  return storageRoot;
}

export async function roots(): Promise<Root[]> {
  const list: Root[] = [{ name: STORAGE_ROOT, handle: await storage(), onDisk: false }];
  for (const key of (await db.keys(ROOT_KEY)).sort()) {
    const handle = await db.get<FileSystemDirectoryHandle>(key);
    if (handle) list.push({ name: key.slice(ROOT_KEY.length), handle, onDisk: true });
  }
  return list;
}

/** Asks for a folder on the computer and adds it as a root; resolves to its path, or null when cancelled. */
export async function addDiskFolder(): Promise<string | null> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker!({ id: 'one-take', mode: 'readwrite' });
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') return null;
    throw err;
  }
  const existing = await roots();
  for (const r of existing) if (r.onDisk && (await r.handle.isSameEntry(handle))) return `/${r.name}`;
  const taken = new Set(existing.map((r) => r.name.toLowerCase()));
  let name = handle.name || 'Folder';
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${handle.name} (${i})`;
  await db.set(ROOT_KEY + name, handle);
  return `/${name}`;
}

/** Forgets a folder on the computer (its files stay where they are). */
export async function removeDiskFolder(name: string): Promise<void> {
  await db.remove(ROOT_KEY + name);
}

/** The parts of a path: its root's name first. Empty for "/" (the list of roots). */
export function split(path: string): string[] {
  return path.split('/').filter((p) => p && p !== '.');
}

export const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;
export const parentOf = (path: string) => path.replace(/\/[^/]*\/?$/, '') || '/';
export const nameOf = (path: string) => path.replace(/\/+$/, '').replace(/^.*\//, '');

/** A single file or folder name; anything with a separator or `..` could leave its folder. */
export function plainName(name: string): string {
  const n = name.trim();
  if (!n || /[\\/]/.test(n) || n === '.' || n === '..') throw codedError('local.err.badName', { name });
  return n;
}

/**
 * Makes sure the page may write to a folder on the computer. The browser asks the user again
 * after a restart; it only asks while the user is clicking or typing, so the first use after a
 * restart may need a second click.
 */
async function allow(root: Root): Promise<void> {
  if (!root.onDisk) return;
  const h = root.handle as unknown as PermissionHandle;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return;
  let state: PermissionState = 'prompt';
  try {
    state = await h.requestPermission({ mode: 'readwrite' });
  } catch {
    // Not asked: no click or key press just happened.
  }
  if (state !== 'granted') throw codedError('local.err.permission', { name: root.name });
}

/** True when a folder on the computer can be used without asking the user first. */
export async function allowed(root: Root): Promise<boolean> {
  return !root.onDisk || (await (root.handle as unknown as PermissionHandle).queryPermission({ mode: 'readwrite' })) === 'granted';
}

/** Asks for permission while the user is clicking; resolves to whether it was given. */
export async function askPermission(root: Root): Promise<boolean> {
  try {
    await allow(root);
    return true;
  } catch {
    return false;
  }
}

async function rootOf(path: string): Promise<{ root: Root; parts: string[] }> {
  const [name, ...parts] = split(path);
  const root = (await roots()).find((r) => r.name === name);
  if (!root) throw codedError('local.err.noFolder', { dir: path });
  await allow(root);
  return { root, parts };
}

export async function dirHandle(path: string, create = false): Promise<FileSystemDirectoryHandle> {
  const { root, parts } = await rootOf(path);
  let dir = root.handle;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch (err) {
      if ((err as DOMException).name === 'NotFoundError' || (err as DOMException).name === 'TypeMismatchError') {
        throw codedError('local.err.noFolder', { dir: path });
      }
      throw err;
    }
  }
  return dir;
}

export async function fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
  const dir = await dirHandle(parentOf(path), create);
  try {
    return await dir.getFileHandle(nameOf(path), { create });
  } catch (err) {
    if ((err as DOMException).name === 'NotFoundError' || (err as DOMException).name === 'TypeMismatchError') {
      throw codedError('local.err.noFile', { name: nameOf(path) });
    }
    throw err;
  }
}

export async function readFile(path: string): Promise<File> {
  return (await fileHandle(path)).getFile();
}

/** Hidden entries (and Chromium's .crswap files of writes in progress) are left out. */
const visible = (name: string) => !name.startsWith('.') && !name.endsWith('.crswap');

/** What a folder holds; empty when it does not exist. */
export async function list(path: string): Promise<Listing> {
  const out: Listing = { folders: [], files: [] };
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await dirHandle(path);
  } catch {
    return out;
  }
  for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (!visible(entry.name)) continue;
    if (entry.kind === 'directory') out.folders.push(entry.name);
    else out.files.push({ name: entry.name, size: (await (entry as FileSystemFileHandle).getFile()).size });
  }
  const order = (a: string, b: string) => a.localeCompare(b);
  out.folders.sort(order);
  out.files.sort((a, b) => order(a.name, b.name));
  return out;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fileHandle(path);
    return true;
  } catch {
    return false;
  }
}

export async function makeFolder(dir: string, name: string): Promise<string> {
  const path = join(dir, plainName(name));
  await dirHandle(path, true);
  return path;
}

/**
 * A file being written. Chromium writes to a temporary file that takes the real name only on
 * close(), so a cancelled or failed write leaves the old file (or none) in place.
 */
export async function createWritable(path: string): Promise<FileSystemWritableFileStream> {
  return (await fileHandle(path, true)).createWritable();
}

export async function removeFile(path: string): Promise<void> {
  await (await dirHandle(parentOf(path))).removeEntry(nameOf(path));
}

/** A full storage, as a message that says what to do about it. */
export function storageError(err: unknown): unknown {
  return (err as DOMException)?.name === 'QuotaExceededError' ? codedError('local.err.quota') : err;
}

/** A name in `dir` that is not taken yet: "take.wav", then "take (2).wav", … */
export async function freeName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const taken = new Set((await list(dir)).files.map((f) => f.name.toLowerCase()));
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The path of a file dropped on the page when it lies in one of the roots (Chromium only). */
export async function locate(handle: FileSystemFileHandle): Promise<string | null> {
  for (const root of await roots()) {
    if (!(await allowed(root))) continue;
    const parts = await root.handle.resolve(handle).catch(() => null);
    if (parts) return `/${[root.name, ...parts].join('/')}`;
  }
  return null;
}
