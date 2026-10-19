import { app } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { DEFAULT_SETTINGS, type Project, type Settings } from '../shared/types.ts';

const userFile = (name: string) => join(app.getPath('userData'), name);

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
  return { ...DEFAULT_SETTINGS, ...(await readJson<Partial<Settings>>(userFile('settings.json'))) };
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

export const projectFileFor = (wavPath: string) => `${wavPath}.sae.json`;

export async function loadProject(wavPath: string): Promise<Project | null> {
  const project = await readJson<Project>(projectFileFor(wavPath));
  return project && project.version === 1 && Array.isArray(project.segments) ? project : null;
}

export async function saveProject(wavPath: string, project: Project): Promise<void> {
  await writeJson(projectFileFor(wavPath), project);
}

export const peaksCacheDir = () => join(app.getPath('userData'), 'peaks');
