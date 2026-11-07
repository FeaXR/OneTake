// The browser-only build's stand-in for the system file dialogs: the browser's own storage and
// the folders on the computer it was given (see vfs.ts), with downloads for what is in them.
import { t, translateCodes } from '../shared/i18n/index.ts';
import { choose, openModal, showLoading, toast } from '../renderer/dialogs.ts';
import { h, pathText } from '../renderer/dom.ts';
import * as db from './db.ts';
import * as vfs from './vfs.ts';

type Mode = 'wav' | 'folder' | 'view';

const errorText = (err: unknown) => translateCodes(err instanceof Error ? err.message : String(err));
/** Where the last dialog was, so the next one opens there. */
let lastDir: string | null = null;

/** Imported WAVs (opened from elsewhere on the computer) are copied here. */
export const IMPORT_FOLDER = `/${vfs.STORAGE_ROOT}/Imported`;

function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** Saves a file from the browser's storage (or a folder) to the user's Downloads. */
async function download(path: string): Promise<void> {
  const file = await vfs.readFile(path);
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Shows the folder `start` (or the last one). 'wav' resolves to the WAV chosen, 'folder' to
 * the folder chosen, 'view' lists the files with downloads; null when closed.
 */
export function browse(mode: Mode, start: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const title = mode === 'wav' ? t('dlg.openWav.title') : mode === 'folder' ? t('dlg.folder.title') : t('local.files.title');
    const m = openModal(title, { wide: true, onClose: () => resolve(result) });
    const finish = (value: string) => {
      result = value;
      m.close();
    };

    const where = h('div', { class: 'folder-path' });
    const list = h('div', { class: 'file-browser' });
    const note = h('div', { class: 'form-note' });
    const nameInput = h('input', { type: 'text', placeholder: t('web.folderName') });
    const newRow = h('form', { class: 'folder-row hidden' }, nameInput, h('button', { type: 'submit' }, t('web.create')));
    m.body.append(where, list, newRow, note);
    let current = '/';

    const row = (label: string, detail: string, onclick: () => void, cls = '', extra?: HTMLElement) =>
      h('div', { class: 'file-line' },
        h('button', { type: 'button', class: `file-row ${cls}`, onclick }, h('span', {}, label), h('span', { class: 'form-note' }, detail)),
        extra);
    const iconButton = (label: string, onclick: () => void) =>
      h('button', { type: 'button', class: 'file-action', title: label, 'aria-label': label, onclick }, '×');

    const newFolderBtn = h('button', {
      onclick: () => {
        newRow.classList.toggle('hidden');
        nameInput.focus();
      },
    }, t('web.newFolder'));
    const chooseBtn = h('button', { class: 'primary', onclick: () => current !== '/' && finish(current) }, t('web.chooseFolder'));

    async function showRoots(): Promise<void> {
      current = '/';
      where.textContent = '/';
      where.title = '';
      note.textContent = vfs.canUseDiskFolders() ? '' : t('local.noDiskFolders');
      newFolderBtn.disabled = true;
      chooseBtn.disabled = true;
      list.replaceChildren();
      for (const root of await vfs.roots()) {
        const ok = await vfs.allowed(root);
        const detail = root.onDisk ? (ok ? t('local.disk') : t('local.allow')) : t('local.storage');
        const open = async () => {
          if (!(await vfs.askPermission(root))) return toast(t('local.err.permission', { name: root.name }), 'error');
          await show(`/${root.name}`);
        };
        const forget = root.onDisk && iconButton(t('local.forget'), () => void vfs.removeDiskFolder(root.name).then(showRoots));
        list.append(row(`${root.name}/`, detail, () => void open(), 'folder', forget || undefined));
      }
    }

    async function show(dir: string | null): Promise<void> {
      if (!dir || dir === '/') return showRoots();
      let listing: vfs.Listing;
      try {
        await vfs.dirHandle(dir);
        listing = await vfs.list(dir);
      } catch {
        // A folder that is gone (or not allowed yet): the one above it, up to the list of roots.
        return show(vfs.parentOf(dir) === dir ? '/' : vfs.parentOf(dir));
      }
      current = dir;
      lastDir = dir;
      where.textContent = pathText(dir);
      where.title = dir;
      newFolderBtn.disabled = false;
      chooseBtn.disabled = false;
      const inStorage = vfs.split(dir)[0] === vfs.STORAGE_ROOT;
      note.textContent = mode === 'view' && inStorage ? t('local.storageNote') : '';
      list.replaceChildren(row('..', '', () => void show(vfs.parentOf(dir)), 'folder'));
      for (const name of listing.folders) list.append(row(`${name}/`, '', () => void show(vfs.join(dir, name)), 'folder'));
      const files = mode === 'folder' ? [] : mode === 'wav' ? listing.files.filter((f) => /\.wav$/i.test(f.name)) : listing.files;
      for (const f of files) {
        const path = vfs.join(dir, f.name);
        if (mode === 'wav') {
          list.append(row(f.name, sizeText(f.size), () => finish(path)));
          continue;
        }
        // Files in the browser's storage can only be taken out by downloading them, or deleted.
        const remove = inStorage && iconButton(t('local.delete'), async () => {
          const answer = await choose(t('local.delete'), t('local.deleteConfirm', { name: f.name }), [
            { label: t('btn.cancel'), value: 'cancel' },
            { label: t('local.delete'), value: 'delete', primary: true },
          ], 'cancel');
          if (answer !== 'delete') return;
          await vfs.removeFile(path).catch((err: unknown) => toast(errorText(err), 'error'));
          await show(dir);
        });
        list.append(row(f.name, sizeText(f.size), () => void download(path).catch((err: unknown) => toast(errorText(err), 'error')), '', remove || undefined));
      }
      if (!listing.folders.length && !files.length) list.append(h('div', { class: 'form-note' }, t('web.empty')));
    }

    newRow.addEventListener('submit', (e) => {
      e.preventDefault();
      if (current === '/' || !nameInput.value.trim()) return;
      void vfs.makeFolder(current, nameInput.value).then(
        (path) => {
          nameInput.value = '';
          newRow.classList.add('hidden');
          return show(path);
        },
        (err: unknown) => toast(errorText(err), 'error'),
      );
    });

    if (vfs.canUseDiskFolders()) {
      m.foot.append(h('button', {
        onclick: () => void vfs.addDiskFolder().then((path) => (path ? show(path) : undefined), (err: unknown) => toast(errorText(err), 'error')),
      }, t('local.addFolder')));
    }
    if (mode === 'wav') {
      m.foot.append(h('button', {
        onclick: () => void pickComputerWav().then((path) => path && finish(path)),
      }, t('local.openFile')));
    }
    if (mode !== 'view') m.foot.append(newFolderBtn);
    m.foot.append(h('button', { onclick: () => m.close() }, mode === 'view' ? t('btn.close') : t('btn.cancel')));
    if (mode === 'folder') m.foot.append(chooseBtn);

    void show(start ?? lastDir ?? `/${vfs.STORAGE_ROOT}`);
  });
}

/**
 * Lets the user pick a WAV anywhere on the computer. One inside a folder One Take was given is
 * opened where it is; any other is copied into the browser's storage first (as the Docker
 * build uploads it), so it can be opened again later.
 */
async function pickComputerWav(): Promise<string | null> {
  const picker = (window as unknown as { showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
  if (picker && window.isSecureContext) {
    let handle: FileSystemFileHandle;
    try {
      [handle] = await picker({ id: 'one-take-wav', types: [{ description: t('dlg.openWav.filter'), accept: { 'audio/wav': ['.wav'] } }] });
    } catch {
      return null;
    }
    return (await vfs.locate(handle)) ?? importWav(await handle.getFile());
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = h('input', { type: 'file', accept: '.wav,audio/wav' });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
  return file && importWav(file);
}

/**
 * Copies a WAV into the browser's storage (Imported), showing progress; resolves to its path
 * there. A file of the same name and size that is already there is used as it is.
 */
export async function importWav(file: File): Promise<string | null> {
  if (!/\.wav$/i.test(file.name)) {
    toast(t('toast.onlyWav'), 'error');
    return null;
  }
  try {
    const same = (await vfs.list(IMPORT_FOLDER)).files.find((f) => f.name === file.name && f.size === file.size);
    if (same) return vfs.join(IMPORT_FOLDER, same.name);
    await vfs.dirHandle(IMPORT_FOLDER, true);
    const path = vfs.join(IMPORT_FOLDER, await vfs.freeName(IMPORT_FOLDER, file.name));
    await copyFile(file, path, t('local.copying', { name: file.name }));
    // The copy is new; the recording's date (for names and folders) is the original's.
    await db.set(`modified:${path}`, file.lastModified);
    return path;
  } catch (err) {
    toast(errorText(err), 'error');
    return null;
  }
}

/** Writes `file` to `path` with a progress dialog. Nothing is left at `path` when it fails. */
export async function copyFile(file: Blob, path: string, title: string): Promise<void> {
  const loading = showLoading(title);
  const out = await vfs.createWritable(path);
  try {
    let copied = 0;
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await out.write(value);
      copied += value.length;
      loading.update(file.size ? copied / file.size : 1);
    }
    await out.close();
  } catch (err) {
    await out.abort().catch(() => {});
    throw vfs.storageError(err);
  } finally {
    loading.close();
  }
}
