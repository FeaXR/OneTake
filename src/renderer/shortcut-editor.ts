import { comboFromEvent, DEFAULT_SHORTCUTS, formatCombo, normalizeCombo, type Command } from './commands.ts';
import { h } from './dom.ts';
import { t, type MessageKey } from '../shared/i18n/index.ts';

const GROUPS: [MessageKey, string[]][] = [
  ['sc.group.file', ['file']],
  ['sc.group.playback', ['play']],
  ['sc.group.playhead', ['playhead']],
  ['sc.group.marking', ['mark']],
  ['sc.group.editing', ['edit', 'nudge']],
  ['sc.group.selection', ['select']],
  ['sc.group.tools', ['tool']],
  ['sc.group.view', ['view', 'zoom']],
  ['sc.group.app', ['app']],
];

/**
 * Settings section for changing key bindings. Click "+" on a command, then press the keys.
 * A combo can belong to one command only; taking it moves it and says so.
 */
export class ShortcutEditor {
  readonly el = h('div', { class: 'sc-editor' });
  private readonly commands: Command[];
  private readonly bindings: Record<string, string[]>;
  private capturing: string | null = null;
  private notice = '';

  constructor(commands: Command[], bindings: Record<string, string[]>) {
    this.commands = commands;
    this.bindings = bindings;
    // Window capture runs before the modal's own Escape handling on document.
    window.addEventListener('keydown', this.onKey, true);
    this.render();
  }

  /** Current bindings for every command. */
  result(): Record<string, string[]> {
    return this.bindings;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.capturing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      this.capturing = null;
      this.render();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return; // only a modifier so far; wait for the real key

    const id = this.capturing;
    this.capturing = null;
    this.notice = '';
    for (const [otherId, combos] of Object.entries(this.bindings)) {
      if (otherId !== id && combos.includes(combo)) {
        this.bindings[otherId] = combos.filter((c) => c !== combo);
        this.notice = t('sc.moved', { combo: formatCombo(combo), command: this.labelOf(otherId) });
      }
    }
    const list = this.bindings[id] ?? [];
    if (!list.includes(combo)) this.bindings[id] = [...list, combo];
    this.render();
  };

  private labelOf(id: string): string {
    return this.commands.find((c) => c.id === id)?.label ?? id;
  }

  private isDefault(id: string): boolean {
    const current = this.bindings[id] ?? [];
    const defaults = (DEFAULT_SHORTCUTS[id] ?? []).map(normalizeCombo);
    return current.length === defaults.length && current.every((c, i) => c === defaults[i]);
  }

  private resetOne(id: string): void {
    const defaults = (DEFAULT_SHORTCUTS[id] ?? []).map(normalizeCombo);
    // Take the defaults back from any command that has since been given them.
    for (const [otherId, combos] of Object.entries(this.bindings)) {
      if (otherId !== id) this.bindings[otherId] = combos.filter((c) => !defaults.includes(c));
    }
    this.bindings[id] = defaults;
  }

  private render(): void {
    const head = h('div', { class: 'sc-head' },
      h('span', { class: 'form-note' }, t('sc.help')),
      h('button', {
        onclick: () => {
          for (const id of Object.keys(this.bindings)) this.bindings[id] = [];
          for (const cmd of this.commands) this.resetOne(cmd.id);
          this.notice = t('sc.resetAllDone');
          this.capturing = null;
          this.render();
        },
      }, t('sc.resetAll')),
    );

    const table = h('table', { class: 'shortcut-table' });
    for (const [title, prefixes] of GROUPS) {
      const cmds = this.commands.filter((c) => prefixes.includes(c.id.split('.')[0]));
      if (!cmds.length) continue;
      table.append(h('tr', { class: 'sc-group' }, h('td', { colSpan: 3 }, t(title))));
      for (const cmd of cmds) table.append(this.row(cmd));
    }

    this.el.replaceChildren(head, ...(this.notice ? [h('div', { class: 'sc-notice' }, this.notice)] : []), table);
  }

  private row(cmd: Command): HTMLElement {
    const combos = this.bindings[cmd.id] ?? [];
    const keys = h('td', { class: 'sc-keys' },
      ...combos.map((combo) =>
        h('button', {
          class: 'sc-key',
          title: t('sc.remove.tip'),
          onclick: () => {
            this.bindings[cmd.id] = combos.filter((c) => c !== combo);
            this.notice = '';
            this.render();
          },
        }, h('kbd', {}, formatCombo(combo)), h('span', { class: 'sc-x' }, '×')),
      ),
      this.capturing === cmd.id ? h('span', { class: 'sc-capture' }, t('sc.press')) : null,
      !combos.length && this.capturing !== cmd.id ? h('span', { class: 'sc-none' }, t('sc.none')) : null,
    );
    const actions = h('td', { class: 'sc-actions' },
      h('button', {
        class: 'icon',
        title: t('sc.add.tip'),
        onclick: () => {
          this.capturing = this.capturing === cmd.id ? null : cmd.id;
          this.notice = '';
          this.render();
        },
      }, '+'),
      this.isDefault(cmd.id)
        ? null
        : h('button', {
          class: 'icon',
          title: t('sc.reset.tip'),
          onclick: () => {
            this.resetOne(cmd.id);
            this.notice = '';
            this.render();
          },
        }, '↺'),
    );
    return h('tr', { class: this.capturing === cmd.id ? 'sc-active' : '' }, h('td', {}, cmd.label), keys, actions);
  }
}
