import { test } from 'node:test';
import assert from 'node:assert/strict';
import { de } from './de.ts';
import { en } from './en.ts';
import { es } from './es.ts';
import { fr } from './fr.ts';
import { hu } from './hu.ts';
import { sr } from './sr.ts';
import { codedError, formatNumber, LANGUAGES, resolveLanguage, setLanguage, t, translateCodes, type Language } from './index.ts';

const translations = { de, es, fr, hu, sr };
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('every translation uses the same placeholders as English', () => {
  for (const [lang, table] of Object.entries(translations)) {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const source = en[key];
      const target = table[key];
      if (typeof source === 'string' && typeof target === 'string') {
        assert.deepEqual(placeholders(target), placeholders(source), `${lang} ${key}`);
      }
    }
  }
});

test('texts with plurals show every value, in every language', () => {
  const keys = ['toast.needsFixing', 'dlg.overwrite.message', 'dlg.rec.format', 'export.title', 'export.toMany', 'export.allDone', 'export.cancelledSummary', 'export.errorSummary', 'panel.cuts'] as const;
  for (const lang of Object.keys(LANGUAGES) as Language[]) {
    setLanguage(lang);
    for (const key of keys) {
      for (const n of [0, 1, 2, 5, 11, 21]) {
        const text = t(key, { count: n, channels: n, list: 'LIST', rate: 'RATE', total: 'TOTAL' });
        assert.match(text, new RegExp(`(^|\\D)${n}(\\D|$)`), `${lang} ${key}`);
        assert.doesNotMatch(text, /undefined|\{\w+\}/, `${lang} ${key}`);
      }
    }
  }
  setLanguage('en');
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

test('plural forms follow each language', () => {
  setLanguage('fr');
  assert.equal(t('export.title', { count: 0 }), 'Export de 0 fichier');
  assert.equal(t('export.title', { count: 2 }), 'Export de 2 fichiers');
  setLanguage('sr');
  assert.equal(t('export.title', { count: 1 }), 'Извоз: 1 датотека');
  assert.equal(t('export.title', { count: 3 }), 'Извоз: 3 датотеке');
  assert.equal(t('export.title', { count: 12 }), 'Извоз: 12 датотека');
  assert.equal(t('export.title', { count: 22 }), 'Извоз: 22 датотеке');
  assert.equal(t('export.toMany', { count: 5 }), 'У 5 фасцикли');
  setLanguage('en');
});

test('only English uses a decimal point', () => {
  for (const lang of Object.keys(translations) as Language[]) {
    setLanguage(lang);
    assert.equal(formatNumber(1.25, 2), '1,25', lang);
  }
  setLanguage('en');
});

test('resolveLanguage follows the system locale for "system"', () => {
  assert.equal(resolveLanguage('system', 'hu-HU'), 'hu');
  assert.equal(resolveLanguage('system', 'de-DE'), 'de');
  assert.equal(resolveLanguage('system', 'fr-CA'), 'fr');
  assert.equal(resolveLanguage('system', 'es-419'), 'es');
  assert.equal(resolveLanguage('system', 'sr-Cyrl-RS'), 'sr');
  assert.equal(resolveLanguage('system', 'ja-JP'), 'en');
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
