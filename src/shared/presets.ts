import { t } from './i18n/index.ts';
import type { Bitrate, PeakTarget } from './types.ts';

/** Bitrates an MP3 (MPEG-1 Layer III and its 22/24 kHz variant) can be written at, in kbps. */
export const MP3_BITRATES: readonly Bitrate[] = [320, 256, 224, 192, 160, 128, 112, 96, 80, 64, 56, 48, 40, 32, 24, 16, 8];
/** The volume target that leaves the level as recorded (no normalization). */
export const NO_NORMALIZE: PeakTarget = 0;
export const DEFAULT_PEAK_PRESETS: readonly PeakTarget[] = [1, 0.6, NO_NORMALIZE];
export const DEFAULT_BITRATE_PRESETS: readonly Bitrate[] = [320, 192];
/** Volume presets are whole percents of full scale, from 1% to 100%. */
export const MIN_PEAK_PERCENT = 1;

/** A volume target as the percent shown on the buttons. */
export const formatPeak = (v: PeakTarget): string => (v === NO_NORMALIZE ? t('peak.off') : `${Math.round(v * 100)}%`);

/** A volume typed as a percent, or null when it is not one a preset can hold. */
export function peakFromPercent(percent: number): PeakTarget | null {
  const p = Math.round(percent);
  return Number.isFinite(percent) && p >= MIN_PEAK_PERCENT && p <= 100 ? p / 100 : null;
}

export const isPeakTarget = (v: unknown): v is PeakTarget =>
  v === NO_NORMALIZE || (typeof v === 'number' && peakFromPercent(v * 100) !== null);
export const isBitrate = (v: unknown): v is Bitrate => MP3_BITRATES.includes(v as Bitrate);

/** Presets from a settings file: valid, without repeats, highest first; the defaults when none are left. */
export function cleanPresets<T extends number>(values: unknown, valid: (v: unknown) => v is T, fallback: readonly T[]): T[] {
  const list = Array.isArray(values) ? [...new Set(values.filter(valid))].sort((a, b) => b - a) : [];
  return list.length ? list : [...fallback];
}

/**
 * The buttons to offer: the presets plus any value in use that is no longer one (a preset that
 * was removed later), so it still shows as chosen. Highest first.
 */
export function presetChoices<T extends number>(presets: readonly T[], ...inUse: (T | undefined)[]): T[] {
  return [...new Set([...presets, ...inUse.filter((v): v is T => v !== undefined)])].sort((a, b) => b - a);
}
