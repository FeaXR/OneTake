import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from './en.ts';
import { hu } from './hu.ts';
import { codedError, formatNumber, resolveLanguage, setLanguage, t, translateCodes } from './index.ts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every translation uses the same placeholders as English', () => {
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const source = en[key];
    const target = hu[key];
    if (typeof source === 'string' && typeof target === 'string') {
      assert.deepEqual(placeholders(target), placeholders(source), key);
    }
  }
});

test('t fills placeholders and plurals', () => {
  setLanguage('en');
  assert.equal(t('status.segment', { n: 3 }), 'Segment #3');
  assert.equal(t('export.allDone', { count: 1 }), 'All 1 file exported.');
  assert.equal(t('export.allDone', { count: 4 }), 'All 4 files exported.');
  setLanguage('hu');
  assert.equal(t('export.allDone', { count: 4 }), 'Mind a(z) 4 fájl exportálva.');
  assert.equal(formatNumber(1.25, 2), '1,25');
  setLanguage('en');
  assert.equal(formatNumber(1.25, 2), '1.25');
});

test('resolveLanguage follows the system locale for "system"', () => {
  assert.equal(resolveLanguage('system', 'hu-HU'), 'hu');
  assert.equal(resolveLanguage('system', 'de-DE'), 'en');
  assert.equal(resolveLanguage('en', 'hu-HU'), 'en');
  assert.equal(resolveLanguage(undefined, 'hu'), 'hu');
});

test('coded errors survive being wrapped in other text', () => {
  const err = codedError('err.unsupported', { format: 85, bits: 16 });
  const wrapped = `Error invoking remote method 'audio:load': Error: ${err.message}`;
  setLanguage('hu');
  assert.match(translateCodes(wrapped), /Nem támogatott WAV kódolás \(85\. formátum, 16 bites\)/);
  setLanguage('en');
});
