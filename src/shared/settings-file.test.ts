import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importSettings, readSettingsFile, settingsFile, SETTINGS_PARTS } from './settings.ts';
import { DEFAULT_SETTINGS, isAccent, type Settings } from './types.ts';

const rule = { id: 'r1', folder: '/music/sunday', template: '{nn}_{type}', types: ['song', 'talk'], bitrate: 192 };

test('an exported file reads back as the same settings and shortcuts', () => {
  const s: Settings = { ...DEFAULT_SETTINGS, fadeInSec: 1.5, fadeOutCurve: 'log', folderRules: [rule], language: 'hu' };
  const read = readSettingsFile(JSON.stringify(settingsFile(s, { 'play.toggle': ['Ctrl+P'] }, '1.6.2')))!;
  assert.deepEqual([...read.parts].sort(), [...SETTINGS_PARTS].sort());
  const imported = importSettings(read, DEFAULT_SETTINGS, SETTINGS_PARTS);
  assert.deepEqual(imported.settings, s);
  assert.deepEqual(imported.shortcuts, { 'play.toggle': ['Ctrl+P'] });
});

test('only the chosen parts are exported, and the file has only those parts', () => {
  const s: Settings = { ...DEFAULT_SETTINGS, fadeInSec: 1.5, folderRules: [rule] };
  const file = settingsFile(s, { 'play.toggle': ['Ctrl+P'] }, '1.6.2', ['fades']);
  assert.equal('shortcuts' in file, false);
  assert.equal('folderRules' in file.settings, false);
  assert.equal(file.settings.fadeInSec, 1.5);
  assert.deepEqual([...readSettingsFile(JSON.stringify(file))!.parts], ['fades']);
});

test('only the chosen parts are imported; the rest stay', () => {
  const s: Settings = { ...DEFAULT_SETTINGS, fadeInSec: 1.5, folderRules: [rule] };
  const read = readSettingsFile(JSON.stringify(settingsFile(s, { 'play.toggle': ['Ctrl+P'] }, '1.6.2')))!;
  const current: Settings = { ...DEFAULT_SETTINGS, fadeInSec: 4 };
  const imported = importSettings(read, current, ['folderRules']);
  assert.equal(imported.settings.fadeInSec, 4);
  assert.deepEqual(imported.settings.folderRules, [rule]);
  assert.equal(imported.shortcuts, null);
});

test('an empty set of changed shortcuts is still a part (it resets them)', () => {
  const read = readSettingsFile(JSON.stringify(settingsFile(DEFAULT_SETTINGS, {}, '1.6.2', ['shortcuts'])))!;
  assert.deepEqual([...read.parts], ['shortcuts']);
  assert.deepEqual(importSettings(read, DEFAULT_SETTINGS, ['shortcuts']).shortcuts, {});
});

test('files that are not settings files are refused', () => {
  assert.equal(readSettingsFile('not json'), null);
  assert.equal(readSettingsFile('{"version":1,"segments":[]}'), null);
  assert.equal(readSettingsFile('{"kind":"one-take-settings","settings":[]}'), null);
});

test('malformed settings keep the current ones', () => {
  const current: Settings = { ...DEFAULT_SETTINGS, fadeOutSec: 3, defaultBitrate: 256, theme: 'light', accent: 'teal' };
  const text = JSON.stringify({
    kind: 'one-take-settings',
    settings: { theme: 'neon', accent: 'url(evil)', fadeInSec: 'loud', fadeInCurve: 'wobble', language: 'xx', defaultBitrate: 7, fadeOutSec: 999, unknown: 1, folderRules: [rule, { folder: '' }, 'x'] },
  });
  const settings = importSettings(readSettingsFile(text)!, current, SETTINGS_PARTS).settings;
  assert.equal(settings.fadeInSec, current.fadeInSec);
  assert.equal(settings.fadeInCurve, current.fadeInCurve);
  assert.equal(settings.language, current.language);
  assert.equal(settings.theme, 'light');
  assert.equal(settings.accent, 'teal');
  assert.equal(settings.defaultBitrate, 256);
  assert.equal(settings.fadeOutSec, 60);
  assert.deepEqual(settings.folderRules, [rule]);
  assert.equal('unknown' in settings, false);
});

test('the accent color is a preset or #rrggbb, and travels with the theme', () => {
  assert.ok(isAccent('purple'));
  assert.ok(isAccent('#12ab9F'));
  for (const bad of ['#fff', 'blue;', '#12ab9g', 'rgb(1,2,3)', 7, null]) assert.equal(isAccent(bad), false, String(bad));
  const s: Settings = { ...DEFAULT_SETTINGS, theme: 'dark', accent: '#c0ffee' };
  const read = readSettingsFile(JSON.stringify(settingsFile(s, {}, '1.8.0', ['theme'])))!;
  assert.deepEqual([...read.parts], ['theme']);
  const imported = importSettings(read, DEFAULT_SETTINGS, ['theme']).settings;
  assert.equal(imported.accent, '#c0ffee');
  assert.equal(imported.theme, 'dark');
});
