import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type Segment } from '../shared/types.ts';
import { Editor } from './editor.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);

test('previewGain follows the selected segment fades on the joined audio', () => {
  const ed = new Editor();
  ed.settings = { ...DEFAULT_SETTINGS, fadeInSec: 2, fadeInCurve: 'tri', fadeOutSec: 4, fadeOutCurve: 'tri', cutCrossfadeMs: 0 };
  ed.project = {
    version: 1,
    outputDirs: [],
    numberStarts: {},
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

test('outputOptions: the file, then the deepest folder rule that sets it, then Settings', () => {
  const ed = new Editor();
  ed.settings = {
    ...DEFAULT_SETTINGS,
    defaultPeakTarget: 1,
    defaultBitrate: 320,
    folderRules: [
      { id: 'p', folder: '/out', template: '', types: [], bitrate: 192 },
      { id: 'c', folder: '/out/quiet', template: '', types: [], peakTarget: 0.6 },
    ],
  };
  const seg = (id: string, outputDir?: string, own: Partial<Segment> = {}): Segment =>
    ({ id, filename: id, start: 0, end: 10, ...(outputDir && { outputDir }), ...own });
  ed.project = {
    version: 1,
    outputDirs: ['/elsewhere', '/out/quiet', '/out'],
    numberStarts: {},
    cuts: [],
    segments: [seg('a'), seg('b', '/out/quiet'), seg('c', '/out', { bitrate: 320 })],
  };
  const [a, b, c] = ed.project.segments.map((s) => ed.outputOptions(s));
  assert.deepEqual([a.peakTarget, a.bitrate], [1, 320]);
  assert.deepEqual([b.peakTarget, b.bitrate], [0.6, 192]);
  assert.deepEqual([c.peakTarget, c.bitrate, c.bitrateDefault], [1, 320, 192]);
});

test('older sessions keep only the volume and bitrate that differ from the Settings defaults', () => {
  const ed = new Editor();
  ed.settings = { ...DEFAULT_SETTINGS, defaultPeakTarget: 1, defaultBitrate: 320 };
  const info = { path: '/a.wav', sampleRate: 48000, channels: 2, bitsPerSample: 16, sampleFormat: 'int' as const, frames: 48000 * 60, duration: 60 };
  const legacy = {
    version: 1 as const, outputDir: '/out', cuts: [],
    segments: [
      { id: 'x', filename: 'X', start: 0, end: 10, peakTarget: 1 as const, bitrate: 192 as const },
      { id: 'y', filename: 'Y', start: 10, end: 20, peakTarget: 0.6 as const, bitrate: 320 as const },
    ],
  };
  // Loading notifies the views on the next frame; there is none outside a browser.
  globalThis.requestAnimationFrame ??= () => 0;
  ed.loadAudio(info.path, info, null as never, legacy as never);
  assert.deepEqual(ed.project.outputDirs, ['/out']);
  assert.deepEqual(ed.project.segments.map((s) => [s.peakTarget, s.bitrate]), [[undefined, 192], [0.6, undefined]]);
});
