import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinedDuration, keptPieces, normalizeGain } from './plan.ts';
import { filenameProblem, outputFilename, validateSegments } from './validate.ts';
import { formatTime, parseTime } from './time.ts';
import { DEFAULT_SETTINGS, type Segment } from './types.ts';

const seg = (id: string, start: number, end: number, filename = id): Segment => ({
  id, filename, start, end, peakTarget: 1, bitrate: 320,
});

test('keptPieces removes cuts inside the segment and ignores ones outside', () => {
  const pieces = keptPieces({ start: 10, end: 20 }, [
    { start: 0, end: 5 },
    { start: 12, end: 13 },
    { start: 12.5, end: 14 },
    { start: 19, end: 30 },
  ], 0.01);
  assert.deepEqual(pieces, [{ start: 10, end: 12 }, { start: 14, end: 19 }]);
});

test('keptPieces drops slivers shorter than two crossfades', () => {
  const pieces = keptPieces({ start: 0, end: 10 }, [
    { start: 2, end: 5 },
    { start: 5.015, end: 6 },
  ], 0.01);
  assert.deepEqual(pieces, [{ start: 0, end: 2 }, { start: 6, end: 10 }]);
});

test('keptPieces with a cut covering the whole segment leaves nothing', () => {
  assert.deepEqual(keptPieces({ start: 1, end: 2 }, [{ start: 0, end: 3 }], 0.01), []);
});

test('joinedDuration subtracts one crossfade per join', () => {
  const d = joinedDuration([{ start: 0, end: 2 }, { start: 5, end: 8 }], 0.01);
  assert.ok(Math.abs(d - 4.99) < 1e-9);
});

test('normalizeGain hits the target and ceiling', () => {
  assert.equal(normalizeGain(0.5, 1, 0), 2);
  assert.ok(Math.abs(normalizeGain(0.5, 0.6, 0) - 1.2) < 1e-12);
  assert.ok(Math.abs(normalizeGain(1, 1, -6.0206) - 0.5) < 1e-4);
});

test('filename rules', () => {
  assert.equal(outputFilename('Track 1'), 'Track 1.mp3');
  assert.equal(outputFilename('Track 1.MP3'), 'Track 1.MP3');
  assert.equal(filenameProblem('Track 1'), null);
  assert.equal(filenameProblem('')!.key, 'issue.filenameRequired');
  assert.equal(filenameProblem('a?b')!.key, 'issue.filenameChars');
  assert.equal(filenameProblem('name.')!.key, 'issue.filenameEnd');
  assert.deepEqual(filenameProblem('con'), { key: 'issue.filenameReserved', params: { name: 'con' } });
  assert.equal(filenameProblem('NUL.mp3')!.key, 'issue.filenameReserved');
});

test('validateSegments flags duplicate names case-insensitively', () => {
  const issues = validateSegments(
    [seg('a', 0, 60, 'Intro'), seg('b', 60, 120, 'intro.mp3'), seg('c', 120, 180, 'Outro')],
    [],
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(issues.get('a')!.errors, [{ key: 'issue.duplicate', params: { others: '#2' } }]);
  assert.deepEqual(issues.get('b')!.errors, [{ key: 'issue.duplicate', params: { others: '#1' } }]);
  assert.deepEqual(issues.get('c')!.errors, []);
});

test('validateSegments flags too-short segments and big overlaps', () => {
  const issues = validateSegments([seg('a', 0, 100), seg('b', 90, 91)], [], DEFAULT_SETTINGS);
  assert.deepEqual(issues.get('a')!.warnings, [{ key: 'issue.overlap', params: { n: 2 } }]);
  assert.deepEqual(issues.get('b')!.errors, [{ key: 'issue.tooShort' }]);
});

test('time formatting and parsing round-trip', () => {
  assert.equal(formatTime(3725.5), '1:02:05.500');
  assert.equal(formatTime(65.25), '1:05.250');
  assert.equal(parseTime('1:02:05.5'), 3725.5);
  assert.equal(parseTime('65,25'), 65.25);
  assert.equal(parseTime('1:5'), 65);
  assert.equal(parseTime('abc'), null);
  assert.equal(parseTime('1::2'), null);
});
