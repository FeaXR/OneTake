import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BucketBuilder, GrowingBuckets } from '../shared/peaks.ts';
import { PeakPyramid } from './peaks.ts';

/** Two channels of noise-like samples with a slowly changing level. */
function samples(frames: number): Float32Array[] {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const level = 0.2 + 0.7 * Math.abs(Math.sin(i / 50000));
    l[i] = level * Math.sin(i * 0.37) * Math.cos(i * 0.011);
    r[i] = -0.5 * l[i];
  }
  return [l, r];
}

test('a pyramid grown block by block matches one built from the finished envelope', () => {
  const frames = 1_000_003;
  const [l, r] = samples(frames);

  const scanned = new GrowingBuckets();
  const builder = new BucketBuilder((min, max) => scanned.push(min, max));
  builder.push([l, r]);
  builder.flush();
  const whole = new PeakPyramid(scanned.toPeakData());

  const live = PeakPyramid.empty();
  // Odd block sizes, so buckets straddle blocks.
  for (let at = 0, n = 1; at < frames; at += n, n = (n * 7 + 13) % 3001 + 1) {
    live.append([l.subarray(at, Math.min(frames, at + n)), r.subarray(at, Math.min(frames, at + n))]);
  }

  assert.equal(live.levels.length, whole.levels.length);
  const a = { min: 0, max: 0 };
  const b = { min: 0, max: 0 };
  // The live one has not emitted the partial last bucket; compare up to the last whole one.
  const end = Math.floor(frames / 32) * 32;
  for (const [from, to] of [[0, 32], [100, 900], [12345, 512_000], [0, end], [end - 70_000, end], [400_000, 400_001]]) {
    assert.equal(live.range(from, to, a), true);
    whole.range(from, to, b);
    assert.deepEqual(a, b, `${from}..${to}`);
  }
  assert.equal(live.range(frames + 100, frames + 200, a), false);
});
