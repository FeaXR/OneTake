import { codedError } from '../shared/i18n/index.ts';
import type { Span } from '../shared/plan.ts';
import type { FadeCurve } from '../shared/types.ts';

export interface GraphOptions {
  /** Pieces to keep, relative to the start of the ffmpeg input. */
  pieces: Span[];
  crossfadeSec: number;
  /** Length of the joined result. */
  length: number;
  fadeInSec: number;
  fadeInCurve: FadeCurve;
  fadeOutSec: number;
  fadeOutCurve: FadeCurve;
  /** Linear gain to apply last, or null for the measuring pass. */
  gain: number | null;
}

const num = (v: number) => Number(v.toFixed(6)).toString();

/** Builds an ffmpeg -filter_complex graph: trim pieces, crossfade-join, fade in/out, gain. Output label: [out]. */
export function buildFilterGraph(o: GraphOptions): string {
  if (o.pieces.length === 0) throw codedError('err.noAudioLeft');
  const chains: string[] = [];
  const n = o.pieces.length;

  if (n === 1) {
    const p = o.pieces[0];
    chains.push(`[0:a]aformat=sample_fmts=flt,atrim=start=${num(p.start)}:end=${num(p.end)},asetpts=PTS-STARTPTS[j0]`);
  } else {
    chains.push(`[0:a]aformat=sample_fmts=flt,asplit=${n}${o.pieces.map((_, i) => `[s${i}]`).join('')}`);
    o.pieces.forEach((p, i) => {
      chains.push(`[s${i}]atrim=start=${num(p.start)}:end=${num(p.end)},asetpts=PTS-STARTPTS[p${i}]`);
    });
    let current = 'p0';
    for (let i = 1; i < n; i++) {
      const next = `x${i}`;
      chains.push(`[${current}][p${i}]acrossfade=d=${num(o.crossfadeSec)}:c1=tri:c2=tri[${next}]`);
      current = next;
    }
    chains.push(`[${current}]anull[j0]`);
  }

  const tail: string[] = [];
  if (o.fadeInSec > 0) tail.push(`afade=t=in:st=0:d=${num(o.fadeInSec)}:curve=${o.fadeInCurve}`);
  if (o.fadeOutSec > 0) {
    const st = Math.max(0, o.length - o.fadeOutSec);
    tail.push(`afade=t=out:st=${num(st)}:d=${num(o.fadeOutSec)}:curve=${o.fadeOutCurve}`);
  }
  if (o.gain !== null) tail.push(`volume=${num(o.gain)}:precision=float`);
  if (tail.length === 0) tail.push('anull');
  chains.push(`[j0]${tail.join(',')}[out]`);

  return chains.join(';');
}
