import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

/** Folder inside Documents that holds the app's files. */
export const APP_FOLDER = 'Studio Audio Editor';

/**
 * Session file for a WAV inside `sessionsDir`: the WAV's name plus a hash of its full path, so
 * same-named recordings in different folders do not share a session. Paths are compared
 * case-insensitively on Windows, as the file system does.
 */
export function sessionFileFor(sessionsDir: string, wavPath: string, platform: NodeJS.Platform = process.platform): string {
  const full = resolve(wavPath);
  const key = platform === 'win32' ? full.toLowerCase() : full;
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 10);
  const name = basename(full).replace(/\.wav$/i, '');
  return join(sessionsDir, `${name}-${hash}.json`);
}

/** Where sessions used to be saved: next to the WAV. Still read when no central one exists. */
export const legacySessionFileFor = (wavPath: string) => `${wavPath}.sae.json`;
