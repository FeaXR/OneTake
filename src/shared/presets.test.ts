import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPresets, DEFAULT_BITRATE_PRESETS, DEFAULT_PEAK_PRESETS, formatPeak, isBitrate, isPeakTarget, NO_NORMALIZE, peakFromPercent, presetChoices } from './presets.ts';

test('volume presets are whole percents from 1 to 100', () => {
  assert.equal(peakFromPercent(80), 0.8);
  assert.equal(peakFromPercent(79.6), 0.8);
  assert.equal(peakFromPercent(0), null);
  assert.equal(peakFromPercent(101), null);
  assert.equal(peakFromPercent(NaN), null);
  assert.equal(formatPeak(0.6), '60%');
  assert.ok(isPeakTarget(0.85));
  assert.ok(!isPeakTarget(1.2));
  assert.ok(!isPeakTarget('1'));
  assert.ok(isPeakTarget(NO_NORMALIZE));
});

test('only bitrates an MP3 can have are accepted', () => {
  assert.ok(isBitrate(128));
  assert.ok(!isBitrate(100));
});

test('saved presets are cleaned, sorted and never left empty', () => {
  assert.deepEqual(cleanPresets([192, 320, 192, 999, 'x'], isBitrate, DEFAULT_BITRATE_PRESETS), [320, 192]);
  assert.deepEqual(cleanPresets([], isBitrate, DEFAULT_BITRATE_PRESETS), [320, 192]);
  assert.deepEqual(cleanPresets(undefined, isBitrate, DEFAULT_BITRATE_PRESETS), [320, 192]);
});

test('the default volume presets end with leaving the level as recorded', () => {
  assert.deepEqual(cleanPresets(undefined, isPeakTarget, DEFAULT_PEAK_PRESETS), [1, 0.6, NO_NORMALIZE]);
});

test('a value in use that is no longer a preset is still offered', () => {
  assert.deepEqual(presetChoices([1, 0.8], 0.6, undefined, 1), [1, 0.8, 0.6]);
});
