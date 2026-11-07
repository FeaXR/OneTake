// The export's audio without ffmpeg, for the browser-only build: the same steps as the
// filter graph in src/main/filtergraph.ts (trim, crossfade-join, fade in and out, gain),
// computed the way ffmpeg's atrim, acrossfade, afade and volume filters compute them.
import { joinedDuration, keptPieces, type Span } from './plan.ts';
import type { Cut, FadeCurve, Segment, Settings } from './types.ts';

/** ffmpeg's fade_gain() (libavfilter/af_afade.c): the gain at `index` of a fade `range` samples long. */
export function ffmpegFadeGain(curve: FadeCurve, index: number, range: number): number {
  const g = Math.min(1, Math.max(0, index / range));
  switch (curve) {
    case 'tri': return g;
    case 'exp': return Math.exp(-11.512925464970227 * (1 - g));
    case 'log': return Math.min(1, Math.max(0, 1 + 0.2 * Math.log10(g)));
    case 'qsin': return Math.sin((g * Math.PI) / 2);
    case 'hsin': return (1 - Math.cos(g * Math.PI)) / 2;
    case 'esin': return 1 - Math.cos((Math.PI / 4) * ((2 * g - 1) ** 3 + 1));
    case 'cub': return g * g * g;
    case 'squ': return Math.sqrt(g);
  }
}

/** One segment's audio, worked out in frames of the source WAV. */
export interface RenderPlan {
  channels: number;
  /** Stretches of the source to keep, in frames, in order. */
  pieces: Span[];
  /** Frames each join overlaps (a linear crossfade). */
  crossfade: number;
  /** Length of the joined audio, in frames. */
  frames: number;
  fadeIn: number;
  fadeInCurve: FadeCurve;
  /** Frame of the joined audio where the fade-out starts. */
  fadeOutStart: number;
  fadeOut: number;
  fadeOutCurve: FadeCurve;
}

/** The plan for a segment; null when its cuts leave nothing. */
export function planSegment(seg: Segment, cuts: readonly Cut[], settings: Settings, sampleRate: number, channels: number): RenderPlan | null {
  const xf = settings.cutCrossfadeMs / 1000;
  const kept = keptPieces(seg, cuts, xf);
  if (!kept.length) return null;
  const frame = (t: number) => Math.round(t * sampleRate);
  const crossfade = kept.length > 1 ? frame(xf) : 0;
  const pieces = kept.map((p) => ({ start: frame(p.start), end: frame(p.end) }));
  const frames = pieces.reduce((sum, p) => sum + p.end - p.start, 0) - (pieces.length - 1) * crossfade;
  const length = joinedDuration(kept, xf);
  return {
    channels,
    pieces,
    crossfade,
    frames,
    fadeIn: settings.fadeInSec > 0 ? frame(settings.fadeInSec) : 0,
    fadeInCurve: settings.fadeInCurve,
    fadeOutStart: frame(Math.max(0, length - settings.fadeOutSec)),
    fadeOut: settings.fadeOutSec > 0 ? frame(settings.fadeOutSec) : 0,
    fadeOutCurve: settings.fadeOutCurve,
  };
}

/** Reads `count` frames of the source from `start`, one array per channel (shorter at its end). */
export type FrameReader = (start: number, count: number) => Promise<Float32Array[]>;

export const RENDER_BLOCK = 65536;

/**
 * The finished audio of a plan, in blocks of up to `block` frames (one array per channel),
 * multiplied by `gain`. Each piece after the first overlaps the one before by the crossfade.
 */
export async function* renderPlan(plan: RenderPlan, read: FrameReader, gain = 1, block = RENDER_BLOCK): AsyncGenerator<Float32Array[]> {
  const { pieces, crossfade: xf, channels } = plan;
  const offsets: number[] = [];
  let offset = 0;
  for (const p of pieces) {
    offsets.push(offset);
    offset += p.end - p.start - xf;
  }
  const last = pieces.length - 1;

  for (let from = 0; from < plan.frames; from += block) {
    const to = Math.min(plan.frames, from + block);
    const out = Array.from({ length: channels }, () => new Float32Array(to - from));

    for (const [i, p] of pieces.entries()) {
      const len = p.end - p.start;
      const lo = Math.max(from, offsets[i]);
      const hi = Math.min(to, offsets[i] + len);
      if (hi <= lo) continue;
      const k0 = lo - offsets[i];
      const src = await read(p.start + k0, hi - lo);
      const got = src[0]?.length ?? 0;
      for (let j = 0; j < got; j++) {
        const k = k0 + j;
        // acrossfade with c1=tri:c2=tri: the next piece rises over the overlap as this one falls.
        let g = 1;
        if (i > 0 && k < xf) g *= k / xf;
        if (i < last && k >= len - xf) g *= (len - 1 - k) / xf;
        const o = lo - from + j;
        for (let c = 0; c < channels; c++) out[c][o] += (src[c] ?? src[0])[j] * g;
      }
    }

    const fadeEnd = plan.fadeOutStart + plan.fadeOut;
    for (let o = from; o < to; o++) {
      let g = gain;
      if (plan.fadeIn > 0 && o < plan.fadeIn) g *= ffmpegFadeGain(plan.fadeInCurve, o, plan.fadeIn);
      if (plan.fadeOut > 0 && o >= plan.fadeOutStart) g *= o >= fadeEnd ? 0 : ffmpegFadeGain(plan.fadeOutCurve, fadeEnd - o, plan.fadeOut);
      if (g === 1) continue;
      for (let c = 0; c < channels; c++) out[c][o - from] *= g;
    }
    yield out;
  }
}

/** Loudest sample of a block, all channels. */
export function blockPeak(planes: readonly Float32Array[]): number {
  let peak = 0;
  for (const p of planes) {
    for (let i = 0; i < p.length; i++) {
      const v = Math.abs(p[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}
