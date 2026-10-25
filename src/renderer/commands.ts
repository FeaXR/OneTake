/**
 * Every user action is a command. Toolbar buttons, context menus and keyboard shortcuts
 * all call commands by id, so anything doable with the mouse is doable with keys and vice versa.
 */
export interface Command {
  id: string;
  label: string;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(...cmds: Command[]): void {
    for (const cmd of cmds) this.commands.set(cmd.id, cmd);
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  isEnabled(id: string): boolean {
    const cmd = this.commands.get(id);
    return !!cmd && (cmd.enabled?.() ?? true);
  }

  run(id: string): boolean {
    const cmd = this.commands.get(id);
    if (!cmd || !(cmd.enabled?.() ?? true)) return false;
    void cmd.run();
    return true;
  }

  all(): Command[] {
    return [...this.commands.values()];
  }
}

/** Default key bindings. Users can override them in shortcuts.json (Settings → Edit shortcuts). */
export const DEFAULT_SHORTCUTS: Record<string, string[]> = {
  'file.open': ['Ctrl+O'],
  'file.save': ['Ctrl+S'],
  'file.export': ['Ctrl+E'],
  'edit.undo': ['Ctrl+Z'],
  'edit.redo': ['Ctrl+Y', 'Ctrl+Shift+Z'],
  'edit.delete': ['Delete', 'Backspace'],
  'edit.escape': ['Escape'],
  'tool.select': ['1'],
  'tool.segment': ['2'],
  'tool.cut': ['3'],
  'play.toggle': ['Space'],
  'play.selection': ['P'],
  'play.skipCuts': ['K'],
  'play.segmentStart': ['Shift+P'],
  'play.segmentEnd': ['Alt+P'],
  'playhead.start': ['Home'],
  'playhead.end': ['End'],
  'playhead.back': ['ArrowLeft'],
  'playhead.forward': ['ArrowRight'],
  'playhead.backBig': ['Shift+ArrowLeft'],
  'playhead.forwardBig': ['Shift+ArrowRight'],
  'playhead.selectionStart': ['Shift+Home'],
  'playhead.selectionEnd': ['Shift+End'],
  'playhead.segmentStart': ['Ctrl+Home'],
  'playhead.segmentEnd': ['Ctrl+End'],
  'playhead.prevEdge': ['Ctrl+ArrowLeft'],
  'playhead.nextEdge': ['Ctrl+ArrowRight'],
  'playhead.show': ['C'],
  'view.pageBack': ['PageUp'],
  'view.pageForward': ['PageDown'],
  'mark.in': ['I'],
  'mark.out': ['O'],
  'mark.cut': ['X'],
  'edit.setStart': ['Shift+I'],
  'edit.setEnd': ['Shift+O'],
  'nudge.startBack': ['Alt+ArrowLeft'],
  'nudge.startForward': ['Alt+ArrowRight'],
  'nudge.endBack': ['Alt+Shift+ArrowLeft'],
  'nudge.endForward': ['Alt+Shift+ArrowRight'],
  'select.next': ['Tab', 'ArrowDown'],
  'select.prev': ['Shift+Tab', 'ArrowUp'],
  'zoom.in': ['+', '='],
  'zoom.out': ['-'],
  'zoom.fit': ['F'],
  'zoom.selection': ['Z'],
  'rec.start': ['Ctrl+R'],
  'view.followLive': ['L'],
  'app.settings': ['Ctrl+,'],
  'app.devtools': ['F12'],
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

/**
 * Turns a key event into a combo string like "Ctrl+Shift+Z". Uses the typed character, so
 * bindings follow the keyboard layout (Ctrl+Z is the key labelled Z on QWERTZ too).
 * Shift is left out for punctuation, because it is already part of the character.
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key = e.key;
  const isChar = key.length === 1;
  if (key === ' ') key = 'Space';
  else if (isChar) key = key.toUpperCase();

  const isLetter = isChar && key.toLowerCase() !== key;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && (!isChar || isLetter || key === 'Space')) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Normalizes a combo written by hand ("ctrl+shift+z") to the comboFromEvent format. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim());
  // "Ctrl++" splits into ["Ctrl", "", ""]: the key itself is "+".
  let key = parts.pop() ?? '';
  if (key === '' && parts.at(-1) === '') {
    parts.pop();
    key = '+';
  }
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const out: string[] = [];
  if (mods.has('ctrl') || mods.has('control') || mods.has('cmd')) out.push('Ctrl');
  if (mods.has('alt')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  out.push(key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  return out.join('+');
}

export class Keymap {
  private byCombo = new Map<string, string>();
  private byCommand = new Map<string, string[]>();

  constructor(overrides: Record<string, string[]> = {}) {
    const merged = { ...DEFAULT_SHORTCUTS, ...overrides };
    for (const [id, combos] of Object.entries(merged)) {
      const list = (Array.isArray(combos) ? combos : []).map(normalizeCombo);
      this.byCommand.set(id, list);
      for (const c of list) this.byCombo.set(c, id);
    }
  }

  commandFor(e: KeyboardEvent): string | undefined {
    const combo = comboFromEvent(e);
    return combo ? this.byCombo.get(combo) : undefined;
  }

  /** Display text for a command's first binding, or ''. */
  label(id: string): string {
    const first = this.byCommand.get(id)?.[0];
    return first ? formatCombo(first) : '';
  }

  bindings(id: string): string[] {
    return this.byCommand.get(id) ?? [];
  }

  /** Every command's bindings (defaults merged with overrides), as an editable copy. */
  toRecord(): Record<string, string[]> {
    return Object.fromEntries([...this.byCommand].map(([id, combos]) => [id, [...combos]]));
  }
}

/** Only the commands whose bindings differ from the defaults, for saving. */
export function overridesFrom(bindings: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, combos] of Object.entries(bindings)) {
    const defaults = (DEFAULT_SHORTCUTS[id] ?? []).map(normalizeCombo);
    if (combos.length !== defaults.length || combos.some((c, i) => c !== defaults[i])) out[id] = combos;
  }
  return out;
}

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Escape: 'Esc',
};

/** Human-friendly combo text: "Ctrl+ArrowLeft" → "Ctrl+←". */
export function formatCombo(combo: string): string {
  const parts = combo.split('+');
  // A "+" key splits into two empty strings ("+" → ["", ""], "Ctrl++" → ["Ctrl", "", ""]).
  const plusKey = combo === '+' || combo.endsWith('++');
  const key = plusKey ? '+' : parts.pop()!;
  const mods = plusKey ? parts.slice(0, -2) : parts;
  return [...mods, KEY_NAMES[key] ?? key].join('+');
}
