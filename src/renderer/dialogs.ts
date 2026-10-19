import { h } from './dom.ts';
import type { ContextItem } from './timeline.ts';

const root = () => document.getElementById('overlay-root')!;

/** True while a modal is open, so global shortcuts stay out of the way. */
export function modalOpen(): boolean {
  return root().querySelector('.modal-backdrop') !== null;
}

export interface ModalHandle {
  close(): void;
  body: HTMLElement;
  foot: HTMLElement;
}

export function openModal(title: string, opts: { wide?: boolean; onClose?: () => void; dismissable?: boolean } = {}): ModalHandle {
  const body = h('div', { class: 'modal-body' });
  const foot = h('div', { class: 'modal-foot' });
  const modal = h('div', { class: `modal${opts.wide ? ' wide' : ''}` }, h('h2', {}, title), body, foot);
  const backdrop = h('div', { class: 'modal-backdrop' }, modal);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && opts.dismissable !== false) {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  if (opts.dismissable !== false) {
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close();
    });
  }
  root().append(backdrop);
  return { close, body, foot };
}

/** Asks a question with custom buttons. Resolves to the chosen value, or `cancelValue` on Escape. */
export function choose<T extends string>(
  title: string,
  message: string,
  buttons: { label: string; value: T; primary?: boolean }[],
  cancelValue: T,
): Promise<T> {
  return new Promise((resolve) => {
    let result = cancelValue;
    const m = openModal(title, { onClose: () => resolve(result) });
    m.body.append(h('div', {}, message));
    for (const b of buttons) {
      const btn = h('button', {
        class: b.primary ? 'primary' : '',
        onclick: () => {
          result = b.value;
          m.close();
        },
      }, b.label);
      m.foot.append(btn);
      if (b.primary) queueMicrotask(() => btn.focus());
    }
  });
}

let toastTimer = 0;
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  root().querySelector('.toast')?.remove();
  const el = h('div', { class: `toast${kind === 'error' ? ' error' : ''}` }, message);
  root().append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2500);
}

export function showContextMenu(x: number, y: number, items: ContextItem[]): void {
  closeContextMenu();
  const menu = h('div', { class: 'ctx-menu' });
  for (const item of items) {
    if (item.separator) {
      menu.append(h('hr'));
      continue;
    }
    menu.append(h('button', {
      disabled: item.disabled,
      onclick: () => {
        closeContextMenu();
        item.run?.();
      },
    }, h('span', {}, item.label), item.key ? h('span', { class: 'key' }, item.key) : null));
  }
  root().append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onEscape, true);
  });
}

function onOutside(e: PointerEvent): void {
  if (!(e.target instanceof Node) || !root().querySelector('.ctx-menu')?.contains(e.target)) closeContextMenu();
}

function onEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeContextMenu();
  }
}

export function closeContextMenu(): void {
  root().querySelector('.ctx-menu')?.remove();
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onEscape, true);
}

/** Non-dismissable progress box used while a WAV is scanned. */
export function showLoading(title: string): { update(fraction: number): void; close(): void } {
  const fill = h('div');
  const pct = h('div', { class: 'form-note' }, '');
  const backdrop = h('div', { class: 'modal-backdrop' },
    h('div', { class: 'modal' }, h('div', { class: 'loading-box' }, h('div', {}, title), h('div', { class: 'bar' }, fill), pct)));
  root().append(backdrop);
  return {
    update(fraction) {
      fill.style.width = `${Math.round(fraction * 100)}%`;
      pct.textContent = `${Math.round(fraction * 100)}%`;
    },
    close: () => backdrop.remove(),
  };
}
