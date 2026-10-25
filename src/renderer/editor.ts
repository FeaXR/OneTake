import { expandTemplate, folderDefault, formatDate, recordingDate, ruleFor, usesToken, type FolderRule } from '../shared/naming.ts';
import type { AudioInfo, Bitrate, Cut, PeakTarget, Project, Segment, Settings } from '../shared/types.ts';
import { DEFAULT_SETTINGS, segmentFolder } from '../shared/types.ts';
import { validateSegments, type ResolvedName, type SegmentIssues } from '../shared/validate.ts';
import { joinedDuration, keptPieces } from '../shared/plan.ts';
import { fadeGain } from './draw.ts';
import { PeakPyramid } from './peaks.ts';

export type Tool = 'select' | 'segment' | 'cut';
export type RegionKind = 'segment' | 'cut';
export interface Selection {
  kind: RegionKind;
  id: string;
}

/** What changed, so views can skip work they do not need. 'length': a recording grew. */
export type Change = 'project' | 'selection' | 'view' | 'playhead' | 'ui' | 'audio' | 'settings' | 'length';

export const MIN_REGION_SEC = 0.05;
/** Deepest zoom: frames per CSS pixel. */
const MIN_FRAMES_PER_PX = 8;
/** While recording, the view can always zoom out this far, so the live point has room to move into. */
const LIVE_VIEW_SEC = 60;
/** When following the live point, it is kept this far from the right edge (share of the view). */
const LIVE_FOLLOW_MARGIN = 0.1;

export const emptyProject = (): Project => ({ version: 1, segments: [], cuts: [], outputDirs: [], numberStarts: {} });

const SEGMENT_COLORS = ['#4f9cf7', '#4cc38a', '#c77dff', '#f2a541', '#2ec4c4', '#f06292'];

/** Central editor state. Views subscribe and redraw; commands mutate through the methods here. */
export class Editor {
  wavPath: string | null = null;
  info: AudioInfo | null = null;
  peaks: PeakPyramid | null = null;
  project: Project = emptyProject();
  settings: Settings = { ...DEFAULT_SETTINGS };

  selection: Selection | null = null;
  tool: Tool = 'segment';
  playhead = 0;
  playing = false;
  /** Pending start of a segment being marked with the keyboard (I, then O). */
  markIn: number | null = null;
  /** Pending start of a cut being marked with the keyboard (X, then X). */
  cutMark: number | null = null;
  skipCuts = true;
  dirty = false;
  /** The file is being recorded: it grows, and its end (duration) is the live point. */
  recording = false;
  /** Scroll along with the live point while it is on screen. */
  followLive = true;

  /** Visible window of the timeline. */
  view = { start: 0, secPerPx: 0.01, widthPx: 1000 };

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private gestureStart: string | null = null;
  private listeners = new Set<(changes: Set<Change>) => void>();
  private pending = new Set<Change>();
  private frame = 0;

  subscribe(fn: (changes: Set<Change>) => void): void {
    this.listeners.add(fn);
  }

  /** Batches notifications to one per animation frame. */
  notify(...changes: Change[]): void {
    for (const c of changes) this.pending.add(c);
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const batch = this.pending;
      this.pending = new Set();
      // One failing view must not keep the others from updating.
      for (const fn of this.listeners) {
        try {
          fn(batch);
        } catch (err) {
          reportError(err);
        }
      }
    });
  }

  // ---------- Loading ----------

  loadAudio(path: string, info: AudioInfo, peaks: PeakPyramid, project: Project | null): void {
    this.wavPath = path;
    this.info = info;
    this.peaks = peaks;
    this.project = project ? sanitizeProject(project, info.duration, this.settings) : emptyProject();
    this.selection = null;
    this.playhead = 0;
    this.markIn = null;
    this.cutMark = null;
    this.undoStack = [];
    this.redoStack = [];
    this.setDirty(false);
    this.zoomToFit();
    this.notify('audio', 'project', 'selection', 'view', 'playhead', 'ui');
  }

  /** Starts editing a recording that has just begun: an empty, growing file. */
  startLive(info: AudioInfo, peaks: PeakPyramid): void {
    this.recording = true;
    this.loadAudio(info.path, info, peaks, null);
  }

  /** The recording reached `frames` on disk. */
  growTo(frames: number): void {
    const info = this.info;
    if (!this.recording || !info || frames <= info.frames) return;
    const wasVisible = this.duration >= this.view.start && this.duration <= this.viewEnd;
    info.frames = frames;
    info.duration = frames / info.sampleRate;
    // Keep the live point on screen if it was: it moves into the empty space on the right.
    const span = this.view.widthPx * this.view.secPerPx;
    if (this.followLive && wasVisible && this.duration > this.view.start + span * (1 - LIVE_FOLLOW_MARGIN)) {
      this.view.start = this.duration - span * (1 - LIVE_FOLLOW_MARGIN);
      this.clampView();
      this.notify('view');
    }
    this.notify('length');
  }

  /** The recording stopped; `info` describes the finished file. */
  endLive(info: AudioInfo): void {
    if (!this.recording) return;
    this.recording = false;
    if (this.info) Object.assign(this.info, { frames: info.frames, duration: info.duration });
    this.clampView();
    this.notify('length', 'view', 'ui');
  }

  get duration(): number {
    return this.info?.duration ?? 0;
  }

  setDirty(dirty: boolean): void {
    if (this.dirty === dirty) return;
    this.dirty = dirty;
    window.studio.setDirty(dirty);
    this.notify('ui');
  }

  // ---------- Project edits with undo ----------

  /** Applies an edit as one undo step. */
  commit(mutate: (p: Project) => void): void {
    const before = JSON.stringify(this.project);
    mutate(this.project);
    this.afterEdit(before);
  }

  /** Starts a drag: edits until endGesture() become a single undo step. */
  beginGesture(): void {
    this.gestureStart = JSON.stringify(this.project);
  }

  /** Edit during a gesture (no undo entry yet). */
  live(mutate: (p: Project) => void): void {
    mutate(this.project);
    this.notify('project');
  }

  endGesture(): void {
    if (this.gestureStart === null) return;
    const before = this.gestureStart;
    this.gestureStart = null;
    this.afterEdit(before);
  }

  private afterEdit(before: string): void {
    if (JSON.stringify(this.project) === before) return;
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.setDirty(true);
    this.dropStaleSelection();
    this.notify('project', 'selection');
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev);
    this.setDirty(true);
    this.dropStaleSelection();
    this.notify('project', 'selection');
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(next);
    this.setDirty(true);
    this.dropStaleSelection();
    this.notify('project', 'selection');
  }

  private dropStaleSelection(): void {
    if (this.selection && !this.region(this.selection)) this.selection = null;
  }

  // ---------- Queries ----------

  /**
   * A file's volume target and bitrate: its own choice, else its folder's default, else the
   * Settings default. `*Default` is what it would be without its own choice.
   */
  outputOptions(seg: Segment): { peakTarget: PeakTarget; bitrate: Bitrate; peakDefault: PeakTarget; bitrateDefault: Bitrate } {
    const folder = segmentFolder(this.project, seg);
    const rules = this.settings.folderRules;
    const peakDefault = folderDefault(rules, folder, 'peakTarget') ?? this.settings.defaultPeakTarget;
    const bitrateDefault = folderDefault(rules, folder, 'bitrate') ?? this.settings.defaultBitrate;
    return { peakTarget: seg.peakTarget ?? peakDefault, bitrate: seg.bitrate ?? bitrateDefault, peakDefault, bitrateDefault };
  }

  /** The naming rule a segment follows, or null when its name is typed in full. */
  namingRule(seg: Segment): FolderRule | null {
    return seg.autoName === false ? null : ruleFor(this.settings.folderRules, segmentFolder(this.project, seg));
  }

  /**
   * Segments numbered together with `seg`: same folder, in time order. Files with a typed full
   * name keep their place, so switching one does not renumber the others.
   */
  namingSiblings(seg: Segment): Segment[] {
    const folder = segmentFolder(this.project, seg);
    return this.sortedSegments().filter((s) => segmentFolder(this.project, s) === folder);
  }

  /** The rule's generated start of the name (empty without a rule), and the full name. */
  fileName(seg: Segment): ResolvedName & { prefix: string; rule: FolderRule | null } {
    const rule = this.namingRule(seg);
    if (!rule) return { name: seg.filename, prefix: '', rule: null };
    const folder = segmentFolder(this.project, seg)!;
    const order = this.namingSiblings(seg).findIndex((s) => s.id === seg.id) + 1;
    const date = this.info ? recordingDate(this.info.path, this.info.modified ?? Date.now()) : null;
    const type = seg.type && rule.types.includes(seg.type) ? seg.type : rule.types[0] ?? '';
    const prefix = expandTemplate(rule.template, {
      number: (this.project.numberStarts[folder] ?? 1) + order - 1,
      order,
      date: date ? formatDate(date) : null,
      type,
    });
    const issue = usesToken(rule.template, 'date') && !date ? { key: 'issue.noDate' as const } : undefined;
    return { name: prefix + seg.filename, prefix, rule, issue };
  }

  /** The segment whose fades playback previews: the selected one. */
  get previewSegment(): Segment | undefined {
    const sel = this.selection;
    return sel?.kind === 'segment' ? this.project.segments.find((s) => s.id === sel.id) : undefined;
  }

  /**
   * Gain the export's fades apply at source time `t`, for the preview segment (1 outside it).
   * Fades run on the joined audio, so time inside cuts is not counted.
   */
  previewGain(t: number): number {
    return this.previewGainCurve()?.(t) ?? 1;
  }

  /** previewGain() with the segment's pieces worked out once; null when nothing is previewed. */
  previewGainCurve(): ((t: number) => number) | null {
    const seg = this.previewSegment;
    if (!seg) return null;
    const { fadeInSec, fadeOutSec, fadeInCurve, fadeOutCurve, cutCrossfadeMs } = this.settings;
    const xf = cutCrossfadeMs / 1000;
    const pieces = keptPieces(seg, this.project.cuts, xf);
    const total = joinedDuration(pieces, xf);
    return (t) => {
      if (t < seg.start || t > seg.end) return 1;
      let pos = 0;
      for (const [i, p] of pieces.entries()) {
        if (t <= p.start) break;
        pos += Math.min(t, p.end) - p.start - (i > 0 ? xf : 0);
      }
      pos = clamp(pos, 0, total);
      let gain = 1;
      if (fadeInSec > 0 && pos < fadeInSec) gain *= fadeGain(fadeInCurve, pos / fadeInSec);
      if (fadeOutSec > 0 && total - pos < fadeOutSec) gain *= fadeGain(fadeOutCurve, (total - pos) / fadeOutSec);
      return gain;
    };
  }

  /** Problems of every segment (see validateSegments); while recording, ones past the live point. */
  validate(segments: readonly Segment[] = this.sortedSegments()): Map<string, SegmentIssues> {
    return validateSegments(segments, this.project.cuts, this.settings, (s) => segmentFolder(this.project, s),
      (s) => this.fileName(s), this.recording ? this.duration : null);
  }

  sortedSegments(): Segment[] {
    return [...this.project.segments].sort((a, b) => a.start - b.start || a.end - b.end);
  }

  sortedCuts(): Cut[] {
    return [...this.project.cuts].sort((a, b) => a.start - b.start);
  }

  region(sel: Selection): Segment | Cut | undefined {
    const list: (Segment | Cut)[] = sel.kind === 'segment' ? this.project.segments : this.project.cuts;
    return list.find((r) => r.id === sel.id);
  }

  selectedRegion(): Segment | Cut | undefined {
    return this.selection ? this.region(this.selection) : undefined;
  }

  selectedSegment(): Segment | undefined {
    return this.selection?.kind === 'segment' ? (this.region(this.selection) as Segment | undefined) : undefined;
  }

  segmentNumber(id: string): number {
    return this.sortedSegments().findIndex((s) => s.id === id) + 1;
  }

  segmentColor(id: string): string {
    const n = this.segmentNumber(id);
    return SEGMENT_COLORS[(Math.max(1, n) - 1) % SEGMENT_COLORS.length];
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.notify('selection');
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.notify('ui');
  }

  setPlayhead(t: number): void {
    this.playhead = clamp(t, 0, this.duration);
    this.notify('playhead');
  }

  // ---------- Creating regions ----------

  newSegment(start: number, end: number): Segment {
    return {
      id: crypto.randomUUID(),
      filename: '',
      start: clamp(Math.min(start, end), 0, this.duration),
      end: clamp(Math.max(start, end), 0, this.duration),
    };
  }

  newCut(start: number, end: number): Cut {
    return {
      id: crypto.randomUUID(),
      start: clamp(Math.min(start, end), 0, this.duration),
      end: clamp(Math.max(start, end), 0, this.duration),
    };
  }

  // ---------- View ----------

  get minSecPerPx(): number {
    return this.info ? MIN_FRAMES_PER_PX / this.info.sampleRate : 0.0001;
  }

  get maxSecPerPx(): number {
    const span = this.recording ? Math.max(this.duration, LIVE_VIEW_SEC) : this.duration || 1;
    return Math.max(this.minSecPerPx, span / Math.max(1, this.view.widthPx));
  }

  get viewEnd(): number {
    return this.view.start + this.view.widthPx * this.view.secPerPx;
  }

  timeToX(t: number): number {
    return (t - this.view.start) / this.view.secPerPx;
  }

  xToTime(x: number): number {
    return this.view.start + x * this.view.secPerPx;
  }

  setViewWidth(widthPx: number): void {
    if (widthPx === this.view.widthPx) return;
    this.view.widthPx = Math.max(1, widthPx);
    this.clampView();
    this.notify('view');
  }

  private clampView(): void {
    this.view.secPerPx = clamp(this.view.secPerPx, this.minSecPerPx, this.maxSecPerPx);
    const span = this.view.widthPx * this.view.secPerPx;
    // While recording, the view may run a little past the live point, so there is room to follow it.
    const end = this.recording ? this.duration + span * LIVE_FOLLOW_MARGIN : this.duration;
    this.view.start = clamp(this.view.start, 0, Math.max(0, end - span));
  }

  scrollTo(start: number): void {
    this.view.start = start;
    this.clampView();
    this.notify('view');
  }

  scrollBy(px: number): void {
    this.scrollTo(this.view.start + px * this.view.secPerPx);
  }

  /** Zooms by `factor` (>1 zooms in) keeping the time under `anchorX` in place. */
  zoomAt(factor: number, anchorX = this.view.widthPx / 2): void {
    const anchorT = this.xToTime(anchorX);
    this.view.secPerPx /= factor;
    this.clampView();
    this.view.start = anchorT - anchorX * this.view.secPerPx;
    this.clampView();
    this.notify('view');
  }

  zoomToFit(): void {
    this.view.secPerPx = this.maxSecPerPx;
    this.view.start = 0;
    this.clampView();
    this.notify('view');
  }

  /** Shows [start, end] with a little margin on both sides. */
  zoomToRange(start: number, end: number): void {
    const span = Math.max(end - start, MIN_REGION_SEC);
    const margin = span * 0.08;
    this.view.secPerPx = (span + 2 * margin) / this.view.widthPx;
    this.clampView();
    this.view.start = start - margin;
    this.clampView();
    this.notify('view');
  }

  /** Scrolls just enough (a page at a time) to keep `t` on screen. */
  ensureVisible(t: number): void {
    const span = this.view.widthPx * this.view.secPerPx;
    if (t < this.view.start || t > this.view.start + span) {
      this.scrollTo(t - span * 0.05);
    }
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Clamps saved regions to the current file and drops ones that no longer fit. */
function sanitizeProject(p: Project & { outputDir?: string | null }, duration: number, settings: Settings): Project {
  // Sessions from before folder defaults stored every file's volume and bitrate. Values equal
  // to the Settings defaults were never really chosen, so they follow the folder from now on.
  const legacy = !('numberStarts' in p);
  const options = (s: Segment): Segment => {
    if (!legacy) return s;
    const { peakTarget, bitrate, ...rest } = s;
    return {
      ...rest,
      ...(peakTarget !== settings.defaultPeakTarget && { peakTarget }),
      ...(bitrate !== settings.defaultBitrate && { bitrate }),
    };
  };
  // Sessions saved before multiple folders had a single `outputDir`.
  const outputDirs = Array.isArray(p.outputDirs) ? [...new Set(p.outputDirs.filter(Boolean))] : p.outputDir ? [p.outputDir] : [];
  const fix = <T extends { start: number; end: number }>(r: T): T => ({
    ...r,
    start: clamp(r.start, 0, duration),
    end: clamp(r.end, 0, duration),
  });
  return {
    version: 1,
    outputDirs,
    numberStarts: Object.fromEntries(
      Object.entries(p.numberStarts ?? {}).filter(([, v]) => Number.isInteger(v) && v >= 0),
    ),
    segments: (p.segments ?? []).map(fix).filter((s) => s.end - s.start >= MIN_REGION_SEC).map((s) => {
      // Only extra folders are stored per segment; anything else falls back to the default.
      const { outputDir, ...rest } = s;
      return options(outputDir && outputDirs.indexOf(outputDir) > 0 ? { ...rest, outputDir } : rest);
    }),
    cuts: (p.cuts ?? []).map(fix).filter((c) => c.end > c.start),
  };
}
