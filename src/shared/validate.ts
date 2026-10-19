import { outputDurationOf } from './plan.ts';
import type { Cut, Segment, Settings } from './types.ts';

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Final file name on disk: the typed name with `.mp3` added unless already present. */
export function outputFilename(name: string): string {
  const trimmed = name.trim();
  return /\.mp3$/i.test(trimmed) ? trimmed : `${trimmed}.mp3`;
}

/** Returns a problem description, or null when the name is usable on Windows. */
export function filenameProblem(name: string): string | null {
  if (name.trim() === '') return 'Filename is required';
  if (INVALID_CHARS.test(name)) return 'Filename contains a character Windows does not allow (< > : " / \\ | ? *)';
  if (/[ .]$/.test(name)) return 'Filename cannot end with a space or a dot';
  const base = outputFilename(name).replace(/\.mp3$/i, '').split('.')[0];
  if (RESERVED.test(base)) return `"${base}" is a reserved name on Windows`;
  return null;
}

export interface SegmentIssues {
  errors: string[];
  warnings: string[];
}

/** Checks every segment; errors block export, warnings are informational. */
export function validateSegments(
  segments: readonly Segment[],
  cuts: readonly Cut[],
  settings: Settings,
): Map<string, SegmentIssues> {
  const result = new Map<string, SegmentIssues>();
  const byName = new Map<string, number[]>();
  const ordered = [...segments].sort((a, b) => a.start - b.start);

  ordered.forEach((seg, i) => {
    const issues: SegmentIssues = { errors: [], warnings: [] };
    result.set(seg.id, issues);

    const problem = filenameProblem(seg.filename);
    if (problem) issues.errors.push(problem);
    else {
      const key = outputFilename(seg.filename).toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), i]);
    }

    if (seg.end <= seg.start) {
      issues.errors.push('End is not after start');
    } else {
      const length = outputDurationOf(seg, cuts, settings);
      if (length <= 0) issues.errors.push('Nothing is left after the cuts');
      else if (length < settings.fadeInSec + settings.fadeOutSec)
        issues.errors.push('Shorter than the fade-in and fade-out together');
    }

    const next = ordered[i + 1];
    if (next && next.start < seg.end - 5) {
      issues.warnings.push(`Overlaps #${i + 2} by more than 5 seconds`);
    }
  });

  for (const indexes of byName.values()) {
    if (indexes.length < 2) continue;
    for (const i of indexes) {
      const others = indexes.filter((j) => j !== i).map((j) => `#${j + 1}`);
      result.get(ordered[i].id)!.errors.push(`Same filename as ${others.join(', ')}`);
    }
  }
  return result;
}
