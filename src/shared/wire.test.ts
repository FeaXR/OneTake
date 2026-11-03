import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJson, decodePlanes, encodeJson, encodePlanes } from './wire.ts';

test('typed arrays survive the JSON round trip', () => {
  const value = { peaks: { framesPerBucket: 256, mins: new Int16Array([-5, 0, 32767]), maxs: new Int16Array([1, -32768]) }, name: 'x' };
  const back = decodeJson<typeof value>(encodeJson(value));
  assert.deepEqual(back, value);
  assert.ok(back.peaks.mins instanceof Int16Array);
});

test('sample planes round trip, including views into a larger buffer', () => {
  const big = new Float32Array([9, 0.5, -1, 0.25, 9]);
  const planes = [big.subarray(1, 3), new Float32Array([0.125, 1])];
  assert.deepEqual(decodePlanes(encodePlanes(planes)), [new Float32Array([0.5, -1]), new Float32Array([0.125, 1])]);
  assert.deepEqual(decodePlanes(encodePlanes([])), []);
});

test('sample planes decode from a Node Buffer that is a view into a larger pool', () => {
  const encoded = encodePlanes([new Float32Array([0.5, -0.5, 1])]);
  const pooled = Buffer.concat([Buffer.alloc(16), Buffer.from(encoded)]).subarray(16);
  assert.deepEqual(decodePlanes(pooled), [new Float32Array([0.5, -0.5, 1])]);
});

test('a truncated sample block is refused', () => {
  assert.throws(() => decodePlanes(encodePlanes([new Float32Array([1, 2])]).subarray(0, 10)));
});
