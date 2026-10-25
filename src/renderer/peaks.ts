import { BucketBuilder, FRAMES_PER_BUCKET, GrowingBuckets } from '../shared/peaks.ts';
import type { PeakData } from '../shared/types.ts';

interface Level {
  framesPerBucket: number;
  buckets: GrowingBuckets;
}

/** Levels are added until the coarsest has at most this many buckets. */
const TOP_LEVEL_BUCKETS = 2048;

/**
 * Multi-resolution min/max envelope. Each level merges four buckets of the one below,
 * so any zoom can be drawn by touching only a handful of buckets per pixel. While recording
 * it grows: appended samples become new buckets and the coarser levels follow along.
 */
export class PeakPyramid {
  readonly levels: Level[];
  private builder: BucketBuilder | null = null;

  constructor(base: PeakData) {
    this.levels = [{ framesPerBucket: base.framesPerBucket, buckets: GrowingBuckets.from(base.mins, base.maxs) }];
    this.addLevels();
  }

  /** An empty envelope for a recording that is about to start. */
  static empty(): PeakPyramid {
    return new PeakPyramid({ framesPerBucket: FRAMES_PER_BUCKET, mins: new Int16Array(0), maxs: new Int16Array(0) });
  }

  /** Adds recorded samples (one array per channel) to the end. */
  append(planes: readonly Float32Array[]): void {
    this.builder ??= new BucketBuilder((min, max) => this.appendBucket(min, max), this.levels[0].framesPerBucket);
    this.builder.push(planes);
  }

  private appendBucket(min: number, max: number): void {
    const base = this.levels[0].buckets;
    let index = base.length;
    base.push(min, max);
    // Coarser buckets only ever widen as finer ones are added, so merging is enough.
    for (let i = 1; i < this.levels.length; i++) {
      const level = this.levels[i].buckets;
      index = Math.floor(index / 4);
      if (index === level.length) level.push(min, max);
      else {
        if (min < level.mins[index]) level.mins[index] = min;
        if (max > level.maxs[index]) level.maxs[index] = max;
      }
    }
    this.addLevels();
  }

  /** Builds coarser levels on top until the coarsest is small enough. */
  private addLevels(): void {
    let level = this.levels[this.levels.length - 1];
    while (level.buckets.length > TOP_LEVEL_BUCKETS) {
      const below = level.buckets;
      const count = Math.ceil(below.length / 4);
      const next = new GrowingBuckets(count * 2);
      for (let i = 0; i < count; i++) {
        let lo = 32767;
        let hi = -32767;
        const end = Math.min(i * 4 + 4, below.length);
        for (let j = i * 4; j < end; j++) {
          if (below.mins[j] < lo) lo = below.mins[j];
          if (below.maxs[j] > hi) hi = below.maxs[j];
        }
        next.push(lo, hi);
      }
      level = { framesPerBucket: level.framesPerBucket * 4, buckets: next };
      this.levels.push(level);
    }
  }

  /**
   * Min and max (-1..1) over frames [from, to). Writes into `out` to avoid allocation.
   * Returns false when the range holds no audio.
   */
  range(from: number, to: number, out: { min: number; max: number }): boolean {
    const span = Math.max(1, to - from);
    let level = this.levels[0];
    for (const l of this.levels) {
      if (l.framesPerBucket <= span) level = l;
      else break;
    }
    const { mins, maxs, length } = level.buckets;
    const b0 = Math.max(0, Math.floor(from / level.framesPerBucket));
    const b1 = Math.min(length, Math.max(b0 + 1, Math.ceil(to / level.framesPerBucket)));
    if (b0 >= b1) return false;
    let lo = 32767;
    let hi = -32767;
    for (let b = b0; b < b1; b++) {
      if (mins[b] < lo) lo = mins[b];
      if (maxs[b] > hi) hi = maxs[b];
    }
    out.min = lo / 32767;
    out.max = hi / 32767;
    return true;
  }
}
