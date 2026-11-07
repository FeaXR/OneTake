// Web worker: scans a WAV once and builds the min/max envelope used for drawing, as
// src/main/peaks-worker.ts does for the desktop app.
import { toPeak } from '../shared/peaks.ts';
import { sampleReader, type WavLayout } from '../shared/wav.ts';

export interface PeaksRequest {
  file: Blob;
  layout: WavLayout;
  framesPerBucket: number;
}

export type PeaksMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; mins: Int16Array; maxs: Int16Array }
  | { type: 'error'; message: string };

const post = (msg: PeaksMessage, transfer: Transferable[] = []) => postMessage(msg, { transfer });

onmessage = async (e: MessageEvent<PeaksRequest>) => {
  const { file, layout, framesPerBucket } = e.data;
  try {
    const { channels, blockAlign, frames } = layout;
    const bucketCount = Math.ceil(frames / framesPerBucket);
    const mins = new Int16Array(bucketCount);
    const maxs = new Int16Array(bucketCount);
    // A whole number of buckets per read, so buckets never straddle one.
    const framesPerChunk = framesPerBucket * 4096;
    let frameIndex = 0;
    let bucket = 0;
    let lastReport = 0;

    while (frameIndex < frames) {
      const want = Math.min(framesPerChunk, frames - frameIndex);
      const from = layout.dataOffset + frameIndex * blockAlign;
      const chunk = await file.slice(from, from + want * blockAlign).arrayBuffer();
      const chunkFrames = Math.floor(chunk.byteLength / blockAlign);
      if (chunkFrames === 0) break;
      const sampleAt = sampleReader(layout, chunk, chunkFrames * channels);
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
    post({ type: 'done', mins, maxs }, [mins.buffer, maxs.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
