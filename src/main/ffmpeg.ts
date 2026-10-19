import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// The bundled main process is CommonJS and has `require`; tests run this file as ESM from the repo root.
const load = typeof require === 'function' ? require : createRequire(join(process.cwd(), 'package.json'));

let cached: string | null = null;

/** Bundled ffmpeg (unpacked from the asar archive in a packaged app), falling back to PATH. */
export function ffmpegPath(): string {
  if (cached) return cached;
  let candidate: string | null = null;
  try {
    candidate = (load('ffmpeg-static') as string | null)?.replace('app.asar', 'app.asar.unpacked') ?? null;
  } catch {
    candidate = null;
  }
  cached = candidate && existsSync(candidate) ? candidate : 'ffmpeg';
  return cached;
}
