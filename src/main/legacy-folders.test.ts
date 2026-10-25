import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveLegacyFolder } from './legacy-folders.ts';

test('the old folder moves into the new one, keeping what the new one already has', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-legacy-'));
  try {
    const from = join(dir, 'Studio Audio Editor');
    const to = join(dir, 'One Take');
    mkdirSync(join(from, 'Sessions'), { recursive: true });
    writeFileSync(join(from, 'Sessions', 'a.json'), '{}');
    writeFileSync(join(from, 'settings.json'), 'old');
    writeFileSync(join(from, 'Preferences'), 'old chromium');
    // Electron has already made the new settings folder with its own files.
    mkdirSync(to);
    writeFileSync(join(to, 'Preferences'), 'new chromium');

    assert.deepEqual(moveLegacyFolder(from, to).sort(), ['Sessions', 'settings.json']);
    assert.equal(readFileSync(join(to, 'Sessions', 'a.json'), 'utf8'), '{}');
    assert.equal(readFileSync(join(to, 'settings.json'), 'utf8'), 'old');
    assert.equal(readFileSync(join(to, 'Preferences'), 'utf8'), 'new chromium');
    assert.ok(existsSync(join(from, 'Preferences')), 'what was not moved stays');

    // Run again (every start): nothing left to move.
    assert.deepEqual(moveLegacyFolder(from, to), []);
    assert.deepEqual(moveLegacyFolder(join(dir, 'missing'), join(dir, 'other')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
