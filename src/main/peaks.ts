import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { PeakData } from '../shared/types.ts';
import type { WavLayout } from './wav.ts';
import type { PeaksWorkerInput, PeaksWorkerMessage } from './peaks-worker.ts';

/** 32 frames per bucket: about 0.7 ms at 48 kHz, fine enough for cutting out a cough. */
export const FRAMES_PER_BUCKET = 32;
const CACHE_VERSION = 1;

async function cachePath(cacheDir: string, wavPath: string): Promise<string> {
  const s = await stat(wavPath);
  const key = createHash('sha1')
    .update(`${CACHE_VERSION}|${wavPath.toLowerCase()}|${s.size}|${s.mtimeMs}|${FRAMES_PER_BUCKET}`)
    .digest('hex');
  return join(cacheDir, `${key}.peaks`);
}

async function readCache(file: string): Promise<PeakData | null> {
  try {
    const data = await readFile(file);
    const framesPerBucket = data.readUInt32LE(0);
    const count = data.readUInt32LE(4);
    if (data.length !== 8 + count * 4) return null;
    // Copy into fresh, aligned buffers.
    const mins = new Int16Array(count);
    const maxs = new Int16Array(count);
    new Uint8Array(mins.buffer).set(data.subarray(8, 8 + count * 2));
    new Uint8Array(maxs.buffer).set(data.subarray(8 + count * 2));
    return { framesPerBucket, mins, maxs };
  } catch {
    return null;
  }
}

async function writeCache(file: string, peaks: PeakData): Promise<void> {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(peaks.framesPerBucket, 0);
  header.writeUInt32LE(peaks.mins.length, 4);
  await writeFile(file, Buffer.concat([
    header,
    Buffer.from(peaks.mins.buffer, peaks.mins.byteOffset, peaks.mins.byteLength),
    Buffer.from(peaks.maxs.buffer, peaks.maxs.byteOffset, peaks.maxs.byteLength),
  ]));
}

function computePeaks(workerFile: string, layout: WavLayout, onProgress: (f: number) => void): Promise<PeakData> {
  return new Promise((resolve, reject) => {
    const input: PeaksWorkerInput = { layout, framesPerBucket: FRAMES_PER_BUCKET };
    const worker = new Worker(workerFile, { workerData: input });
    worker.on('message', (msg: PeaksWorkerMessage) => {
      if (msg.type === 'progress') onProgress(msg.fraction);
      else if (msg.type === 'done') resolve({ framesPerBucket: FRAMES_PER_BUCKET, mins: msg.mins, maxs: msg.maxs });
      else reject(new Error(msg.message));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Peak scan stopped with code ${code}`));
    });
  });
}

/** Returns the waveform envelope, from the disk cache when the WAV has not changed. */
export async function loadPeaks(
  layout: WavLayout,
  cacheDir: string,
  workerFile: string,
  onProgress: (fraction: number) => void,
): Promise<PeakData> {
  const file = await cachePath(cacheDir, layout.path);
  const cached = await readCache(file);
  if (cached) return cached;

  const peaks = await computePeaks(workerFile, layout, onProgress);
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeCache(file, peaks);
  } catch {
    // A missing cache only costs time on the next load.
  }
  return peaks;
}
