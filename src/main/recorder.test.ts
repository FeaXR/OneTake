import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { runExport } from './exporter.ts';
import { ffmpegPath } from './ffmpeg.ts';
import { HEADER_BYTES, WavRecorder, wavHeader } from './recorder.ts';
import { readFrames, readWavLayout } from './wav.ts';

/** `frames` of a stereo sine (left) and its negation (right), starting at frame `from`. */
function sine(from: number, frames: number, rate = 48000, amp = 0.5): Float32Array[] {
  const left = new Float32Array(frames);
  for (let i = 0; i < frames; i++) left[i] = amp * Math.sin((2 * Math.PI * 440 * (from + i)) / rate);
  return [left, left.map((v) => -v)];
}

function durationOf(file: string): number {
  const err = spawnSync(ffmpegPath(), ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  if (!m) throw new Error('No duration');
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

test('recording: readable while it grows, header finished on stop, never overwrites', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-rec-'));
  try {
    const file = join(dir, '1025_live.wav');
    const rec = await WavRecorder.create(file, 48000, 2);
    assert.equal(statSync(file).size, HEADER_BYTES);
    // An empty data chunk: readers trust the file size, so the file opens even right after a crash.
    assert.equal(readWavLayout(file).frames, 0);

    assert.equal(await rec.append(sine(0, 1000)), 1000);
    assert.equal(await rec.append(sine(1000, 500)), 1500);
    assert.equal(statSync(file).size, HEADER_BYTES + 1500 * 6);

    const live = rec.layout();
    assert.equal(live.frames, 1500);
    const [left, right] = readFrames(live, 990, 20);
    const expected = sine(990, 20)[0];
    assert.equal(left.length, 20);
    for (let i = 0; i < 20; i++) {
      assert.ok(Math.abs(left[i] - expected[i]) < 1e-6, `left ${i}`);
      assert.ok(Math.abs(right[i] + expected[i]) < 1e-6, `right ${i}`);
    }

    const done = await rec.finish();
    assert.equal(done.frames, 1500);
    assert.equal(await rec.append(sine(0, 10)), 1500, 'nothing is added after stopping');
    const layout = readWavLayout(file);
    assert.equal(layout.frames, 1500);
    assert.equal(layout.bitsPerSample, 24);
    assert.equal(layout.dataOffset, HEADER_BYTES);
    assert.equal(readFileSync(file).readUInt32LE(4), statSync(file).size - 8);

    const peaks = rec.peakData();
    assert.equal(peaks.mins.length, Math.ceil(1500 / peaks.framesPerBucket));
    assert.ok(peaks.maxs.some((v) => v > 16000) && peaks.mins.some((v) => v < -16000));

    await assert.rejects(WavRecorder.create(file, 48000, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the header switches to RF64 when the sizes outgrow 32 bits', () => {
  const small = wavHeader(48000, 2, 6000);
  assert.equal(small.toString('ascii', 0, 4), 'RIFF');
  assert.equal(small.toString('ascii', 12, 16), 'JUNK');
  assert.equal(small.readUInt32LE(76), 6000);

  const big = 6 * 900_000_000;
  const large = wavHeader(48000, 2, big);
  assert.equal(large.toString('ascii', 0, 4), 'RF64');
  assert.equal(large.toString('ascii', 12, 16), 'ds64');
  assert.equal(Number(large.readBigUInt64LE(28)), big);
  assert.equal(Number(large.readBigUInt64LE(36)), big / 6);
  assert.equal(large.readUInt32LE(76), 0xffffffff);

  // readWavLayout takes the size from ds64 (and the file size, as the data is not really there).
  const dir = mkdtempSync(join(tmpdir(), 'sae-rf64-'));
  try {
    const file = join(dir, 'big.wav');
    writeFileSync(file, Buffer.concat([large, Buffer.alloc(600)]));
    const layout = readWavLayout(file);
    assert.equal(layout.dataOffset, HEADER_BYTES);
    assert.equal(layout.frames, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('segments that are already recorded export while the recording goes on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-recexp-'));
  try {
    const file = join(dir, '1025_live.wav');
    const rec = await WavRecorder.create(file, 48000, 2, 60_000);
    // 6 s in blocks, as they come from the audio interface; the header still says 0 bytes.
    for (let f = 0; f < 6 * 48000; f += 4800) await rec.append(sine(f, 4800));
    assert.equal(readFileSync(file).readUInt32LE(76), 0, 'header not refreshed yet');

    const result = await runExport(
      {
        wavPath: file,
        segments: [{ id: 'a', filename: 'First', start: 1, end: 4, peakTarget: 1, bitrate: 192, outputDir: dir }],
        cuts: [],
        settings: { ...DEFAULT_SETTINGS, fadeInSec: 0.1, fadeOutSec: 0.1 },
      },
      () => {},
      new AbortController().signal,
    );
    await rec.append(sine(6 * 48000, 4800));
    await rec.finish();

    assert.equal(result.error, undefined);
    assert.ok(result.ok);
    const length = durationOf(join(dir, 'First.mp3'));
    assert.ok(Math.abs(length - 3) < 0.1, `First.mp3 length ${length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
