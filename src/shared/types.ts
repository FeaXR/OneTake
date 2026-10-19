export type PeakTarget = 1 | 0.6;
export type Bitrate = 320 | 192;

/** One output MP3: a span of the source file plus its export options. Times are in seconds. */
export interface Segment {
  id: string;
  filename: string;
  start: number;
  end: number;
  peakTarget: PeakTarget;
  bitrate: Bitrate;
}

/** A span of the source that is removed from every segment that contains it. */
export interface Cut {
  id: string;
  start: number;
  end: number;
}

/** Editable session state, saved next to the WAV as `<name>.wav.sae.json`. */
export interface Project {
  version: 1;
  segments: Segment[];
  cuts: Cut[];
  outputDir: string | null;
}

/** ffmpeg `afade` curve names offered in the settings. */
export const FADE_CURVES = {
  tri: 'Linear',
  exp: 'Exponential',
  log: 'Logarithmic',
  qsin: 'Quarter sine',
  hsin: 'Half sine',
  esin: 'Exponential sine',
  cub: 'Cubic',
  squ: 'Square root',
} as const;
export type FadeCurve = keyof typeof FADE_CURVES;

/** App-wide settings that are the same for every file. */
export interface Settings {
  fadeInSec: number;
  fadeInCurve: FadeCurve;
  fadeOutSec: number;
  fadeOutCurve: FadeCurve;
  /** Where "100%" lands, in dBFS. 0 matches classic peak normalization; a little below avoids MP3 overshoot. */
  ceilingDb: number;
  /** Crossfade length used to join the audio on both sides of a cut. */
  cutCrossfadeMs: number;
  defaultBitrate: Bitrate;
  defaultPeakTarget: PeakTarget;
}

export const DEFAULT_SETTINGS: Settings = {
  fadeInSec: 0.5,
  fadeInCurve: 'tri',
  fadeOutSec: 2,
  fadeOutCurve: 'exp',
  ceilingDb: 0,
  cutCrossfadeMs: 10,
  defaultBitrate: 320,
  defaultPeakTarget: 1,
};

export interface AudioInfo {
  path: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  sampleFormat: 'int' | 'float';
  frames: number;
  duration: number;
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
  /** Project sidecar found next to the WAV, if any. */
  project: Project | null;
}

export interface ExportRequest {
  wavPath: string;
  outputDir: string;
  segments: Segment[];
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
  message?: string;
}

export interface ExportResult {
  ok: boolean;
  cancelled: boolean;
  written: string[];
  error?: string;
}
