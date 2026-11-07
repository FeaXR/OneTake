import { trimDir } from './naming.ts';
import { cleanPresets, DEFAULT_BITRATE_PRESETS, DEFAULT_PEAK_PRESETS, isBitrate, isPeakTarget } from './presets.ts';
import { DEFAULT_SETTINGS, type Project, type Settings } from './types.ts';

/** Saved settings filled up with the defaults, with anything invalid replaced by them. */
export function completeSettings(saved: Partial<Settings> | null): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, ...saved };
  // Paths typed into settings.json by hand may end in a separator; the app expects none.
  s.folderRules = (Array.isArray(s.folderRules) ? s.folderRules : []).map((r) => ({ ...r, folder: trimDir(r.folder ?? '') }));
  s.peakPresets = cleanPresets(s.peakPresets, isPeakTarget, DEFAULT_PEAK_PRESETS);
  s.bitratePresets = cleanPresets(s.bitratePresets, isBitrate, DEFAULT_BITRATE_PRESETS);
  if (!isPeakTarget(s.defaultPeakTarget)) s.defaultPeakTarget = DEFAULT_SETTINGS.defaultPeakTarget;
  if (!isBitrate(s.defaultBitrate)) s.defaultBitrate = DEFAULT_SETTINGS.defaultBitrate;
  return s;
}

export const isProject = (p: Project | null): p is Project => !!p && p.version === 1 && Array.isArray(p.segments);
