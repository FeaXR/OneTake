import type { PeakData } from './types.ts';

/** 32 frames per bucket: about 0.7 ms at 48 kHz, fine enough for cutting out a cough. */
export const FRAMES_PER_BUCKET = 32;

/** A -1..1 extreme as stored in PeakData. The file scan and live recording must agree on this. */
export const toPeak = (v: number): number => Math.round(Math.min(1, Math.max(-1, v)) * 32767);

/**
 * Turns samples that arrive in blocks of any size (a live recording) into the same min/max
 * buckets the file scan makes: all channels combined, `framesPerBucket` frames each.
 */
export class BucketBuilder {
  readonly framesPerBucket: number;
  private readonly onBucket: (min: number, max: number) => void;
  private lo = 1;
  private hi = -1;
  private filled = 0;

  constructor(onBucket: (min: number, max: number) => void, framesPerBucket = FRAMES_PER_BUCKET) {
    this.onBucket = onBucket;
    this.framesPerBucket = framesPerBucket;
  }

  /** One array per channel, all the same length. */
  push(planes: readonly Float32Array[]): void {
    const frames = planes[0]?.length ?? 0;
    for (let f = 0; f < frames; f++) {
      for (const plane of planes) {
        const v = plane[f];
        if (v < this.lo) this.lo = v;
        if (v > this.hi) this.hi = v;
      }
      if (++this.filled === this.framesPerBucket) this.emit();
    }
  }

  /** Emits the partial last bucket, as the file scan does at the end of a file. */
  flush(): void {
    if (this.filled > 0) this.emit();
  }

  private emit(): void {
    this.onBucket(toPeak(this.lo), toPeak(this.hi));
    this.lo = 1;
    this.hi = -1;
    this.filled = 0;
  }
}

/** Min/max arrays that grow as buckets are added (capacity doubles, so appends stay cheap). */
export class GrowingBuckets {
  mins: Int16Array;
  maxs: Int16Array;
  length = 0;

  constructor(capacity = 4096) {
    this.mins = new Int16Array(capacity);
    this.maxs = new Int16Array(capacity);
  }

  /** Takes over existing arrays without copying them (a scanned file is not appended to). */
  static from(mins: Int16Array, maxs: Int16Array): GrowingBuckets {
    const b = new GrowingBuckets(0);
    b.mins = mins;
    b.maxs = maxs;
    b.length = mins.length;
    return b;
  }

  push(min: number, max: number): void {
    if (this.length === this.mins.length) {
      const capacity = Math.max(4096, this.mins.length * 2);
      const mins = new Int16Array(capacity);
      const maxs = new Int16Array(capacity);
      mins.set(this.mins);
      maxs.set(this.maxs);
      this.mins = mins;
      this.maxs = maxs;
    }
    this.mins[this.length] = min;
    this.maxs[this.length] = max;
    this.length++;
  }

  toPeakData(framesPerBucket = FRAMES_PER_BUCKET): PeakData {
    return { framesPerBucket, mins: this.mins.slice(0, this.length), maxs: this.maxs.slice(0, this.length) };
  }
}
