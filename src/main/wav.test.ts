import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFrames, readWavLayout } from './wav.ts';

/** A minimal PCM WAV with the given interleaved integer samples. */
function pcmWav(channels: number, bits: 16 | 24, samples: number[]): Buffer {
  const bytes = bits / 8;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((v, i) => (bits === 16 ? data.writeInt16LE(v, i * 2) : data.writeIntLE(v, i * 3, 3)));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * channels * bytes, 28);
  header.writeUInt16LE(channels * bytes, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('readFrames returns one channel per array, scaled to -1..1, clipped at the end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-wav-'));
  try {
    const file = join(dir, 'a.wav');
    writeFileSync(file, pcmWav(2, 24, [0, 4194304, -8388608, 8388607, 2097152, -4194304]));
    const layout = readWavLayout(file);
    assert.equal(layout.frames, 3);

    const [left, right] = readFrames(layout, 1, 5);
    assert.deepEqual([...left], [-1, 0.25]);
    assert.equal(right.length, 2);
    assert.ok(Math.abs(right[0] - 8388607 / 8388608) < 1e-9);
    assert.equal(right[1], -0.5);

    writeFileSync(file, pcmWav(1, 16, [16384, -32768]));
    assert.deepEqual([...readFrames(readWavLayout(file), 0, 2)[0]], [0.5, -1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
