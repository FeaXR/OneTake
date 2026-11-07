import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { completeSettings, isProject } from '../shared/settings.ts';
import type { Project, Settings } from '../shared/types.ts';
import { legacySessionFileFor, sessionFileFor } from './session-path.ts';

/** Where settings, the peaks cache and sessions are kept; set once at startup. */
export interface StorePaths {
  userData: string;
  sessions: string;
}

let paths: StorePaths | null = null;

/** Called before anything is read: the desktop app passes its system folders, the server its config folder. */
export function configureStore(p: StorePaths): void {
  paths = p;
}

function storePaths(): StorePaths {
  if (!paths) throw new Error('configureStore() was not called');
  return paths;
}

const userFile = (name: string) => join(storePaths().userData, name);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function loadSettings(): Promise<Settings> {
  return completeSettings(await readJson<Partial<Settings>>(userFile('settings.json')));
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeJson(userFile('settings.json'), settings);
}

export const shortcutsFile = () => userFile('shortcuts.json');

/** User overrides for keyboard shortcuts: command id -> list of key combos. */
export async function loadShortcutOverrides(): Promise<Record<string, string[]>> {
  return (await readJson<Record<string, string[]>>(shortcutsFile())) ?? {};
}

/** Saves the shortcuts that differ from the defaults (written by the shortcut editor in Settings). */
export async function saveShortcutOverrides(overrides: Record<string, string[]>): Promise<void> {
  await writeJson(shortcutsFile(), overrides);
}

/** Sessions live in one place (Documents/One Take/Sessions in the desktop app). */
export const sessionsDir = () => storePaths().sessions;

/** The WAV's session, or one saved next to it by older versions; null when there is none. */
export async function loadProject(wavPath: string): Promise<Project | null> {
  const central = await readJson<Project>(sessionFileFor(sessionsDir(), wavPath));
  if (isProject(central)) return central;
  const legacy = await readJson<Project>(legacySessionFileFor(wavPath));
  return isProject(legacy) ? legacy : null;
}

export async function saveProject(wavPath: string, project: Project): Promise<void> {
  // The WAV's path is kept in the file too, so the Sessions folder can be read by a person.
  await writeJson(sessionFileFor(sessionsDir(), wavPath), { wavPath, ...project });
}

export const peaksCacheDir = () => join(storePaths().userData, 'peaks');
