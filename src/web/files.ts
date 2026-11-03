// The web build's stand-in for the system file dialogs: a browser of the server's data folder.
import { t, translateCodes } from '../shared/i18n/index.ts';
import type { BrowseResult } from '../shared/web.ts';
import { openModal, showLoading, toast } from '../renderer/dialogs.ts';
import { h, pathText } from '../renderer/dom.ts';
import { call, upload } from './bridge.ts';

type Mode = 'wav' | 'folder' | 'view';

const errorText = (err: unknown) => translateCodes(err instanceof Error ? err.message : String(err));
const parentOf = (dir: string) => dir.replace(/\/[^/]*$/, '') || '/';

function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * Shows the folder `start` (or the data folder). 'wav' resolves to the WAV clicked or uploaded,
 * 'folder' to the folder chosen, 'view' lists the files with download links; null when closed.
 */
export function browse(mode: Mode, start: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const title = mode === 'wav' ? t('dlg.openWav.title') : mode === 'folder' ? t('dlg.folder.title') : t('web.files.title');
    const m = openModal(title, { wide: true, onClose: () => resolve(result) });
    const finish = (value: string) => {
      result = value;
      m.close();
    };

    const where = h('div', { class: 'folder-path' });
    const list = h('div', { class: 'file-browser' });
    const nameInput = h('input', { type: 'text', placeholder: t('web.folderName') });
    const newRow = h('form', { class: 'folder-row hidden' }, nameInput, h('button', { type: 'submit' }, t('web.create')));
    m.body.append(where, list, newRow);
    let current: BrowseResult | null = null;

    const row = (label: string, detail: string, onclick: () => void, cls = '') =>
      h('button', { type: 'button', class: `file-row ${cls}`, onclick }, h('span', {}, label), h('span', { class: 'form-note' }, detail));

    async function show(dir: string | null): Promise<void> {
      try {
        current = await call<BrowseResult>('fs:browse', dir);
      } catch (err) {
        return toast(errorText(err), 'error');
      }
      const c = current;
      where.textContent = pathText(c.dir);
      where.title = c.dir;
      list.replaceChildren();
      if (c.dir !== c.root) list.append(row('..', '', () => void show(parentOf(c.dir)), 'folder'));
      for (const name of c.folders) list.append(row(`${name}/`, '', () => void show(`${c.dir}/${name}`), 'folder'));
      const files = mode === 'folder' ? [] : mode === 'wav' ? c.files.filter((f) => /\.wav$/i.test(f.name)) : c.files;
      for (const f of files) {
        const path = `${c.dir}/${f.name}`;
        if (mode === 'wav') list.append(row(f.name, sizeText(f.size), () => finish(path)));
        else list.append(h('a', { class: 'file-row', href: `api/download?path=${encodeURIComponent(path)}`, download: f.name },
          h('span', {}, f.name), h('span', { class: 'form-note' }, sizeText(f.size))));
      }
      if (!c.folders.length && !files.length) list.append(h('div', { class: 'form-note' }, t('web.empty')));
    }

    newRow.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!current || !nameInput.value.trim()) return;
      void call<string>('fs:mkdir', current.dir, nameInput.value).then(
        (path) => {
          nameInput.value = '';
          newRow.classList.add('hidden');
          return show(path);
        },
        (err: unknown) => toast(errorText(err), 'error'),
      );
    });

    if (mode === 'wav') {
      const picker = h('input', { type: 'file', accept: '.wav,audio/wav', class: 'hidden' });
      picker.addEventListener('change', () => {
        const file = picker.files?.[0];
        if (file && current) void uploadWav(file, current.dir).then((path) => path && finish(path));
      });
      m.foot.append(picker, h('button', { onclick: () => picker.click() }, t('web.upload')));
    }
    if (mode !== 'view') {
      m.foot.append(h('button', {
        onclick: () => {
          newRow.classList.toggle('hidden');
          nameInput.focus();
        },
      }, t('web.newFolder')));
    }
    m.foot.append(h('button', { onclick: () => m.close() }, mode === 'view' ? t('btn.close') : t('btn.cancel')));
    if (mode === 'folder') m.foot.append(h('button', { class: 'primary', onclick: () => current && finish(current.dir) }, t('web.chooseFolder')));

    void show(start);
  });
}

/** Sends a WAV from this computer to `dir` on the server, showing progress; resolves to its path there. */
export async function uploadWav(file: File, dir: string): Promise<string | null> {
  const loading = showLoading(t('web.uploading', { name: file.name }));
  try {
    return await upload(file, dir, (f) => loading.update(f));
  } catch (err) {
    toast(errorText(err), 'error');
    return null;
  } finally {
    loading.close();
  }
}
