// WAV layout and samples without Node: the desktop app, the server and the browser-only build
// read WAVs with these (the first two through src/main/wav.ts).
import { codedError } from './i18n/index.ts';
import type { AudioInfo } from './types.ts';

export interface WavLayout extends AudioInfo {
  dataOffset: number;
  dataBytes: number;
  blockAlign: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Reads the WAV header (RIFF or RF64) without loading the audio data. `read` returns up to
 * `length` bytes from `position` (fewer at the end of the file).
 */
export async function parseWavLayout(
  path: string,
  fileSize: number,
  read: (position: number, length: number) => Uint8Array | Promise<Uint8Array>,
): Promise<WavLayout> {
  const riff = await read(0, 12);
  const tag = ascii(riff, 0, 4);
  if (riff.length < 12 || (tag !== 'RIFF' && tag !== 'RF64') || ascii(riff, 8, 12) !== 'WAVE') {
    throw codedError('err.notWav');
  }

  let rf64DataSize: number | null = null;
  let fmt: Uint8Array | null = null;
  let dataOffset = -1;
  let dataBytes = 0;
  let pos = 12;

  while (pos + 8 <= fileSize) {
    const header = await read(pos, 8);
    if (header.length < 8) break;
    const id = ascii(header, 0, 4);
    const size = view(header).getUint32(4, true);
    const body = pos + 8;

    if (id === 'ds64') {
      const ds = await read(body, 24);
      rf64DataSize = Number(view(ds).getBigUint64(8, true));
    } else if (id === 'fmt ') {
      fmt = await read(body, Math.min(size, 64));
    } else if (id === 'data') {
      dataOffset = body;
      const declared = size === 0xffffffff && rf64DataSize !== null ? rf64DataSize : size;
      // Recorders that crash leave a zero or oversized length; trust the file size instead.
      dataBytes = declared === 0 || body + declared > fileSize ? fileSize - body : declared;
      break;
    }
    pos = body + size + (size % 2);
  }

  if (!fmt || fmt.length < 16) throw codedError('err.noFmt');
  if (dataOffset < 0) throw codedError('err.noData');

  const f = view(fmt);
  let formatTag = f.getUint16(0, true);
  const channels = f.getUint16(2, true);
  const sampleRate = f.getUint32(4, true);
  const blockAlign = f.getUint16(12, true);
  const bitsPerSample = f.getUint16(14, true);
  if (formatTag === WAVE_FORMAT_EXTENSIBLE && fmt.length >= 26) {
    formatTag = f.getUint16(24, true); // first two bytes of the sub-format GUID
  }

  let sampleFormat: AudioInfo['sampleFormat'];
  if (formatTag === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bitsPerSample)) sampleFormat = 'int';
  else if (formatTag === WAVE_FORMAT_IEEE_FLOAT && [32, 64].includes(bitsPerSample)) sampleFormat = 'float';
  else throw codedError('err.unsupported', { format: formatTag, bits: bitsPerSample });

  if (channels < 1 || sampleRate < 1 || blockAlign !== channels * (bitsPerSample / 8)) {
    throw codedError('err.inconsistent');
  }

  const frames = Math.floor(dataBytes / blockAlign);
  return {
    path,
    sampleRate,
    channels,
    bitsPerSample,
    sampleFormat,
    frames,
    duration: frames / sampleRate,
    dataOffset,
    dataBytes: frames * blockAlign,
    blockAlign,
  };
}

/**
 * Returns a reader for sample i (interleaved) of a block of raw WAV data, scaled to -1..1.
 * `chunk` must start at a frame boundary.
 */
export function sampleReader(
  layout: Pick<WavLayout, 'bitsPerSample' | 'sampleFormat'>,
  chunk: ArrayBuffer,
  samples: number,
): (i: number) => number {
  const { bitsPerSample, sampleFormat } = layout;
  const bytes = new Uint8Array(chunk);
  if (sampleFormat === 'float' && bitsPerSample === 32) {
    const v = new Float32Array(chunk, 0, samples);
    return (i) => v[i];
  }
  if (sampleFormat === 'float') {
    const v = new Float64Array(chunk, 0, samples);
    return (i) => v[i];
  }
  if (bitsPerSample === 16) {
    const v = new Int16Array(chunk, 0, samples);
    return (i) => v[i] / 32768;
  }
  if (bitsPerSample === 24) {
    return (i) => {
      const o = i * 3;
      return (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) / 8388608;
    };
  }
  if (bitsPerSample === 32) {
    const v = new Int32Array(chunk, 0, samples);
    return (i) => v[i] / 2147483648;
  }
  return (i) => (bytes[i] - 128) / 128;
}

/** Whole frames of raw WAV data (starting at a frame boundary) as one Float32Array per channel. */
export function decodeFrames(layout: Pick<WavLayout, 'bitsPerSample' | 'sampleFormat' | 'channels' | 'blockAlign'>, data: Uint8Array): Float32Array[] {
  const { channels, blockAlign } = layout;
  const frames = Math.floor(data.length / blockAlign);
  // The typed-array views need an aligned buffer of their own.
  const chunk = data.byteOffset % 8 === 0 && data.byteLength === data.buffer.byteLength
    ? (data.buffer as ArrayBuffer)
    : data.slice(0, frames * blockAlign).buffer;
  const sampleAt = sampleReader(layout, chunk, frames * channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) out[c][f] = sampleAt(f * channels + c);
  }
  return out;
}

/**
 * RIFF header, a 28-byte JUNK chunk and the fmt chunk. The JUNK chunk is where the RF64 ds64
 * chunk goes if the recording outgrows 4 GB (about 4 hours of 48 kHz 24-bit stereo).
 */
export const HEADER_BYTES = 80;
const RIFF_LIMIT = 0xffffffff;
const INT24_SCALE = 8388608;

/** The 80-byte header for `dataBytes` of 24-bit PCM; RF64 once the sizes no longer fit 32 bits. */
export function wavHeaderBytes(sampleRate: number, channels: number, dataBytes: number): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(HEADER_BYTES);
  const v = view(h);
  const put = (text: string, at: number) => {
    for (let i = 0; i < text.length; i++) h[at + i] = text.charCodeAt(i);
  };
  const riffBytes = HEADER_BYTES - 8 + dataBytes;
  const rf64 = riffBytes > RIFF_LIMIT;
  put(rf64 ? 'RF64' : 'RIFF', 0);
  v.setUint32(4, rf64 ? RIFF_LIMIT : riffBytes, true);
  put('WAVE', 8);
  put(rf64 ? 'ds64' : 'JUNK', 12);
  v.setUint32(16, 28, true);
  if (rf64) {
    v.setBigUint64(20, BigInt(riffBytes), true);
    v.setBigUint64(28, BigInt(dataBytes), true);
    v.setBigUint64(36, BigInt(Math.floor(dataBytes / (channels * 3))), true);
  }
  put('fmt ', 48);
  v.setUint32(52, 16, true);
  v.setUint16(56, 1, true); // PCM
  v.setUint16(58, channels, true);
  v.setUint32(60, sampleRate, true);
  v.setUint32(64, sampleRate * channels * 3, true);
  v.setUint16(68, channels * 3, true);
  v.setUint16(70, 24, true);
  put('data', 72);
  v.setUint32(76, rf64 ? RIFF_LIMIT : dataBytes, true);
  return h;
}

/** One array per channel (-1..1) as interleaved 24-bit PCM, for the first `channels` channels. */
export function encodeInt24(planes: readonly Float32Array[], channels: number): Uint8Array<ArrayBuffer> {
  const frames = Math.min(...planes.slice(0, channels).map((p) => p.length));
  const data = new Uint8Array(frames * channels * 3);
  let o = 0;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      let v = Math.round(planes[c][f] * INT24_SCALE);
      v = v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v;
      data[o++] = v & 0xff;
      data[o++] = (v >> 8) & 0xff;
      data[o++] = (v >> 16) & 0xff;
    }
  }
  return data;
}
