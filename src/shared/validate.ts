import type { MessageKey, Params } from './i18n/index.ts';
import { outputDurationOf } from './plan.ts';
import type { Cut, Segment, Settings } from './types.ts';

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A problem with a segment, as a translation key plus its parameters. */
export interface Issue {
  key: MessageKey;
  params?: Params;
}

/** Final file name on disk: the typed name with `.mp3` added unless already present. */
export function outputFilename(name: string): string {
  const trimmed = name.trim();
  return /\.mp3$/i.test(trimmed) ? trimmed : `${trimmed}.mp3`;
}

/** Returns the problem with a filename, or null when the name is usable on Windows. */
export function filenameProblem(name: string): Issue | null {
  if (name.trim() === '') return { key: 'issue.filenameRequired' };
  if (INVALID_CHARS.test(name)) return { key: 'issue.filenameChars' };
  if (/[ .]$/.test(name)) return { key: 'issue.filenameEnd' };
  const base = outputFilename(name).replace(/\.mp3$/i, '').split('.')[0];
  if (RESERVED.test(base)) return { key: 'issue.filenameReserved', params: { name: base } };
  return null;
}

export interface SegmentIssues {
  errors: Issue[];
  warnings: Issue[];
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
      issues.errors.push({ key: 'issue.endBeforeStart' });
    } else {
      const length = outputDurationOf(seg, cuts, settings);
      if (length <= 0) issues.errors.push({ key: 'issue.nothingLeft' });
      else if (length < settings.fadeInSec + settings.fadeOutSec) issues.errors.push({ key: 'issue.tooShort' });
    }

    const next = ordered[i + 1];
    if (next && next.start < seg.end - 5) {
      issues.warnings.push({ key: 'issue.overlap', params: { n: i + 2 } });
    }
  });

  for (const indexes of byName.values()) {
    if (indexes.length < 2) continue;
    for (const i of indexes) {
      const others = indexes.filter((j) => j !== i).map((j) => `#${j + 1}`);
      result.get(ordered[i].id)!.errors.push({ key: 'issue.duplicate', params: { others: others.join(', ') } });
    }
  }
  return result;
}
