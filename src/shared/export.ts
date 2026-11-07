// Export without ffmpeg (the browser-only build): renders each segment twice, like the desktop
// exporter (src/main/exporter.ts). The first pass measures the peak of the finished audio, the
// second applies the normalizing gain and encodes it to MP3.
import { codedError } from './i18n/index.ts';
import { normalizeGain } from './plan.ts';
import { blockPeak, planSegment, renderPlan, type FrameReader } from './render.ts';
import type { ExportProgress, ExportRequest, ExportResult, Segment } from './types.ts';
import { outputFilename } from './validate.ts';

export interface Mp3Encoder {
  encode(planes: Float32Array[]): Uint8Array;
  finalize(): Uint8Array;
}

/** Where one MP3 goes. Nothing shows up under its name until close(); abort() leaves nothing. */
export interface OutputFile {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface ExportIo {
  read: FrameReader;
  /** Creates (or replaces) `filename` in `dir`, making the folder when needed. */
  create(dir: string, filename: string): Promise<OutputFile>;
  encoder(sampleRate: number, channels: number, bitrate: number): Promise<Mp3Encoder>;
  /** Called between blocks, so a long export lets other work run. */
  pause?(): Promise<void>;
}

export interface SourceFormat {
  sampleRate: number;
  channels: number;
}

class Cancelled extends Error {}

const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;

export async function exportSegments(
  req: ExportRequest,
  source: SourceFormat,
  io: ExportIo,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportResult> {
  const { settings } = req;
  const segments = [...req.segments].sort((a, b) => a.start - b.start);
  const written: string[] = [];
  let current: Segment | null = null;
  let output: OutputFile | null = null;
  const check = () => {
    if (signal.aborted) throw new Cancelled();
  };

  try {
    if (source.channels > 2) throw codedError('err.mp3Channels', { channels: source.channels });
    for (const [index, seg] of segments.entries()) {
      current = seg;
      const filename = outputFilename(seg.filename);
      const report = (phase: ExportProgress['phase'], fraction: number, extra: Partial<ExportProgress> = {}) =>
        onProgress({ index, total: segments.length, filename, phase, fraction, ...extra });
      const plan = planSegment(seg, req.cuts, settings, source.sampleRate, source.channels);
      if (!plan) throw codedError('err.noAudioLeft');
      const step = Math.max(1, plan.frames);

      // Pass 1: the finished audio's peak.
      report('measure', 0);
      let peak = 0;
      let done = 0;
      for await (const block of renderPlan(plan, io.read)) {
        check();
        peak = Math.max(peak, blockPeak(block));
        done += block[0].length;
        report('measure', Math.min(1, done / step));
        await io.pause?.();
      }

      // Pass 2: the same audio with the gain, encoded.
      const gain = normalizeGain(peak, seg.peakTarget, settings.ceilingDb);
      check();
      report('encode', 0);
      const encoder = await io.encoder(source.sampleRate, source.channels, seg.bitrate);
      output = await io.create(seg.outputDir, filename);
      done = 0;
      for await (const block of renderPlan(plan, io.read, gain)) {
        check();
        const bytes = encoder.encode(block);
        if (bytes.length) await output.write(bytes.slice());
        done += block[0].length;
        report('encode', Math.min(1, done / step));
        await io.pause?.();
      }
      const tail = encoder.finalize();
      if (tail.length) await output.write(tail.slice());
      check();
      await output.close();
      output = null;
      written.push(join(seg.outputDir, filename));
      report('done', 1, { peakDb: 20 * Math.log10(peak || 1e-9), gainDb: 20 * Math.log10(gain) });
    }
    return { ok: true, cancelled: false, written };
  } catch (err) {
    if (output) await output.abort().catch(() => {});
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
