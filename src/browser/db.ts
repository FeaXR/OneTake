// What the desktop app keeps in files (settings, shortcuts, sessions, the peaks cache, the
// folders it may use), kept in the browser's IndexedDB by the browser-only build.

const DB_NAME = 'one-take';
const STORE = 'kv';

let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error('IndexedDB is not available'));
    };
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, job: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return database().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = job(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('Aborted'));
  }));
}

/** The value under `key`, or null. Keys are grouped by prefix: "settings", "session:<path>", … */
export async function get<T>(key: string): Promise<T | null> {
  return ((await run<T | undefined>('readonly', (s) => s.get(key))) ?? null);
}

export async function set(key: string, value: unknown): Promise<void> {
  await run('readwrite', (s) => s.put(value, key));
}

export async function remove(key: string): Promise<void> {
  await run('readwrite', (s) => s.delete(key));
}

/** Every key starting with `prefix`. */
export async function keys(prefix: string): Promise<string[]> {
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  return (await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys(range))).map(String);
}
