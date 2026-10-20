import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { sessionFileFor } from './session-path.ts';

test('session files are named after the WAV and differ per folder', () => {
  const a = sessionFileFor('/docs/Sessions', '/rec/2026/1018_eb.wav', 'linux');
  const b = sessionFileFor('/docs/Sessions', '/rec/2025/1018_eb.wav', 'linux');
  assert.match(basename(a), /^1018_eb-[0-9a-f]{10}\.json$/);
  assert.notEqual(a, b);
  assert.equal(sessionFileFor('/docs/Sessions', '/rec/2026/1018_eb.wav', 'linux'), a);
});

test('on Windows the same file in different letter case maps to one session', () => {
  assert.equal(
    basename(sessionFileFor('/s', '/Rec/1018_EB.wav', 'win32')).replace(/^.*-/, ''),
    basename(sessionFileFor('/s', '/rec/1018_eb.WAV', 'win32')).replace(/^.*-/, ''),
  );
});
