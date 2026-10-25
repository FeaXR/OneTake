// Worker thread: scans the WAV data once and builds the min/max envelope used for drawing.
import { parentPort, workerData } from 'node:worker_threads';
import { openSync, readSync, closeSync } from 'node:fs';
import { toPeak } from '../shared/peaks.ts';
import { sampleReader, type WavLayout } from './wav.ts';

export interface PeaksWorkerInput {
  layout: WavLayout;
  framesPerBucket: number;
}

export type PeaksWorkerMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; mins: Int16Array; maxs: Int16Array }
  | { type: 'error'; message: string };

const { layout, framesPerBucket } = workerData as PeaksWorkerInput;
const post = (msg: PeaksWorkerMessage, transfer: ArrayBuffer[] = []) => parentPort!.postMessage(msg, transfer);

try {
  const { channels, blockAlign, frames } = layout;
  const bucketCount = Math.ceil(frames / framesPerBucket);
  const mins = new Int16Array(bucketCount);
  const maxs = new Int16Array(bucketCount);

  // Chunk size is a whole number of buckets so buckets never straddle a read.
  const framesPerChunk = framesPerBucket * 4096;
  const chunk = new ArrayBuffer(framesPerChunk * blockAlign);
  const buf = Buffer.from(chunk);

  const fd = openSync(layout.path, 'r');
  let frameIndex = 0;
  let bucket = 0;
  let lastReport = 0;

  try {
    while (frameIndex < frames) {
      const wantFrames = Math.min(framesPerChunk, frames - frameIndex);
      const wantBytes = wantFrames * blockAlign;
      let got = 0;
      while (got < wantBytes) {
        const n = readSync(fd, buf, got, wantBytes - got, layout.dataOffset + frameIndex * blockAlign + got);
        if (n === 0) break;
        got += n;
      }
      const chunkFrames = Math.floor(got / blockAlign);
      if (chunkFrames === 0) break;
      const samples = chunkFrames * channels;

      const sampleAt = sampleReader(layout, chunk, samples);

      for (let start = 0; start < chunkFrames; start += framesPerBucket) {
        const end = Math.min(start + framesPerBucket, chunkFrames) * channels;
        let lo = 1;
        let hi = -1;
        for (let i = start * channels; i < end; i++) {
          const v = sampleAt(i);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        mins[bucket] = toPeak(lo);
        maxs[bucket] = toPeak(hi);
        bucket++;
      }

      frameIndex += chunkFrames;
      const fraction = frameIndex / frames;
      if (fraction - lastReport >= 0.01) {
        lastReport = fraction;
        post({ type: 'progress', fraction });
      }
    }
  } finally {
    closeSync(fd);
  }

  post({ type: 'done', mins, maxs }, [mins.buffer, maxs.buffer]);
} catch (err) {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
}
