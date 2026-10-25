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

/** A segment's full name (naming rule prefix plus the typed part), and why it cannot be built. */
export interface ResolvedName {
  name: string;
  issue?: Issue;
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

/**
 * Checks every segment; errors block export, warnings are informational. Filenames only
 * clash with segments written to the same folder (`folderOf`); `nameOf` gives the full name
 * when a naming rule adds to the typed part. While recording, `liveEnd` is how much of the
 * file is on disk: segments that reach past it cannot be exported yet.
 */
export function validateSegments(
  segments: readonly Segment[],
  cuts: readonly Cut[],
  settings: Settings,
  folderOf: (seg: Segment) => string | null = () => null,
  nameOf: (seg: Segment) => ResolvedName = (seg) => ({ name: seg.filename }),
  liveEnd: number | null = null,
): Map<string, SegmentIssues> {
  const result = new Map<string, SegmentIssues>();
  const byName = new Map<string, number[]>();
  const ordered = [...segments].sort((a, b) => a.start - b.start);

  ordered.forEach((seg, i) => {
    const issues: SegmentIssues = { errors: [], warnings: [] };
    result.set(seg.id, issues);

    const resolved = nameOf(seg);
    const problem: Issue | null = seg.filename.trim() === '' ? { key: 'issue.filenameRequired' } : filenameProblem(resolved.name);
    if (resolved.issue) issues.errors.push(resolved.issue);
    if (problem) issues.errors.push(problem);
    else {
      const key = `${folderOf(seg) ?? ''}\0${outputFilename(resolved.name)}`.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), i]);
    }

    if (liveEnd !== null && seg.end > liveEnd + 1e-6) issues.errors.push({ key: 'issue.stillRecording' });

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

/** True when the only thing keeping a segment from export is that it is still being recorded. */
export function onlyStillRecording(issues: SegmentIssues | undefined): boolean {
  return !!issues?.errors.length && issues.errors.every((e) => e.key === 'issue.stillRecording');
}
