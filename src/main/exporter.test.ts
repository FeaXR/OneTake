import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExport } from './exporter.ts';
import { buildFilterGraph } from './filtergraph.ts';
import { ffmpegPath } from './ffmpeg.ts';
import { readWavLayout } from './wav.ts';
import { DEFAULT_SETTINGS, type ExportProgress } from '../shared/types.ts';

/** ffmpeg's stderr for the given args (it reports stats there). */
function ffmpegStderr(args: string[]): string {
  return spawnSync(ffmpegPath(), ['-hide_banner', ...args], { encoding: 'utf8' }).stderr;
}

function maxVolumeDb(file: string): number {
  const m = /max_volume: (-?[\d.]+) dB/.exec(ffmpegStderr(['-i', file, '-af', 'volumedetect', '-f', 'null', '-']));
  if (!m) throw new Error('volumedetect gave no result');
  return Number(m[1]);
}

function durationOf(file: string): number {
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(ffmpegStderr(['-i', file]));
  if (!m) throw new Error('No duration');
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

test('filter graph joins pieces with crossfades and applies fades and gain last', () => {
  const graph = buildFilterGraph({
    pieces: [{ start: 0, end: 2 }, { start: 3, end: 5 }],
    crossfadeSec: 0.01,
    length: 3.99,
    fadeInSec: 0.5,
    fadeInCurve: 'tri',
    fadeOutSec: 1,
    fadeOutCurve: 'exp',
    gain: 1.5,
  });
  assert.match(graph, /asplit=2\[s0\]\[s1\]/);
  assert.match(graph, /\[p0\]\[p1\]acrossfade=d=0\.01:c1=tri:c2=tri\[x1\]/);
  assert.match(graph, /afade=t=in:st=0:d=0\.5:curve=tri,afade=t=out:st=2\.99:d=1:curve=exp,volume=1\.5:precision=float\[out\]$/);
});

test('export writes normalized, cut MP3s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-test-'));
  try {
    const wav = join(dir, 'source.wav');
    // 20 s stereo 24-bit sine at -12 dBFS.
    execFileSync(ffmpegPath(), [
      '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
      '-af', 'volume=-12dB', '-ac', '2', '-c:a', 'pcm_s24le', wav,
    ]);
    const layout = readWavLayout(wav);
    assert.equal(layout.sampleRate, 48000);
    assert.equal(layout.channels, 2);
    assert.equal(layout.bitsPerSample, 24);
    assert.ok(Math.abs(layout.duration - 20) < 0.01);

    const progress: ExportProgress[] = [];
    const result = await runExport(
      {
        wavPath: wav,
        segments: [
          { id: 'a', filename: 'Full', start: 0, end: 10, peakTarget: 1, bitrate: 320, outputDir: dir },
          { id: 'b', filename: 'Quiet.mp3', start: 9.5, end: 20, peakTarget: 0.6, bitrate: 192, outputDir: dir },
        ],
        cuts: [{ id: 'c', start: 12, end: 14 }],
        settings: DEFAULT_SETTINGS,
      },
      (p) => progress.push(p),
      new AbortController().signal,
    );

    assert.equal(result.error, undefined);
    assert.ok(result.ok);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.mp3')).sort(), ['Full.mp3', 'Quiet.mp3']);
    assert.ok(progress.some((p) => p.phase === 'done' && p.filename === 'Quiet.mp3'));

    const loud = maxVolumeDb(join(dir, 'Full.mp3'));
    const quiet = maxVolumeDb(join(dir, 'Quiet.mp3'));
    assert.ok(loud > -0.6 && loud <= 0.3, `Full.mp3 peak ${loud} dB`);
    assert.ok(Math.abs(quiet - 20 * Math.log10(0.6)) < 0.6, `Quiet.mp3 peak ${quiet} dB`);

    // 10.5 s minus the 2 s cut, minus one 10 ms crossfade (MP3 padding adds a few ms).
    const length = durationOf(join(dir, 'Quiet.mp3'));
    assert.ok(Math.abs(length - 8.49) < 0.1, `Quiet.mp3 length ${length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
