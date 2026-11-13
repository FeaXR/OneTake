import { LANGUAGES } from './i18n/index.ts';
import { trimDir, type FolderRule } from './naming.ts';
import { cleanPresets, DEFAULT_BITRATE_PRESETS, DEFAULT_PEAK_PRESETS, isBitrate, isPeakTarget } from './presets.ts';
import { DEFAULT_SETTINGS, FADE_CURVES, FADE_MARKER_STYLES, isAccent, THEMES, type Project, type Settings } from './types.ts';

/** Saved settings filled up with the defaults, with anything invalid replaced by them. */
export function completeSettings(saved: Partial<Settings> | null): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...saved };
  // Paths typed into settings.json by hand may end in a separator; the app expects none.
  s.folderRules = (Array.isArray(s.folderRules) ? s.folderRules : []).map((r) => ({ ...r, folder: trimDir(r.folder ?? '') }));
  s.peakPresets = cleanPresets(s.peakPresets, isPeakTarget, DEFAULT_PEAK_PRESETS);
  s.bitratePresets = cleanPresets(s.bitratePresets, isBitrate, DEFAULT_BITRATE_PRESETS);
  if (!(THEMES as readonly string[]).includes(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
  if (!isAccent(s.accent)) s.accent = DEFAULT_SETTINGS.accent;
  if (!isPeakTarget(s.defaultPeakTarget)) s.defaultPeakTarget = DEFAULT_SETTINGS.defaultPeakTarget;
  if (!isBitrate(s.defaultBitrate)) s.defaultBitrate = DEFAULT_SETTINGS.defaultBitrate;
  return s;
}

export const isProject = (p: Project | null): p is Project => !!p && p.version === 1 && Array.isArray(p.segments);

/** Marks a file written by "Export settings", so other JSON files are refused on import. */
export const SETTINGS_FILE_KIND = 'one-take-settings';

/** The parts of a settings file that can be exported and imported on their own. */
export const SETTINGS_PARTS = ['language', 'theme', 'fileList', 'fades', 'folderRules', 'export', 'recording', 'updates', 'shortcuts'] as const;
export type SettingsPart = (typeof SETTINGS_PARTS)[number];

/** The settings in each part; the key bindings are the 'shortcuts' part. */
const PART_KEYS: Record<Exclude<SettingsPart, 'shortcuts'>, (keyof Settings)[]> = {
  language: ['language'],
  theme: ['theme', 'accent'],
  fileList: ['showSegmentTimes'],
  fades: ['fadeInSec', 'fadeInCurve', 'fadeOutSec', 'fadeOutCurve', 'fadeMarkerStyle'],
  folderRules: ['folderRules', 'lastDestinations'],
  export: ['ceilingDb', 'cutCrossfadeMs', 'peakPresets', 'bitratePresets', 'defaultPeakTarget', 'defaultBitrate'],
  recording: ['recordFolder', 'recordName', 'recordInput'],
  updates: ['checkUpdates'],
};

/** What "Export settings" writes: the chosen parts of the settings and the changed key bindings. */
export interface SettingsFile {
  kind: typeof SETTINGS_FILE_KIND;
  version: 1;
  /** Version of One Take that wrote it, for the reader's information. */
  app: string;
  settings: Partial<Settings>;
  /** The key bindings that differ from the defaults; left out when that part was not chosen. */
  shortcuts?: Record<string, string[]>;
}

/** A settings file with only the `parts` chosen. */
export function settingsFile(settings: Settings, shortcuts: Record<string, string[]>, app: string, parts: Iterable<SettingsPart> = SETTINGS_PARTS): SettingsFile {
  const chosen = new Set(parts);
  const picked: Partial<Record<keyof Settings, unknown>> = {};
  for (const [part, keys] of Object.entries(PART_KEYS) as [SettingsPart, (keyof Settings)[]][]) {
    if (chosen.has(part)) for (const key of keys) picked[key] = settings[key];
  }
  const file: SettingsFile = { kind: SETTINGS_FILE_KIND, version: 1, app, settings: picked as Partial<Settings> };
  if (chosen.has('shortcuts')) file.shortcuts = shortcuts;
  return file;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A settings file read for import: the parts it has, and its usable values. */
export interface ReadSettingsFile {
  parts: Set<SettingsPart>;
  settings: Partial<Settings>;
  shortcuts: Record<string, string[]> | null;
}

/**
 * Reads an exported settings file. A part is in it when the file has any of that part's
 * settings; values of the wrong type are left out. Null when the text is not a settings file.
 */
export function readSettingsFile(text: string): ReadSettingsFile | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.kind !== SETTINGS_FILE_KIND || !isObject(data.settings)) return null;
  const raw = data.settings;

  const parts = new Set<SettingsPart>();
  for (const [part, keys] of Object.entries(PART_KEYS) as [SettingsPart, (keyof Settings)[]][]) {
    if (keys.some((key) => key in raw)) parts.add(part);
  }

  const picked: Partial<Record<keyof Settings, unknown>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    const fallback = DEFAULT_SETTINGS[key as keyof Settings];
    const sameType = Array.isArray(fallback) ? Array.isArray(value) : typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value));
    if (sameType) picked[key as keyof Settings] = value;
  }
  if (picked.language !== undefined && picked.language !== 'system' && !(String(picked.language) in LANGUAGES)) delete picked.language;
  if (picked.theme !== undefined && !(THEMES as readonly unknown[]).includes(picked.theme)) delete picked.theme;
  if (picked.accent !== undefined && !isAccent(picked.accent)) delete picked.accent;
  for (const key of ['fadeInCurve', 'fadeOutCurve'] as const) {
    if (picked[key] !== undefined && !(FADE_CURVES as readonly unknown[]).includes(picked[key])) delete picked[key];
  }
  if (picked.fadeMarkerStyle !== undefined && !(FADE_MARKER_STYLES as readonly unknown[]).includes(picked.fadeMarkerStyle)) delete picked.fadeMarkerStyle;
  if (picked.defaultBitrate !== undefined && !isBitrate(picked.defaultBitrate)) delete picked.defaultBitrate;
  if (picked.defaultPeakTarget !== undefined && !isPeakTarget(picked.defaultPeakTarget)) delete picked.defaultPeakTarget;
  if (Array.isArray(picked.folderRules)) picked.folderRules = picked.folderRules.flatMap(folderRuleOf);
  if (Array.isArray(picked.lastDestinations)) picked.lastDestinations = picked.lastDestinations.filter((v) => typeof v === 'string');

  let shortcuts: Record<string, string[]> | null = null;
  if (isObject(data.shortcuts)) {
    parts.add('shortcuts');
    shortcuts = {};
    for (const [id, combos] of Object.entries(data.shortcuts)) {
      if (Array.isArray(combos)) shortcuts[id] = combos.filter((c): c is string => typeof c === 'string' && c !== '');
    }
  }
  return { parts, settings: picked as Partial<Settings>, shortcuts };
}

/**
 * The current settings with the chosen `parts` of a read file put over them; settings the
 * file lacks stay as they are. `shortcuts` is null when the bindings are to be kept.
 */
export function importSettings(file: ReadSettingsFile, current: Settings, parts: Iterable<SettingsPart>): { settings: Settings; shortcuts: Record<string, string[]> | null } {
  const chosen = new Set([...parts].filter((p) => file.parts.has(p)));
  const picked: Partial<Record<keyof Settings, unknown>> = {};
  for (const [part, keys] of Object.entries(PART_KEYS) as [SettingsPart, (keyof Settings)[]][]) {
    if (!chosen.has(part)) continue;
    for (const key of keys) if (file.settings[key] !== undefined) picked[key] = file.settings[key];
  }
  const settings = completeSettings({ ...current, ...(picked as Partial<Settings>) });
  settings.fadeInSec = clampNumber(settings.fadeInSec, 0, 60, current.fadeInSec);
  settings.fadeOutSec = clampNumber(settings.fadeOutSec, 0, 60, current.fadeOutSec);
  settings.ceilingDb = clampNumber(settings.ceilingDb, -3, 0, current.ceilingDb);
  settings.cutCrossfadeMs = clampNumber(settings.cutCrossfadeMs, 1, 200, current.cutCrossfadeMs);
  return { settings, shortcuts: chosen.has('shortcuts') ? file.shortcuts : null };
}

/** The same limits the settings dialog keeps the numbers in. */
function clampNumber(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** A folder rule from a file, or nothing when it lacks a folder; optional parts are dropped when malformed. */
function folderRuleOf(value: unknown): FolderRule[] {
  if (!isObject(value) || typeof value.folder !== 'string' || value.folder.trim() === '') return [];
  const rule: FolderRule = {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : crypto.randomUUID(),
    folder: value.folder,
    template: typeof value.template === 'string' ? value.template : '',
    types: Array.isArray(value.types) ? value.types.filter((v): v is string => typeof v === 'string') : [],
  };
  if (isPeakTarget(value.peakTarget)) rule.peakTarget = value.peakTarget;
  if (isBitrate(value.bitrate)) rule.bitrate = value.bitrate;
  if (typeof value.subfolder === 'string') rule.subfolder = value.subfolder;
  return [rule];
}
