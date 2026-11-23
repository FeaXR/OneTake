import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AMPM, expandSubfolder, matchSubfolder, recordingStart, SUBFOLDER_PARTS, subfolderAmPm, subfolderFields, subfolderStart, usesDateTime } from './subfolders.ts';

const friday = new Date(2026, 9, 30, 19, 5);

test('every built-in part gives what its example says', () => {
  for (const [part, example] of Object.entries(SUBFOLDER_PARTS)) {
    assert.equal(expandSubfolder(`{${part}}`, friday, {}, DEFAULT_AMPM, 'en'), example, part);
  }
});

test('typed fields and AM/PM texts fill the name', () => {
  const ampm = { am: 'délelőtt', pm: 'este' };
  assert.equal(expandSubfolder('{date}_{ampm}_{Venue}', friday, { Venue: ' Budapest ' }, ampm, 'hu'), '261030_este_Budapest');
  assert.equal(expandSubfolder('{date} {ampm}', new Date(2026, 9, 30, 0, 30), {}, ampm, 'hu'), '261030 délelőtt');
  assert.equal(expandSubfolder('{hour12}{ampm}', new Date(2026, 9, 30, 12, 0), {}, DEFAULT_AMPM, 'en'), '12PM');
});

test('{ampm} can be chosen, or left out with its separator', () => {
  assert.equal(expandSubfolder('{date}_{ampm}_{Venue}', friday, { Venue: 'Pécs' }, DEFAULT_AMPM, 'en', 'am'), '261030_AM_Pécs');
  assert.equal(expandSubfolder('{date}_{ampm}_{Venue}', friday, { Venue: 'Pécs' }, DEFAULT_AMPM, 'en', 'none'), '261030_Pécs');
  assert.equal(expandSubfolder('{ampm} {Venue}', friday, { Venue: 'Pécs' }, DEFAULT_AMPM, 'en', 'none'), 'Pécs');
  assert.equal(expandSubfolder('{Venue}-{ampm}', friday, { Venue: 'Pécs' }, DEFAULT_AMPM, 'en', 'none'), 'Pécs');
  assert.deepEqual(matchSubfolder('{date}_{ampm}_{Venue}', '261029_Szeged', DEFAULT_AMPM), { Venue: 'Szeged' });
});

test('fields are the parts that are not built in, each once', () => {
  assert.deepEqual(subfolderFields('{date}_{Venue}_{ Band }_{Venue}'), ['Venue', 'Band']);
  assert.ok(usesDateTime('{yy}-{Venue}'));
  assert.ok(!usesDateTime('{Venue}'));
});

test('existing folders are read back, others are not', () => {
  assert.deepEqual(matchSubfolder('{date}_{ampm}_{Venue}', '261029_PM_Szeged Arena', DEFAULT_AMPM), { Venue: 'Szeged Arena' });
  assert.equal(matchSubfolder('{date}_{ampm}_{Venue}', '2610_PM_Szeged', DEFAULT_AMPM), null);
  assert.equal(matchSubfolder('{date}_{ampm}_{Venue}', 'Szeged_261029', DEFAULT_AMPM), null);
  assert.deepEqual(matchSubfolder('{year} {weekday}', '2026 Friday', DEFAULT_AMPM), {});
});

test('a recording starts its length before the file was last written, on the day its name says', () => {
  const start = recordingStart(new Date(2026, 9, 31, 1, 0).getTime(), 2 * 3600, { year: 2026, month: 10, day: 30 });
  assert.equal(start.getDate(), 30);
  assert.equal(start.getHours(), 23);
  assert.equal(recordingStart(new Date(2026, 9, 30, 21, 0).getTime(), 3600, null).getHours(), 20);
});

test('an existing folder name tells before or after noon', () => {
  const ampm = { am: 'reggel', pm: 'este' };
  assert.equal(subfolderAmPm('{date}_{ampm}_{Venue}', '261029_Este_Szeged', ampm), 'pm');
  assert.equal(subfolderAmPm('{date}_{ampm}_{Venue}', '261029_reggel_Pécs', ampm), 'am');
  assert.equal(subfolderAmPm('{date}_{ampm}_{Venue}', '261029_Szeged', ampm), null);
  assert.equal(subfolderAmPm('{date}_{Venue}', '261029_Szeged', ampm), null);
  assert.deepEqual(matchSubfolder('{date}_{ampm}_{Venue}', '261029_este_Szeged', ampm), { Venue: 'Szeged' });
});

test('an existing folder name gives back the start it was made from', () => {
  const ampm = { am: 'reggel', pm: 'este' };
  const fallback = new Date(2026, 10, 23, 12, 17);
  assert.deepEqual(subfolderStart('{date}_{ampm}_{Venue}', '261029_este_Szeged', ampm, fallback), new Date(2026, 9, 29, 12, 17));
  assert.deepEqual(subfolderStart('{year}-{month}-{day} {time} {Venue}', '2025-03-04 0930 Pécs', ampm, fallback), new Date(2025, 2, 4, 9, 30));
  assert.deepEqual(subfolderStart('{date} {hour12}{ampm}', '261029 7este', ampm, fallback), new Date(2026, 9, 29, 19, 17));
  assert.equal(subfolderStart('{date}_{Venue}', 'Szeged', ampm, fallback), null);
  assert.equal(subfolderStart('{date}_{Venue}', '261399_Szeged', ampm, fallback), null);
  // A field next to a part still reads whole.
  assert.deepEqual(matchSubfolder('{date}_{ampm}_{Venue}', '261029_este_Szeged Aréna', ampm), { Venue: 'Szeged Aréna' });
});
