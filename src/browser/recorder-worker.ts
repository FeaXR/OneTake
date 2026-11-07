// Web worker: writes a 24-bit WAV into the browser's storage while it is being recorded, as
// src/main/recorder.ts does on the desktop. Only a worker may write a file there in place
// (a sync access handle), which lets playback and export read the file while it grows.
import { BucketBuilder, GrowingBuckets } from '../shared/peaks.ts';
import type { PeakData } from '../shared/types.ts';
import { encodeInt24, HEADER_BYTES, wavHeaderBytes } from '../shared/wav.ts';

/** How often the header sizes are brought up to date, so a crash loses at most this much. */
const HEADER_REFRESH_MS = 1000;

interface SyncHandle {
  read(buffer: Uint8Array, options: { at: number }): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

export type RecorderRequest =
  | { type: 'start'; parts: string[]; sampleRate: number; channels: number }
  | { type: 'append'; planes: Float32Array[] }
  | { type: 'read'; position: number; length: number }
  | { type: 'finish' };

export interface RecorderReply {
  id: number;
  error?: string;
  /** 'exists' when the file is already there, 'quota' when the storage is full. */
  code?: string;
  frames?: number;
  bytes?: Uint8Array;
  peaks?: PeakData;
}

let handle: SyncHandle | null = null;
let sampleRate = 48000;
let channels = 2;
let frames = 0;
let headerFrames = -1;
let timer = 0;
let peaks = new GrowingBuckets();
let builder = new BucketBuilder((min, max) => peaks.push(min, max));

function writeHeader(): void {
  if (!handle || frames === headerFrames) return;
  headerFrames = frames;
  handle.write(wavHeaderBytes(sampleRate, channels, frames * channels * 3), { at: 0 });
  handle.flush();
}

async function start(parts: string[], rate: number, ch: number): Promise<void> {
  if (handle) throw new Error('A recording is already running');
  let dir = await navigator.storage.getDirectory();
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const name = parts[parts.length - 1];
  const taken = await dir.getFileHandle(name).then(() => true, () => false);
  if (taken) throw Object.assign(new Error('exists'), { code: 'exists' });
  const file = await dir.getFileHandle(name, { create: true });
  handle = await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
  sampleRate = rate;
  channels = ch;
  frames = 0;
  headerFrames = -1;
  peaks = new GrowingBuckets();
  builder = new BucketBuilder((min, max) => peaks.push(min, max));
  writeHeader();
  timer = self.setInterval(writeHeader, HEADER_REFRESH_MS);
}

function append(planes: Float32Array[]): number {
  if (!handle || planes.length < channels) return frames;
  const count = Math.min(...planes.slice(0, channels).map((p) => p.length));
  if (!count) return frames;
  const used = planes.slice(0, channels).map((p) => p.subarray(0, count));
  const data = encodeInt24(used, channels);
  let done = 0;
  while (done < data.length) done += handle.write(data.subarray(done), { at: HEADER_BYTES + frames * channels * 3 + done });
  builder.push(used);
  frames += count;
  return frames;
}

function read(position: number, length: number): Uint8Array {
  const end = Math.min(position + length, HEADER_BYTES + frames * channels * 3);
  const out = new Uint8Array(Math.max(0, end - position));
  if (handle && out.length) handle.read(out, { at: position });
  return out;
}

function finish(): { frames: number; peaks: PeakData } | null {
  if (!handle) return null;
  clearInterval(timer);
  writeHeader();
  handle.close();
  handle = null;
  builder.flush();
  return { frames, peaks: peaks.toPeakData() };
}

// Requests are answered in the order they came, like the desktop recorder's queue.
let queue: Promise<unknown> = Promise.resolve();

onmessage = (e: MessageEvent<RecorderRequest & { id: number }>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    const reply: RecorderReply = { id: msg.id };
    const transfer: Transferable[] = [];
    try {
      if (msg.type === 'start') await start(msg.parts, msg.sampleRate, msg.channels);
      else if (msg.type === 'append') reply.frames = append(msg.planes);
      else if (msg.type === 'read') {
        reply.bytes = read(msg.position, msg.length);
        transfer.push(reply.bytes.buffer);
      } else {
        const done = finish();
        if (done) Object.assign(reply, done);
      }
    } catch (err) {
      reply.error = err instanceof Error ? err.message : String(err);
      reply.code = (err as DOMException).name === 'QuotaExceededError' ? 'quota' : (err as { code?: string }).code;
    }
    postMessage(reply, { transfer });
  });
};
