import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { Editor } from './editor.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);

test('previewGain follows the selected segment fades on the joined audio', () => {
  const ed = new Editor();
  ed.settings = { ...DEFAULT_SETTINGS, fadeInSec: 2, fadeInCurve: 'tri', fadeOutSec: 4, fadeOutCurve: 'tri', cutCrossfadeMs: 0 };
  ed.project = {
    version: 1,
    outputDirs: [],
    segments: [{ id: 'a', filename: 'A', start: 10, end: 30, peakTarget: 1, bitrate: 320 }],
    // 5 s cut near the end: the fade-out starts 4 s before the end of the joined audio.
    cuts: [{ id: 'c', start: 22, end: 27 }],
  };

  near(ed.previewGain(11), 1); // nothing selected: plain playback
  ed.selection = { kind: 'segment', id: 'a' };
  near(ed.previewGain(5), 1); // outside the segment
  near(ed.previewGain(10), 0);
  near(ed.previewGain(11), 0.5);
  near(ed.previewGain(15), 1);
  // Joined length 15 s; the fade-out covers output 11..15 s, i.e. source 21..22 and 27..30.
  near(ed.previewGain(21), 1);
  near(ed.previewGain(28), 0.5);
  near(ed.previewGain(30), 0);
});
