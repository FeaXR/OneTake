import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { joinedDuration, keptPieces, normalizeGain } from '../shared/plan.ts';
import { outputFilename } from '../shared/validate.ts';
import type { ExportProgress, ExportRequest, ExportResult, Segment } from '../shared/types.ts';
import { buildFilterGraph } from './filtergraph.ts';
import { ffmpegPath } from './ffmpeg.ts';
import { readWavLayout, type WavLayout } from './wav.ts';

class Cancelled extends Error {}

/** ffmpeg's raw sample format for the WAV's samples. */
function rawFormat(layout: WavLayout): string {
  if (layout.sampleFormat === 'float') return layout.bitsPerSample === 64 ? 'f64le' : 'f32le';
  return layout.bitsPerSample === 8 ? 'u8' : `s${layout.bitsPerSample}le`;
}

/**
 * ffmpeg input options that read the WAV's samples as raw PCM, starting at its data chunk.
 * The header is not used, so a file that is still being recorded (whose header sizes lag
 * behind) exports the same as a finished one.
 */
export function rawInput(layout: WavLayout, start: number, length: number): string[] {
  return [
    '-f', rawFormat(layout), '-ar', String(layout.sampleRate), '-ac', String(layout.channels),
    '-skip_initial_bytes', String(layout.dataOffset),
    '-ss', start.toFixed(6), '-t', length.toFixed(6),
    '-i', layout.path,
  ];
}

/** Runs ffmpeg; `onStdout` sees every output chunk. Rejects with ffmpeg's stderr on failure. */
function runFfmpeg(args: string[], signal: AbortSignal, onStdout: (chunk: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const child: ChildProcess = spawn(ffmpegPath(), args, { windowsHide: true });
    let stderr = '';
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout!.on('data', onStdout);
    child.stderr!.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      signal.removeEventListener('abort', abort);
      reject(err);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(new Cancelled());
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Renders every segment to MP3 in two ffmpeg passes: the first measures the peak of the
 * finished audio (after cuts and fades), the second applies the normalizing gain and encodes.
 */
export async function runExport(
  req: ExportRequest,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  const layout = readWavLayout(req.wavPath);
  const { settings } = req;
  const xf = settings.cutCrossfadeMs / 1000;
  const segments = [...req.segments].sort((a, b) => a.start - b.start);
  const written: string[] = [];
  let current: Segment | null = null;
  let tempFile: string | null = null;

  try {
    for (const [index, seg] of segments.entries()) {
      current = seg;
      const filename = outputFilename(seg.filename);
      const report = (phase: ExportProgress['phase'], fraction: number, extra: Partial<ExportProgress> = {}) =>
        onProgress({ index, total: segments.length, filename, phase, fraction, ...extra });

      const pieces = keptPieces(seg, req.cuts, xf).map((p) => ({ start: p.start - seg.start, end: p.end - seg.start }));
      const length = joinedDuration(pieces, xf);
      const graph = (gain: number | null) =>
        buildFilterGraph({
          pieces,
          crossfadeSec: xf,
          length,
          fadeInSec: settings.fadeInSec,
          fadeInCurve: settings.fadeInCurve,
          fadeOutSec: settings.fadeOutSec,
          fadeOutCurve: settings.fadeOutCurve,
          gain,
        });
      const input = ['-hide_banner', '-nostdin', '-v', 'error', ...rawInput(layout, seg.start, seg.end - seg.start)];

      // Pass 1: stream the finished float audio back and find its peak.
      report('measure', 0);
      const expectedSamples = Math.max(1, length * layout.sampleRate * layout.channels);
      let peak = 0;
      let samplesSeen = 0;
      let carry = Buffer.alloc(0);
      let lastReport = 0;
      await runFfmpeg(
        [...input, '-filter_complex', graph(null), '-map', '[out]', '-f', 'f32le', '-c:a', 'pcm_f32le', 'pipe:1'],
        signal,
        (chunk) => {
          const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
          const usable = data.length - (data.length % 4);
          for (let o = 0; o < usable; o += 4) {
            const v = Math.abs(data.readFloatLE(o));
            if (v > peak) peak = v;
          }
          carry = Buffer.from(data.subarray(usable));
          samplesSeen += usable / 4;
          const fraction = Math.min(1, samplesSeen / expectedSamples);
          if (fraction - lastReport > 0.02) {
            lastReport = fraction;
            report('measure', fraction);
          }
        },
      );

      // Pass 2: same graph plus gain, encoded to a temp file that is renamed on success.
      const gain = normalizeGain(peak, seg.peakTarget, settings.ceilingDb);
      const finalPath = join(seg.outputDir, filename);
      tempFile = `${finalPath}.part`;
      // A folder named by a subfolder rule is only made now, when something is written into it.
      await mkdir(seg.outputDir, { recursive: true });
      report('encode', 0);
      let progressText = '';
      await runFfmpeg(
        [
          ...input,
          '-filter_complex', graph(gain), '-map', '[out]',
          '-c:a', 'libmp3lame', '-b:a', `${seg.bitrate}k`,
          '-map_metadata', '-1', '-id3v2_version', '3',
          '-progress', 'pipe:1', '-nostats',
          '-f', 'mp3', '-y', tempFile,
        ],
        signal,
        (chunk) => {
          progressText += chunk.toString();
          const lines = progressText.split('\n');
          progressText = lines.pop() ?? '';
          for (const line of lines) {
            const m = /^out_time_us=(\d+)/.exec(line.trim());
            if (m && length > 0) report('encode', Math.min(1, Number(m[1]) / 1e6 / length));
          }
        },
      );
      await rename(tempFile, finalPath);
      tempFile = null;
      written.push(finalPath);
      report('done', 1, { peakDb: 20 * Math.log10(peak || 1e-9), gainDb: 20 * Math.log10(gain) });
    }
    return { ok: true, cancelled: false, written };
  } catch (err) {
    if (tempFile) await rm(tempFile, { force: true }).catch(() => {});
    if (err instanceof Cancelled) return { ok: false, cancelled: true, written };
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      cancelled: false,
      written,
      error: current ? `${outputFilename(current.filename)}: ${message}` : message,
    };
  }
}
