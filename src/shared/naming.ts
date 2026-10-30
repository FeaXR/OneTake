import type { Bitrate, PeakTarget } from './types.ts';

/** Settings for files written to one folder and its subfolders (Settings → Folder rules). */
export interface FolderRule {
  id: string;
  folder: string;
  /** Start of the filename, with {nn}, {n}, {date} and {type}; empty for no naming rule. */
  template: string;
  /** Choices for {type}; the first is the default. */
  types: string[];
  /** Defaults for the files; unset falls back to a parent folder's rule, then to Settings. */
  peakTarget?: PeakTarget;
  bitrate?: Bitrate;
  /**
   * Name of a folder made inside this one for each recording, such as {date}_{ampm}_{Venue}
   * (see subfolders.ts); unset or empty when the files go straight into the folder.
   */
  subfolder?: string;
  /** What {ampm} becomes before and after noon; AM and PM when unset. */
  am?: string;
  pm?: string;
}

export interface NameParts {
  /** {nn}: running number, continuing after the files already in the folder. */
  number: number;
  /** {n}: position of the file within this recording's files for the folder, from 1. */
  order: number;
  /** {date}: YYMMDD, or null when the WAV name has none. */
  date: string | null;
  /** {type}: the file's choice. */
  type: string;
}

export interface RecordingDate {
  year: number;
  month: number;
  day: number;
}

const TOKEN = /\{(nn|n|date|type)\}/g;

const normalizeDir = (dir: string) => dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const pad2 = (v: number) => String(v).padStart(2, '0');

/** Rules for `folder` (for it or a folder containing it), the deepest folder first. */
export function rulesFor(rules: readonly FolderRule[], folder: string | null): FolderRule[] {
  if (!folder) return [];
  const target = normalizeDir(folder);
  return rules
    .map((rule) => ({ rule, dir: normalizeDir(rule.folder) }))
    .filter(({ dir }) => dir && (target === dir || target.startsWith(`${dir}/`)))
    .sort((a, b) => b.dir.length - a.dir.length)
    .map(({ rule }) => rule);
}

/** The naming rule for `folder`: the deepest rule that has a name template. */
export function ruleFor(rules: readonly FolderRule[], folder: string | null): FolderRule | null {
  return rulesFor(rules, folder).find((r) => r.template.trim() !== '') ?? null;
}

/** A folder default from the deepest rule that sets it, or undefined when none does. */
export function folderDefault<K extends 'peakTarget' | 'bitrate'>(
  rules: readonly FolderRule[],
  folder: string | null,
  key: K,
): FolderRule[K] | undefined {
  return rulesFor(rules, folder).find((r) => r[key] !== undefined)?.[key];
}

export function usesToken(template: string, token: 'nn' | 'n' | 'date' | 'type'): boolean {
  return template.includes(`{${token}}`);
}

/**
 * The date a WAV name starts with (MMDD, as in 0720_eb.wav). The year is the one that puts
 * the date closest to `referenceMs`, normally the file's modification time.
 */
export function recordingDate(wavPath: string, referenceMs: number): RecordingDate | null {
  const m = /^(\d{2})(\d{2})/.exec(wavPath.replace(/^.*[\\/]/, ''));
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const refYear = new Date(referenceMs).getFullYear();
  let best: RecordingDate | null = null;
  let bestDiff = Infinity;
  for (const year of [refYear - 1, refYear, refYear + 1]) {
    const date = new Date(year, month - 1, day);
    if (date.getMonth() !== month - 1 || date.getDate() !== day) continue; // 0230, 1301, a 0229 off leap years
    const diff = Math.abs(date.getTime() - referenceMs);
    if (diff < bestDiff) {
      best = { year, month, day };
      bestDiff = diff;
    }
  }
  return best;
}

export function formatDate(d: RecordingDate): string {
  return `${pad2(d.year % 100)}${pad2(d.month)}${pad2(d.day)}`;
}

/** The template with its parts filled in. A missing date shows as ?????? so the gap is visible. */
export function expandTemplate(template: string, parts: NameParts): string {
  return template.replace(TOKEN, (_, token: string) => {
    if (token === 'nn') return pad2(parts.number);
    if (token === 'n') return String(parts.order);
    if (token === 'date') return parts.date ?? '??????';
    return parts.type;
  });
}

/**
 * Highest {nn} among `filenames` that follow the template, or 0 when there is none. {type}
 * only matches the rule's own choices, so differently named files are not counted.
 */
export function highestNumber(template: string, types: readonly string[], filenames: readonly string[]): number {
  if (!usesToken(template, 'nn')) return 0;
  let pattern = '^';
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    pattern += escapeRegExp(template.slice(last, m.index));
    const typePattern = types.length ? `(?:${types.map(escapeRegExp).join('|')})` : '[^_]+';
    pattern += m[1] === 'nn' ? '(\\d+)' : m[1] === 'n' ? '\\d+' : m[1] === 'date' ? '\\d{6}' : typePattern;
    last = m.index + m[0].length;
  }
  pattern += escapeRegExp(template.slice(last));
  const re = new RegExp(pattern, 'i');
  let highest = 0;
  for (const name of filenames) {
    const match = re.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
