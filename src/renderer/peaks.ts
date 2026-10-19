import type { PeakData } from '../shared/types.ts';

interface Level {
  framesPerBucket: number;
  mins: Int16Array;
  maxs: Int16Array;
}

/**
 * Multi-resolution min/max envelope. Each level merges four buckets of the one below,
 * so any zoom can be drawn by touching only a handful of buckets per pixel.
 */
export class PeakPyramid {
  readonly levels: Level[];

  constructor(base: PeakData) {
    this.levels = [{ framesPerBucket: base.framesPerBucket, mins: base.mins, maxs: base.maxs }];
    let level = this.levels[0];
    while (level.mins.length > 2048) {
      const count = Math.ceil(level.mins.length / 4);
      const mins = new Int16Array(count);
      const maxs = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        let lo = 32767;
        let hi = -32767;
        const end = Math.min(i * 4 + 4, level.mins.length);
        for (let j = i * 4; j < end; j++) {
          if (level.mins[j] < lo) lo = level.mins[j];
          if (level.maxs[j] > hi) hi = level.maxs[j];
        }
        mins[i] = lo;
        maxs[i] = hi;
      }
      level = { framesPerBucket: level.framesPerBucket * 4, mins, maxs };
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
    const b0 = Math.max(0, Math.floor(from / level.framesPerBucket));
    const b1 = Math.min(level.mins.length, Math.max(b0 + 1, Math.ceil(to / level.framesPerBucket)));
    if (b0 >= b1) return false;
    let lo = 32767;
    let hi = -32767;
    for (let b = b0; b < b1; b++) {
      if (level.mins[b] < lo) lo = level.mins[b];
      if (level.maxs[b] > hi) hi = level.maxs[b];
    }
    out.min = lo / 32767;
    out.max = hi / 32767;
    return true;
  }
}
