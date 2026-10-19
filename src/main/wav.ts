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
