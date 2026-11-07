import { open, type FileHandle } from 'node:fs/promises';
import { BucketBuilder, GrowingBuckets } from '../shared/peaks.ts';
import type { PeakData } from '../shared/types.ts';
import { encodeInt24, HEADER_BYTES, wavHeaderBytes, type WavLayout } from '../shared/wav.ts';

export { HEADER_BYTES } from '../shared/wav.ts';

/** How often the header sizes are brought up to date, so a crash loses at most this much. */
const HEADER_REFRESH_MS = 1000;

/**
 * Writes a 24-bit PCM WAV while it is being recorded. Samples are appended as they arrive;
 * the sizes in the header are rewritten every second and when the recording is finished.
 * Readers can use the file meanwhile through layout(), which counts only what is written.
 */
export class WavRecorder {
  readonly path: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly blockAlign: number;
  /** Frames on disk. */
  frames = 0;
  private readonly file: FileHandle;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly peaks = new GrowingBuckets();
  private readonly builder = new BucketBuilder((min, max) => this.peaks.push(min, max));
  private headerFrames = -1;
  private finished: Promise<WavLayout> | null = null;

  private constructor(path: string, file: FileHandle, sampleRate: number, channels: number, refreshMs: number) {
    this.path = path;
    this.file = file;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.blockAlign = channels * 3;
    this.timer = setInterval(() => void this.enqueue(() => this.writeHeader(true)), refreshMs);
  }

  /** Creates the file; fails when it already exists, so a recording never overwrites one. */
  static async create(path: string, sampleRate: number, channels: number, refreshMs = HEADER_REFRESH_MS): Promise<WavRecorder> {
    const file = await open(path, 'wx');
    const rec = new WavRecorder(path, file, sampleRate, channels, refreshMs);
    try {
      await rec.enqueue(() => rec.writeHeader(false));
    } catch (err) {
      clearInterval(rec.timer);
      await file.close();
      throw err;
    }
    return rec;
  }

  /** The file as written so far, for playback and export while recording. */
  layout(): WavLayout {
    return {
      path: this.path,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: 24,
      sampleFormat: 'int',
      frames: this.frames,
      duration: this.frames / this.sampleRate,
      dataOffset: HEADER_BYTES,
      dataBytes: this.frames * this.blockAlign,
      blockAlign: this.blockAlign,
    };
  }

  /** Appends one array per channel (-1..1). Resolves to the frames on disk once it is written. */
  append(planes: readonly Float32Array[]): Promise<number> {
    if (this.finished) return Promise.resolve(this.frames);
    const frames = Math.min(...planes.slice(0, this.channels).map((p) => p.length));
    if (planes.length < this.channels || !frames) return this.enqueue(() => this.frames);
    const data = Buffer.from(encodeInt24(planes.map((p) => p.subarray(0, frames)), this.channels).buffer);
    this.builder.push(planes.slice(0, this.channels).map((p) => p.subarray(0, frames)));
    return this.enqueue(async () => {
      await this.write(data, HEADER_BYTES + this.frames * this.blockAlign);
      this.frames += frames;
      return this.frames;
    });
  }

  /** Writes the final header and closes the file. Safe to call more than once. */
  finish(): Promise<WavLayout> {
    this.finished ??= (async () => {
      clearInterval(this.timer);
      try {
        await this.enqueue(() => this.writeHeader(true));
      } finally {
        await this.file.close();
      }
      return this.layout();
    })();
    return this.finished;
  }

  /** The waveform envelope of everything appended, for the peaks cache. */
  peakData(): PeakData {
    this.builder.flush();
    return this.peaks.toPeakData();
  }

  /** Runs file operations one after another, in the order they were asked for. */
  private enqueue<T>(job: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(job);
    this.queue = next.catch(() => {});
    return next;
  }

  private async write(data: Buffer, position: number): Promise<void> {
    let done = 0;
    while (done < data.length) {
      const { bytesWritten } = await this.file.write(data, done, data.length - done, position + done);
      done += bytesWritten;
    }
  }

  private async writeHeader(sync: boolean): Promise<void> {
    if (this.frames === this.headerFrames) return;
    this.headerFrames = this.frames;
    await this.write(wavHeader(this.sampleRate, this.channels, this.frames * this.blockAlign), 0);
    // Pushes the audio and the header to the disk, so a power cut keeps them too.
    if (sync) await this.file.datasync();
  }
}

/** The 80-byte header for `dataBytes` of 24-bit PCM; RF64 once the sizes no longer fit 32 bits. */
export function wavHeader(sampleRate: number, channels: number, dataBytes: number): Buffer {
  return Buffer.from(wavHeaderBytes(sampleRate, channels, dataBytes).buffer);
}
