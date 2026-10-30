/**
 * Names of the subfolders a folder rule creates for each recording, such as 261030_PM_Budapest.
 * The template mixes fixed text, parts filled in from the recording's start (date, time, AM/PM)
 * and fields typed when the WAV is opened ({Venue}: any name that is not a built-in part).
 */

/** Built-in parts and what they become for 30 Oct 2026, 19:05 (a Friday). */
export const SUBFOLDER_PARTS = {
  date: '261030',
  year: '2026',
  yy: '26',
  month: '10',
  day: '30',
  weekday: 'Friday',
  time: '1905',
  hour: '19',
  hour12: '7',
  minute: '05',
  ampm: 'PM',
} as const;
export type SubfolderPart = keyof typeof SUBFOLDER_PARTS;

export interface AmPmText {
  am: string;
  pm: string;
}

export const DEFAULT_AMPM: AmPmText = { am: 'AM', pm: 'PM' };

/** {ampm} as chosen for one recording; 'none' leaves it out. */
export type AmPmChoice = 'am' | 'pm' | 'none';

const TOKEN = /\{([^{}]+)\}/g;
const isPart = (name: string): name is SubfolderPart => Object.hasOwn(SUBFOLDER_PARTS, name);
const pad2 = (v: number) => String(v).padStart(2, '0');

/** The fields typed for each recording, in the order they appear (each once). */
export function subfolderFields(template: string): string[] {
  const fields: string[] = [];
  for (const m of template.matchAll(TOKEN)) {
    const name = m[1].trim();
    if (name && !isPart(name) && !fields.includes(name)) fields.push(name);
  }
  return fields;
}

export const usesAmPm = (template: string): boolean => /\{\s*ampm\s*\}/.test(template);

/** The template without {ampm} and one separator next to it, so no doubled _ is left behind. */
export function withoutAmPm(template: string): string {
  return template.replace(/^\{\s*ampm\s*\}[ _.-]?/, '').replace(/[ _.-]?\{\s*ampm\s*\}/g, '');
}

/** Before or after noon at `when`. */
export const amPmAt = (when: Date): AmPmChoice => (when.getHours() < 12 ? 'am' : 'pm');

/** Whether the template uses any part read from the recording's date or time. */
export const usesDateTime = (template: string): boolean => [...template.matchAll(TOKEN)].some((m) => isPart(m[1].trim()));

/** The part's text for `when`; `locale` names the weekday. */
function partText(part: SubfolderPart, when: Date, ampm: AmPmText, locale: string, choice: AmPmChoice): string {
  const h = when.getHours();
  switch (part) {
    case 'date': return `${pad2(when.getFullYear() % 100)}${pad2(when.getMonth() + 1)}${pad2(when.getDate())}`;
    case 'year': return String(when.getFullYear());
    case 'yy': return pad2(when.getFullYear() % 100);
    case 'month': return pad2(when.getMonth() + 1);
    case 'day': return pad2(when.getDate());
    case 'weekday': return when.toLocaleDateString(locale, { weekday: 'long' });
    case 'time': return `${pad2(h)}${pad2(when.getMinutes())}`;
    case 'hour': return pad2(h);
    case 'hour12': return String(h % 12 || 12);
    case 'minute': return pad2(when.getMinutes());
    case 'ampm': return choice === 'am' ? ampm.am : ampm.pm;
  }
}

/**
 * The subfolder's name for a recording started at `when`, with the typed `values`. {ampm}
 * follows the time unless `choice` says otherwise.
 */
export function expandSubfolder(
  template: string,
  when: Date,
  values: Record<string, string>,
  ampm: AmPmText,
  locale: string,
  choice: AmPmChoice = amPmAt(when),
): string {
  return (choice === 'none' ? withoutAmPm(template) : template).replace(TOKEN, (_, raw: string) => {
    const name = raw.trim();
    return isPart(name) ? partText(name, when, ampm, locale, choice) : (values[name] ?? '').trim();
  }).trim();
}

/**
 * Reads an existing folder name back: the typed fields' values, or null when the name does not
 * follow the template. Used to offer earlier folders and the values typed before.
 */
export function matchSubfolder(template: string, name: string, ampm: AmPmText): Record<string, string> | null {
  return matchExactly(template, name, ampm) ?? (usesAmPm(template) ? matchExactly(withoutAmPm(template), name, ampm) : null);
}

function matchExactly(template: string, name: string, ampm: AmPmText): Record<string, string> | null {
  const fields: string[] = [];
  let pattern = '^';
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    pattern += escapeRegExp(template.slice(last, m.index));
    const part = m[1].trim();
    if (isPart(part)) pattern += partPattern(part, ampm);
    else {
      fields.push(part);
      pattern += '(.+?)';
    }
    last = m.index + m[0].length;
  }
  pattern += `${escapeRegExp(template.slice(last))}$`;
  const match = new RegExp(pattern, 'iu').exec(name.trim());
  if (!match) return null;
  const values: Record<string, string> = {};
  fields.forEach((f, i) => (values[f] ??= match[i + 1]));
  return values;
}

function partPattern(part: SubfolderPart, ampm: AmPmText): string {
  switch (part) {
    case 'date': return '\\d{6}';
    case 'time': return '\\d{4}';
    case 'year': return '\\d{4}';
    case 'hour12': return '\\d{1,2}';
    case 'weekday': return '\\p{L}+';
    case 'ampm': return `(?:${escapeRegExp(ampm.am)}|${escapeRegExp(ampm.pm)})`;
    default: return '\\d{2}';
  }
}

/**
 * When the recording started: the file's time minus its length (the file is last written when
 * it ends), on the day its name gives, if it starts with one.
 */
export function recordingStart(modifiedMs: number, durationSec: number, nameDate: { year: number; month: number; day: number } | null): Date {
  const start = new Date(modifiedMs - durationSec * 1000);
  if (nameDate) start.setFullYear(nameDate.year, nameDate.month - 1, nameDate.day);
  return start;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
