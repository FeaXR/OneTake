import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { codedError } from '../shared/i18n/index.ts';
import type { AudioInfo } from '../shared/types.ts';

export interface WavLayout extends AudioInfo {
  dataOffset: number;
  dataBytes: number;
  blockAlign: number;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Reads the WAV header (RIFF or RF64) without loading the audio data. */
export function readWavLayout(path: string): WavLayout {
  const fd = openSync(path, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    const read = (pos: number, len: number) => {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, pos);
      return buf.subarray(0, n);
    };

    const riff = read(0, 12);
    const tag = riff.toString('ascii', 0, 4);
    if (riff.length < 12 || (tag !== 'RIFF' && tag !== 'RF64') || riff.toString('ascii', 8, 12) !== 'WAVE') {
      throw codedError('err.notWav');
    }

    let rf64DataSize: number | null = null;
    let fmt: Buffer | null = null;
    let dataOffset = -1;
    let dataBytes = 0;
    let pos = 12;

    while (pos + 8 <= fileSize) {
      const header = read(pos, 8);
      const id = header.toString('ascii', 0, 4);
      const size = header.readUInt32LE(4);
      const body = pos + 8;

      if (id === 'ds64') {
        const ds = read(body, 24);
        rf64DataSize = Number(ds.readBigUInt64LE(8));
      } else if (id === 'fmt ') {
        fmt = read(body, Math.min(size, 64));
      } else if (id === 'data') {
        dataOffset = body;
        const declared = size === 0xffffffff && rf64DataSize !== null ? rf64DataSize : size;
        // Recorders that crash leave a zero or oversized length; trust the file size instead.
        dataBytes = declared === 0 || body + declared > fileSize ? fileSize - body : declared;
        break;
      }
      pos = body + size + (size % 2);
    }

    if (!fmt) throw codedError('err.noFmt');
    if (dataOffset < 0) throw codedError('err.noData');

    let formatTag = fmt.readUInt16LE(0);
    const channels = fmt.readUInt16LE(2);
    const sampleRate = fmt.readUInt32LE(4);
    const blockAlign = fmt.readUInt16LE(12);
    const bitsPerSample = fmt.readUInt16LE(14);
    if (formatTag === WAVE_FORMAT_EXTENSIBLE && fmt.length >= 26) {
      formatTag = fmt.readUInt16LE(24); // first two bytes of the sub-format GUID
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
  } finally {
    closeSync(fd);
  }
}

/**
 * Returns a reader for sample i (interleaved) of a block of raw WAV data, scaled to -1..1.
 * `chunk` must start at a frame boundary.
 */
export function sampleReader(layout: WavLayout, chunk: ArrayBuffer, samples: number): (i: number) => number {
  const { bitsPerSample, sampleFormat } = layout;
  const bytes = new Uint8Array(chunk);
  if (sampleFormat === 'float' && bitsPerSample === 32) {
    const view = new Float32Array(chunk, 0, samples);
    return (i) => view[i];
  }
  if (sampleFormat === 'float') {
    const view = new Float64Array(chunk, 0, samples);
    return (i) => view[i];
  }
  if (bitsPerSample === 16) {
    const view = new Int16Array(chunk, 0, samples);
    return (i) => view[i] / 32768;
  }
  if (bitsPerSample === 24) {
    return (i) => {
      const o = i * 3;
      return (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) / 8388608;
    };
  }
  if (bitsPerSample === 32) {
    const view = new Int32Array(chunk, 0, samples);
    return (i) => view[i] / 2147483648;
  }
  return (i) => (bytes[i] - 128) / 128;
}

/** Reads `count` frames from `start` as one Float32Array per channel (shorter at the end of the file). */
export function readFrames(layout: WavLayout, start: number, count: number): Float32Array[] {
  const { channels, blockAlign } = layout;
  const first = Math.max(0, Math.min(layout.frames, Math.floor(start)));
  const frames = Math.max(0, Math.min(layout.frames - first, Math.floor(count)));
  const chunk = new ArrayBuffer(frames * blockAlign);
  const buf = Buffer.from(chunk);
  let got = 0;
  if (frames > 0) {
    const fd = openSync(layout.path, 'r');
    try {
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, layout.dataOffset + first * blockAlign + got);
        if (n === 0) break;
        got += n;
      }
    } finally {
      closeSync(fd);
    }
  }
  const usable = Math.floor(got / blockAlign);
  const sampleAt = sampleReader(layout, chunk, usable * channels);
  const out = Array.from({ length: channels }, () => new Float32Array(usable));
  for (let f = 0; f < usable; f++) {
    for (let c = 0; c < channels; c++) out[c][f] = sampleAt(f * channels + c);
  }
  return out;
}
