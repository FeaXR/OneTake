// The browser-only export must sound like the desktop one: its audio is compared with what
// ffmpeg's filter graph makes of the same WAV, and its MP3s with the desktop exporter's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExport, rawInput } from '../main/exporter.ts';
import { buildFilterGraph } from '../main/filtergraph.ts';
import { ffmpegPath } from '../main/ffmpeg.ts';
import { readFrames, readWavLayout, type WavLayout } from '../main/wav.ts';
import { exportSegments, type ExportIo } from './export.ts';
import { mp3Encoder as encoderFor } from './mp3.ts';

const MP3_WASM = readFileSync(join(import.meta.dirname, '../../node_modules/wasm-media-encoders/wasm/mp3.wasm'));
const mp3Encoder = (rate: number, channels: number, bitrate: number) => encoderFor(rate, channels, bitrate, MP3_WASM);
import { joinedDuration, keptPieces } from './plan.ts';
import { planSegment, renderPlan } from './render.ts';
import { DEFAULT_SETTINGS, FADE_CURVES, type ExportRequest, type Settings } from './types.ts';
import { parseWavLayout } from './wav.ts';

function makeWav(dir: string, seconds = 12): string {
  const wav = join(dir, 'source.wav');
  // A sine on the left and quieter noise on the right, so the channels differ.
  execFileSync(ffmpegPath(), [
    '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${seconds}`,
    '-f', 'lavfi', '-i', `anoisesrc=color=pink:sample_rate=48000:amplitude=0.3:duration=${seconds}:seed=7`,
    '-filter_complex', '[0:a][1:a]amerge=inputs=2,volume=-6dB[a]', '-map', '[a]', '-c:a', 'pcm_s24le', wav,
  ]);
  return wav;
}

/** ffmpeg's output for the segment, without gain, as one Float32Array per channel. */
function ffmpegRender(layout: WavLayout, seg: { start: number; end: number }, cuts: { start: number; end: number }[], s: Settings): Float32Array[] {
  const xf = s.cutCrossfadeMs / 1000;
  const pieces = keptPieces(seg, cuts, xf).map((p) => ({ start: p.start - seg.start, end: p.end - seg.start }));
  const graph = buildFilterGraph({
    pieces, crossfadeSec: xf, length: joinedDuration(pieces, xf),
    fadeInSec: s.fadeInSec, fadeInCurve: s.fadeInCurve, fadeOutSec: s.fadeOutSec, fadeOutCurve: s.fadeOutCurve, gain: null,
  });
  const out = execFileSync(ffmpegPath(), [
    '-hide_banner', '-v', 'error', ...rawInput(layout, seg.start, seg.end - seg.start),
    '-filter_complex', graph, '-map', '[out]', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1',
  ], { maxBuffer: 1 << 28 });
  const all = new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
  const ch = layout.channels;
  return Array.from({ length: ch }, (_, c) => all.filter((_, i) => i % ch === c));
}

async function ourRender(layout: WavLayout, seg: { start: number; end: number }, cuts: { start: number; end: number }[], s: Settings): Promise<Float32Array[]> {
  const plan = planSegment({ id: 's', filename: 'x', ...seg }, cuts.map((c, i) => ({ id: `${i}`, ...c })), s, layout.sampleRate, layout.channels)!;
  const parts: Float32Array[][] = [];
  // A small block size, so pieces and crossfades straddle blocks.
  for await (const block of renderPlan(plan, async (start, count) => readFrames(layout, start, count), 1, 7000)) parts.push(block);
  return Array.from({ length: layout.channels }, (_, c) => {
    const joined = new Float32Array(parts.reduce((n, p) => n + p[c].length, 0));
    let o = 0;
    for (const p of parts) {
      joined.set(p[c], o);
      o += p[c].length;
    }
    return joined;
  });
}

/** Largest difference between two renders, allowing ffmpeg to start or end one frame off. */
function difference(a: Float32Array[], b: Float32Array[]): number {
  assert.ok(Math.abs(a[0].length - b[0].length) <= 2, `lengths ${a[0].length} and ${b[0].length}`);
  let best = Infinity;
  for (const shift of [-1, 0, 1]) {
    let worst = 0;
    for (let c = 0; c < a.length; c++) {
      for (let i = 2; i < Math.min(a[c].length, b[c].length) - 2; i++) {
        const j = i + shift;
        if (j < 0 || j >= b[c].length) continue;
        worst = Math.max(worst, Math.abs(a[c][i] - b[c][j]));
      }
    }
    best = Math.min(best, worst);
  }
  return best;
}

test('the browser render matches ffmpeg for every fade curve, with cuts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-render-'));
  try {
    const layout = readWavLayout(makeWav(dir));
    const seg = { start: 1.25, end: 10.5 };
    const cuts = [{ start: 3, end: 3.7 }, { start: 6.1, end: 7.4 }];
    for (const curve of FADE_CURVES) {
      const s: Settings = { ...DEFAULT_SETTINGS, fadeInSec: 0.8, fadeInCurve: curve, fadeOutSec: 1.5, fadeOutCurve: curve, cutCrossfadeMs: 20 };
      const diff = difference(await ourRender(layout, seg, cuts, s), ffmpegRender(layout, seg, cuts, s));
      assert.ok(diff < 1e-5, `${curve}: largest difference ${diff}`);
    }
    // No fades and no cuts: the samples themselves.
    const plain: Settings = { ...DEFAULT_SETTINGS, fadeInSec: 0, fadeOutSec: 0 };
    assert.ok(difference(await ourRender(layout, seg, [], plain), ffmpegRender(layout, seg, [], plain)) < 1e-6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shared WAV parser reads what the desktop one reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-parse-'));
  try {
    const wav = makeWav(dir, 1);
    const bytes = readFileSync(wav);
    const shared = await parseWavLayout(wav, bytes.length, (pos, len) => new Uint8Array(bytes.subarray(pos, pos + len)));
    assert.deepEqual(shared, readWavLayout(wav));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function probe(file: string): { peakDb: number; duration: number; rate: number; bitrate: number } {
  const stats = spawnSync(ffmpegPath(), ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const peak = /max_volume: (-?[\d.]+) dB/.exec(stats);
  const time = [...stats.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  const stream = /Audio: mp3.*?, (\d+) Hz.*?, (\d+) kb\/s/.exec(stats);
  assert.ok(peak && time && stream, stats);
  return {
    peakDb: Number(peak[1]),
    duration: Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]),
    rate: Number(stream[1]),
    bitrate: Number(stream[2]),
  };
}

test('the browser export writes MP3s like the desktop export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-export-'));
  try {
    const wav = makeWav(dir);
    const layout = readWavLayout(wav);
    const request = (out: string): ExportRequest => ({
      wavPath: wav,
      segments: [
        { id: 'a', filename: 'Loud', start: 0, end: 6, peakTarget: 1, bitrate: 320, outputDir: out },
        { id: 'b', filename: 'Quiet', start: 5.5, end: 12, peakTarget: 0.6, bitrate: 192, outputDir: out },
      ],
      cuts: [{ id: 'c', start: 8, end: 9 }],
      settings: DEFAULT_SETTINGS,
    });

    const desktopDir = join(dir, 'desktop');
    const desktop = await runExport(request(desktopDir), () => {}, new AbortController().signal);
    assert.ok(desktop.ok, desktop.error ?? "");

    const browserDir = join(dir, 'browser');
    const files = new Map<string, Uint8Array[]>();
    const io: ExportIo = {
      read: async (start, count) => readFrames(layout, start, count),
      create: async (folder, name) => {
        const chunks: Uint8Array[] = [];
        return {
          write: async (b) => void chunks.push(b),
          close: async () => void files.set(join(folder, name), chunks),
          abort: async () => {},
        };
      },
      encoder: mp3Encoder,
    };
    const phases: string[] = [];
    const result = await exportSegments(request(browserDir), layout, io, (p) => phases.push(p.phase), new AbortController().signal);
    assert.ok(result.ok, result.error ?? "");
    assert.deepEqual(result.written, [join(browserDir, 'Loud.mp3'), join(browserDir, 'Quiet.mp3')]);
    assert.ok(phases.includes('measure') && phases.includes('encode') && phases.at(-1) === 'done');

    for (const name of ['Loud.mp3', 'Quiet.mp3']) {
      const file = join(dir, `browser-${name}`);
      writeFileSync(file, Buffer.concat(files.get(join(browserDir, name))!));
      const ours = probe(file);
      const theirs = probe(join(desktopDir, name));
      assert.equal(ours.rate, 48000, name);
      assert.equal(ours.bitrate, theirs.bitrate, name);
      assert.ok(Math.abs(ours.peakDb - theirs.peakDb) < 0.5, `${name} peak ${ours.peakDb} vs ${theirs.peakDb}`);
      // LAME's encoder delay is not trimmed without the gapless tag ffmpeg writes: a frame or two longer.
      assert.ok(Math.abs(ours.duration - theirs.duration) < 0.08, `${name} length ${ours.duration} vs ${theirs.duration}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cancelled browser export leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sae-cancel-'));
  try {
    const wav = makeWav(dir, 4);
    const layout = readWavLayout(wav);
    const abort = new AbortController();
    let aborted = 0;
    const io: ExportIo = {
      read: async (start, count) => readFrames(layout, start, count),
      create: async () => ({ write: async () => abort.abort(), close: async () => assert.fail('closed'), abort: async () => void aborted++ }),
      encoder: mp3Encoder,
    };
    const result = await exportSegments({
      wavPath: wav,
      segments: [{ id: 'a', filename: 'A', start: 0, end: 4, peakTarget: 1, bitrate: 320, outputDir: dir }],
      cuts: [],
      settings: DEFAULT_SETTINGS,
    }, layout, io, () => {}, abort.signal);
    assert.deepEqual([result.cancelled, result.written, aborted], [true, [], 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
