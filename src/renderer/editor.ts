import type { AudioInfo, Cut, Project, Segment, Settings } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { PeakPyramid } from './peaks.ts';

export type Tool = 'select' | 'segment' | 'cut';
export type RegionKind = 'segment' | 'cut';
export interface Selection {
  kind: RegionKind;
  id: string;
}

/** What changed, so views can skip work they do not need. */
export type Change = 'project' | 'selection' | 'view' | 'playhead' | 'ui' | 'audio' | 'settings';

export const MIN_REGION_SEC = 0.05;
/** Deepest zoom: frames per CSS pixel. */
const MIN_FRAMES_PER_PX = 8;

export const emptyProject = (): Project => ({ version: 1, segments: [], cuts: [], outputDirs: [] });

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
    this.project = project ? sanitizeProject(project, info.duration) : emptyProject();
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
      peakTarget: this.settings.defaultPeakTarget,
      bitrate: this.settings.defaultBitrate,
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
    return Math.max(this.minSecPerPx, (this.duration || 1) / Math.max(1, this.view.widthPx));
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
    this.view.start = clamp(this.view.start, 0, Math.max(0, this.duration - span));
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
function sanitizeProject(p: Project & { outputDir?: string | null }, duration: number): Project {
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
    segments: (p.segments ?? []).map(fix).filter((s) => s.end - s.start >= MIN_REGION_SEC).map((s) => {
      // Only extra folders are stored per segment; anything else falls back to the default.
      const { outputDir, ...rest } = s;
      return outputDir && outputDirs.indexOf(outputDir) > 0 ? { ...rest, outputDir } : rest;
    }),
    cuts: (p.cuts ?? []).map(fix).filter((c) => c.end > c.start),
  };
}
