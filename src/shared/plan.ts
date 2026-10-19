import type { Cut, Segment, Settings } from './types.ts';

export interface Span {
  start: number;
  end: number;
}

/**
 * The parts of a segment that survive its cuts, in order. Slivers too short to crossfade
 * (shorter than two crossfades) are dropped, since they would just be clicks.
 */
export function keptPieces(segment: Span, cuts: readonly Span[], crossfadeSec: number): Span[] {
  const inside = cuts
    .map((c) => ({ start: Math.max(c.start, segment.start), end: Math.min(c.end, segment.end) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);

  const pieces: Span[] = [];
  let cursor = segment.start;
  for (const cut of inside) {
    if (cut.start > cursor) pieces.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < segment.end) pieces.push({ start: cursor, end: segment.end });

  const minLength = Math.max(2 * crossfadeSec, 0.001);
  return pieces.filter((p) => p.end - p.start >= minLength);
}

/** Length of the exported audio once pieces are joined with crossfades. */
export function joinedDuration(pieces: readonly Span[], crossfadeSec: number): number {
  if (pieces.length === 0) return 0;
  const sum = pieces.reduce((acc, p) => acc + (p.end - p.start), 0);
  return sum - (pieces.length - 1) * crossfadeSec;
}

export function outputDurationOf(segment: Segment, cuts: readonly Cut[], settings: Settings): number {
  const xf = settings.cutCrossfadeMs / 1000;
  return joinedDuration(keptPieces(segment, cuts, xf), xf);
}

/** Linear gain that brings `measuredPeak` to the segment's target, honouring the ceiling setting. */
export function normalizeGain(measuredPeak: number, target: number, ceilingDb: number): number {
  if (measuredPeak <= 0) return 1;
  return (target * 10 ** (ceilingDb / 20)) / measuredPeak;
}
