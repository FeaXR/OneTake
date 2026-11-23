import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amPmTextFor, expandTemplate, folderDefault, formatDate, highestNumber, recordingDate, ruleFor, trimDir, type FolderRule } from './naming.ts';

const rule = (id: string, folder: string, extra: Partial<FolderRule> = {}): FolderRule => ({ id, folder, template: '{nn}_', types: [], ...extra });

test('ruleFor picks the deepest folder that contains the output folder', () => {
  const rules = [rule('top', 'D:\\Audio'), rule('deep', 'D:/Audio/Enekek/'), rule('other', 'D:\\Audio2')];
  assert.equal(ruleFor(rules, 'D:\\Audio\\Enekek\\2026')?.id, 'deep');
  assert.equal(ruleFor(rules, 'd:\\audio\\Tanitas')?.id, 'top');
  assert.equal(ruleFor(rules, 'D:\\Audio')?.id, 'top');
  assert.equal(ruleFor(rules, 'D:\\Audio2x'), null);
  assert.equal(ruleFor(rules, null), null);
});

test('a rule without a template does not hide the naming rule of a parent folder', () => {
  const rules = [rule('parent', 'D:\\Audio', { bitrate: 192 }), rule('child', 'D:\\Audio\\Enekek', { template: '', peakTarget: 0.6 })];
  assert.equal(ruleFor(rules, 'D:\\Audio\\Enekek\\x')?.id, 'parent');
  assert.equal(folderDefault(rules, 'D:\\Audio\\Enekek', 'peakTarget'), 0.6);
  assert.equal(folderDefault(rules, 'D:\\Audio\\Enekek', 'bitrate'), 192);
  assert.equal(folderDefault(rules, 'D:\\Other', 'bitrate'), undefined);
});

test('recordingDate reads MMDD and picks the year closest to the file date', () => {
  const oct2026 = new Date(2026, 9, 20).getTime();
  assert.deepEqual(recordingDate('C:\\rec\\1018_du_1en+eb.wav', oct2026), { year: 2026, month: 10, day: 18 });
  // A January file date: a December recording belongs to the year before.
  assert.equal(formatDate(recordingDate('/rec/1228_eb.wav', new Date(2027, 0, 3).getTime())!), '261228');
  assert.equal(formatDate(recordingDate('0720_eb.wav', oct2026)!), '260720');
  assert.equal(recordingDate('eb_0720.wav', oct2026), null);
  assert.equal(recordingDate('1301_x.wav', oct2026), null);
  assert.equal(recordingDate('0229_x.wav', oct2026), null); // no leap year within a year of the file date
});

test('expandTemplate fills in every part', () => {
  const parts = { number: 2, order: 3, date: '261021', type: 'SH', ampm: 'este' };
  assert.equal(expandTemplate('{nn}_{type}_', parts), '02_SH_');
  assert.equal(expandTemplate('{date}_{ampm}_{nn}_', parts), '261021_este_02_');
  assert.equal(expandTemplate('{date}_{n}_', parts), '261021_3_');
  assert.equal(expandTemplate('{date}_', { ...parts, date: null }), '??????_');
});

test('highestNumber finds the last {nn} already used in the folder', () => {
  const files = ['02_SH_113.mp3', '12_HSZ_25.mp3', '7_SH_1.mp3', 'notes.txt', '99x_SH_1.mp3', '261021_1_Enek_13.mp3'];
  assert.equal(highestNumber('{nn}_{type}_', ['SH', 'HSZ'], files), 12);
  assert.equal(highestNumber('{nn}_{type}_', ['SH', 'HSZ'], []), 0);
  assert.equal(highestNumber('{date}_{n}_', [], files), 0);
  // Without a list of choices, {type} still stops at the next underscore.
  assert.equal(highestNumber('{nn}_{type}_', [], ['261021_1_Enek_13.mp3', '05_X_1.mp3']), 261021);
});

test('{ampm} texts come from the deepest rule that sets them, and count for {nn}', () => {
  const rules = [rule('top', '/a', { am: 'reggel', pm: 'este' }), rule('deep', '/a/b', { pm: ' délután ' })];
  assert.deepEqual(amPmTextFor(rules, '/a/b/c'), { am: 'reggel', pm: 'délután' });
  assert.deepEqual(amPmTextFor(rules, '/other'), { am: 'AM', pm: 'PM' });
  const files = ['261021_este_04_x.mp3', '261021_reggel_07_y.mp3', '261021_PM_09_z.mp3'];
  assert.equal(highestNumber('{date}_{ampm}_{nn}_', [], files, { am: 'reggel', pm: 'este' }), 7);
  assert.equal(highestNumber('{date}_{ampm}_{nn}_', [], files), 9);
});

test('trimDir drops separators at the end but keeps a root', () => {
  assert.equal(trimDir('/home/x/Music/'), '/home/x/Music');
  assert.equal(trimDir('C:\\Music\\'), 'C:\\Music');
  assert.equal(trimDir('/'), '/');
  assert.equal(trimDir('C:\\'), 'C:\\');
});
