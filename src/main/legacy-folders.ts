import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** The app's name before it became One Take; its settings and sessions folders are moved over. */
export const LEGACY_FOLDER = 'Studio Audio Editor';

/**
 * Moves what is in `from` into `to`, entry by entry, skipping names `to` already has (Electron
 * creates its own files in the settings folder before the app runs, so `to` may exist already).
 * Returns the names moved. An entry that cannot be renamed (another drive, a file in use) is
 * copied instead; the old folder is removed once it is empty.
 */
export function moveLegacyFolder(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  const moved: string[] = [];
  try {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const source = join(from, name);
      const target = join(to, name);
      if (existsSync(target)) continue;
      try {
        renameSync(source, target);
      } catch {
        try {
          cpSync(source, target, { recursive: true });
          rmSync(source, { recursive: true, force: true });
        } catch {
          continue;
        }
      }
      moved.push(name);
    }
    if (readdirSync(from).length === 0) rmdirSync(from);
  } catch {
    // Unreadable old folder: start with fresh settings rather than not start at all.
  }
  return moved;
}
