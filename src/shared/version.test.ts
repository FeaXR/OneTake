import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from './version.ts';

test('versions compare by their numbers, with or without a leading v', () => {
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
  assert.ok(compareVersions('v1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('0.9.9', 'v1.0.0') < 0);
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
});
