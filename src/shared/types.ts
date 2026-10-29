import type { LanguageSetting } from './i18n/index.ts';
import type { FolderRule } from './naming.ts';

import { DEFAULT_BITRATE_PRESETS, DEFAULT_PEAK_PRESETS } from './presets.ts';

/** Loudest peak as a share of full scale (1 = 100%). */
export type PeakTarget = number;
/** MP3 bitrate in kbps, one of MP3_BITRATES. */
export type Bitrate = number;

/** One output MP3: a span of the source file plus its export options. Times are in seconds. */
export interface Segment {
  id: string;
  filename: string;
  start: number;
  end: number;
  /** Set when this file differs from its folder's default (see FolderRule and Settings). */
  peakTarget?: PeakTarget;
  bitrate?: Bitrate;
  /** One of the project's extra output folders; unset means the default (first) folder. */
  outputDir?: string;
  /** Choice for the naming rule's {type}; unset means its first option. */
  type?: string;
  /** False when the whole name is typed, ignoring the folder's naming rule. */
  autoName?: false;
}

/** A span of the source that is removed from every segment that contains it. */
export interface Cut {
  id: string;
  start: number;
  end: number;
}

/** Editable session state, saved in Documents/One Take/Sessions (one file per WAV). */
export interface Project {
  version: 1;
  segments: Segment[];
  cuts: Cut[];
  /** Output folders; the first is the default for segments that do not choose another. */
  outputDirs: string[];
  /** First {nn} per output folder, found once from the files already there and then kept. */
  numberStarts: Record<string, number>;
}

/** The folder a segment is written to, or null when the project has no folder yet. */
export function segmentFolder(project: Pick<Project, 'outputDirs'>, seg: Segment): string | null {
  if (seg.outputDir && project.outputDirs.includes(seg.outputDir)) return seg.outputDir;
  return project.outputDirs[0] ?? null;
}

/** ffmpeg `afade` curve names offered in the settings (labels are translated as `curve.<name>`). */
export const FADE_CURVES = ['tri', 'exp', 'log', 'qsin', 'hsin', 'esin', 'cub', 'squ'] as const;
export type FadeCurve = (typeof FADE_CURVES)[number];

/** Line styles for the timeline markers where fades meet full volume (labels are translated as `marker.<name>`). */
export const FADE_MARKER_STYLES = ['dotted', 'dashed', 'dashdot'] as const;
export type FadeMarkerStyle = (typeof FADE_MARKER_STYLES)[number];

/** App-wide settings that are the same for every file. */
export interface Settings {
  language: LanguageSetting;
  fadeInSec: number;
  fadeInCurve: FadeCurve;
  fadeOutSec: number;
  fadeOutCurve: FadeCurve;
  fadeMarkerStyle: FadeMarkerStyle;
  /** Where "100%" lands, in dBFS. 0 matches classic peak normalization; a little below avoids MP3 overshoot. */
  ceilingDb: number;
  /** Crossfade length used to join the audio on both sides of a cut. */
  cutCrossfadeMs: number;
  defaultBitrate: Bitrate;
  defaultPeakTarget: PeakTarget;
  /** The volume and bitrate buttons offered for each file, highest first. */
  peakPresets: PeakTarget[];
  bitratePresets: Bitrate[];
  folderRules: FolderRule[];
  /** Show each file's start and end time in the file list (they can be set on the timeline too). */
  showSegmentTimes: boolean;
  /** Last recording's folder, name after its MMDD_ date, and input (by its name, as ids can change). */
  recordFolder: string;
  recordName: string;
  recordInput: string;
  /** Look for a new version on GitHub when the app starts. */
  checkUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'system',
  fadeInSec: 0.5,
  fadeInCurve: 'tri',
  fadeOutSec: 2,
  fadeOutCurve: 'exp',
  fadeMarkerStyle: 'dashed',
  ceilingDb: 0,
  cutCrossfadeMs: 10,
  defaultBitrate: 320,
  defaultPeakTarget: 1,
  peakPresets: [...DEFAULT_PEAK_PRESETS],
  bitratePresets: [...DEFAULT_BITRATE_PRESETS],
  folderRules: [],
  showSegmentTimes: false,
  recordFolder: '',
  recordName: '',
  recordInput: '',
  checkUpdates: true,
};

export interface AudioInfo {
  path: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  sampleFormat: 'int' | 'float';
  frames: number;
  duration: number;
  /** File modification time (ms), used to tell the year of a date in the file name. */
  modified?: number;
}

/** Min/max envelope of the whole file (all channels combined), one pair per bucket of frames. */
export interface PeakData {
  framesPerBucket: number;
  mins: Int16Array;
  maxs: Int16Array;
}

export interface LoadedAudio {
  info: AudioInfo;
  peaks: PeakData;
  /** The WAV's saved session, if any. */
  project: Project | null;
}

export interface ExportRequest {
  wavPath: string;
  /** Each segment with its full filename, folder and output options resolved. */
  segments: (Segment & { outputDir: string; peakTarget: PeakTarget; bitrate: Bitrate })[];
  cuts: Cut[];
  settings: Settings;
}

export interface ExportProgress {
  index: number;
  total: number;
  filename: string;
  phase: 'measure' | 'encode' | 'done' | 'error';
  /** 0..1 within the current file. */
  fraction: number;
  /** Set when phase is 'done': measured peak and applied gain, in dB. */
  peakDb?: number;
  gainDb?: number;
}

export interface ExportResult {
  ok: boolean;
  cancelled: boolean;
  written: string[];
  error?: string;
}

/**
 * Where an update stands. 'ready': downloaded, installed on restart. 'available': this copy
 * cannot update itself (portable, .deb, Mac), so the download page is offered instead.
 */
export type UpdateState =
  | { status: 'idle' | 'checking' | 'none' | 'unsupported' }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready' | 'available'; version: string }
  | { status: 'error'; message: string };
