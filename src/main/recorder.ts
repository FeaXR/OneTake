import { open, type FileHandle } from 'node:fs/promises';
import { BucketBuilder, GrowingBuckets } from '../shared/peaks.ts';
import type { PeakData } from '../shared/types.ts';
import type { WavLayout } from './wav.ts';

/**
 * RIFF header, a 28-byte JUNK chunk and the fmt chunk. The JUNK chunk is where the RF64 ds64
 * chunk goes if the recording outgrows 4 GB (about 4 hours of 48 kHz 24-bit stereo).
 */
export const HEADER_BYTES = 80;
const RIFF_LIMIT = 0xffffffff;
/** How often the header sizes are brought up to date, so a crash loses at most this much. */
const HEADER_REFRESH_MS = 1000;
const INT24_SCALE = 8388608;

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
    const data = Buffer.alloc(frames * this.blockAlign);
    let o = 0;
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < this.channels; c++) {
        const v = Math.round(planes[c][f] * INT24_SCALE);
        data.writeIntLE(v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v, o, 3);
        o += 3;
      }
    }
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
  const h = Buffer.alloc(HEADER_BYTES);
  const riffBytes = HEADER_BYTES - 8 + dataBytes;
  const rf64 = riffBytes > RIFF_LIMIT;
  h.write(rf64 ? 'RF64' : 'RIFF', 0, 'ascii');
  h.writeUInt32LE(rf64 ? RIFF_LIMIT : riffBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write(rf64 ? 'ds64' : 'JUNK', 12, 'ascii');
  h.writeUInt32LE(28, 16);
  if (rf64) {
    h.writeBigUInt64LE(BigInt(riffBytes), 20);
    h.writeBigUInt64LE(BigInt(dataBytes), 28);
    h.writeBigUInt64LE(BigInt(Math.floor(dataBytes / (channels * 3))), 36);
  }
  h.write('fmt ', 48, 'ascii');
  h.writeUInt32LE(16, 52);
  h.writeUInt16LE(1, 56); // PCM
  h.writeUInt16LE(channels, 58);
  h.writeUInt32LE(sampleRate, 60);
  h.writeUInt32LE(sampleRate * channels * 3, 64);
  h.writeUInt16LE(channels * 3, 68);
  h.writeUInt16LE(24, 70);
  h.write('data', 72, 'ascii');
  h.writeUInt32LE(rf64 ? RIFF_LIMIT : dataBytes, 76);
  return h;
}
