// The desktop app's command line: start a recording, or stop the one that is running.

/** What the command line asks for. Paths are absolute (resolved against the caller's folder). */
export type CliCommand =
  | {
      kind: 'record';
      /** Folder for the new WAV. */
      dir: string;
      /** File name; unset means the name the Record dialog would suggest. */
      name?: string;
      /** Stops by itself after this many seconds; unset records until stopped. */
      durationSec?: number;
      /** Part of an input's name; unset means the input used last. */
      input?: string;
    }
  | { kind: 'stop' }
  | { kind: 'help' };

export type CliResult = { command: CliCommand | null } | { error: string };

export const CLI_USAGE = `Usage:
  one-take --record [--dir <folder>] [--name <file>] [--duration <time>] [--input <name>]
  one-take --stop
  one-take [file.wav]

  --record          Start recording in One Take (the running one, or a new one).
  --dir <folder>    Where the WAV goes (default: the current folder). Made if missing.
  --name <file>     File name (default: today's MMDD_ and the last recording's name).
                    ".wav" is added if missing; an existing file is never overwritten,
                    a number is added instead: "name (2).wav".
  --duration <time> Stop by itself after this long: 90 (seconds), 90s, 45m, 2h, 1h30m,
                    1:30 (minutes:seconds) or 1:30:00. Without it, record until stopped.
  --input <name>    Audio input whose name contains this (default: the last one used).
  --stop            Stop the recording that is running.
  --help            Show this text.`;

const VALUE_OPTIONS = ['dir', 'name', 'duration', 'input'] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

/**
 * Reads the command line (without the program itself). Arguments One Take does not know, such
 * as Chromium's own switches or a WAV to open, are left alone; null means none of ours is there.
 */
export function parseCli(args: readonly string[], cwd: string, resolvePath: (cwd: string, p: string) => string): CliResult {
  let action: 'record' | 'stop' | 'help' | null = null;
  const values: Partial<Record<ValueOption, string>> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
    if (!m) continue;
    const [, key, inline] = m;
    if (key === 'record' || key === 'stop' || key === 'help') {
      if (action && action !== key) return { error: `--${action} and --${key} cannot be used together` };
      action = key;
    } else if ((VALUE_OPTIONS as readonly string[]).includes(key)) {
      const value = inline ?? args[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) return { error: `--${key} needs a value` };
      values[key as ValueOption] = value;
    }
  }
  const given = Object.keys(values);
  if (action !== 'record' && given.length) {
    if (action === null) return { error: `--${given[0]} only works with --record` };
    if (action === 'stop') return { error: `--stop takes no other options` };
  }
  if (action === null) return { command: null };
  if (action !== 'record') return { command: { kind: action } };

  const command: CliCommand = { kind: 'record', dir: resolvePath(cwd, values.dir ?? '.') };
  if (values.name !== undefined) {
    if (!values.name.trim()) return { error: '--name cannot be empty' };
    if (/[\\/]/.test(values.name)) return { error: '--name is a file name; give the folder with --dir' };
    command.name = withWav(values.name.trim());
  }
  if (values.duration !== undefined) {
    const sec = parseDuration(values.duration);
    if (sec === null) return { error: `--duration ${values.duration} is not a length such as 90, 45m, 1h30m or 1:30:00` };
    command.durationSec = sec;
  }
  if (values.input !== undefined) {
    if (!values.input.trim()) return { error: '--input cannot be empty' };
    command.input = values.input.trim();
  }
  return { command };
}

/** Seconds in "90", "90s", "45m", "2h", "1h30m", "1h 30m 10s", "1:30" (m:s) or "1:30:00"; null if invalid or zero. */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  let sec: number;
  if (/^\d+(\.\d+)?$/.test(s)) sec = Number(s);
  else if (/^\d+(:[0-5]?\d){1,2}(\.\d+)?$/.test(s)) {
    sec = s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  } else {
    const m = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec)?)?$/.exec(s);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

/** `name` with ".wav" added unless it already ends in it. */
export function withWav(name: string): string {
  return /\.wav$/i.test(name) ? name : `${name}.wav`;
}

/** `name`, or "name (2).wav", "name (3).wav", … whichever is not in `taken` (compared case-insensitively). */
export function freeName(name: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  const base = name.replace(/\.wav$/i, '');
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n}).wav`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
