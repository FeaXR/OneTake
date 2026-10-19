import { formatTime } from '../shared/time.ts';
import { FADE_CURVES, type ExportProgress, type FadeCurve, type Segment, type Settings } from '../shared/types.ts';
import { outputFilename, validateSegments } from '../shared/validate.ts';
import { CommandRegistry, Keymap, overridesFrom } from './commands.ts';
import { ShortcutEditor } from './shortcut-editor.ts';
import { choose, closeContextMenu, modalOpen, openModal, showContextMenu, showLoading, toast } from './dialogs.ts';
import { h } from './dom.ts';
import { clamp, Editor, MIN_REGION_SEC, type RegionKind, type Tool } from './editor.ts';
import { icons } from './icons.ts';
import { Overview } from './overview.ts';
import { OutputPanel } from './panel.ts';
import { PeakPyramid } from './peaks.ts';
import { Player } from './player.ts';
import { Timeline } from './timeline.ts';

const NUDGE_SEC = 0.01;
const STEP_SEC = 1;
const BIG_STEP_SEC = 10;

const basename = (p: string) => p.replace(/^.*[\\/]/, '');
const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

export class App {
  readonly editor = new Editor();
  readonly commands = new CommandRegistry();
  private keymap = new Keymap();
  private readonly player: Player;
  private readonly panel: OutputPanel;
  private readonly toolbarButtons: { el: HTMLButtonElement; command: string; active?: () => boolean }[] = [];
  private readonly clock = h('div', { id: 'clock' }, '0:00.000');
  private readonly status = {
    file: h('span'),
    selection: h('span'),
    zoom: h('span'),
    hint: h('span', { class: 'hint' }),
  };
  private exporting = false;

  constructor() {
    const ed = this.editor;
    this.player = new Player(document.getElementById('player') as HTMLAudioElement, ed);
    new Overview(document.getElementById('overview') as HTMLCanvasElement, ed);
    new Timeline(document.getElementById('timeline') as HTMLCanvasElement, ed, this.player, {
      showContextMenu,
      focusSegmentName: (id) => this.panel.focusName(id),
      shortcut: (id) => this.keymap.label(id),
      run: (id) => this.commands.run(id),
    });
    this.panel = new OutputPanel(document.getElementById('panel')!, ed, {
      pickFolder: () => void this.pickFolder(),
      exportAll: () => this.commands.run('file.export'),
      playRegion: (kind, id) => this.playRegion(kind, id),
      zoomTo: (kind, id) => {
        const r = ed.region({ kind, id });
        if (r) ed.zoomToRange(r.start, r.end);
        ed.select({ kind, id });
      },
      deleteRegion: (kind, id) => this.deleteRegion(kind, id),
      shortcut: (id) => this.keymap.label(id),
    });

    this.registerCommands();
    this.buildToolbar();
    this.buildStatusbar();
    this.bindGlobalEvents();
    ed.subscribe(() => this.refreshChrome());
  }

  async init(): Promise<void> {
    this.editor.settings = await window.studio.getSettings();
    await this.reloadKeymap();
    this.editor.notify('settings', 'ui');
    window.studio.onOpenFile((path) => void this.openPath(path));
    const startupFile = await window.studio.takeStartupFile();
    if (startupFile) await this.openPath(startupFile, false);
  }

  private async reloadKeymap(): Promise<void> {
    try {
      this.keymap = new Keymap(await window.studio.getShortcutOverrides());
    } catch {
      this.keymap = new Keymap();
    }
    this.refreshChrome();
  }

  // ---------- Commands ----------

  private registerCommands(): void {
    const ed = this.editor;
    const hasAudio = () => !!ed.info;
    const hasSelection = () => !!ed.selectedRegion();
    const seekBy = (d: number) => this.moveTo(ed.playhead + d);
    const selection = () => ed.selectedRegion();

    this.commands.register(
      { id: 'file.open', label: 'Open WAV…', run: () => this.openWithDialog() },
      { id: 'file.save', label: 'Save project', run: () => void this.save(), enabled: hasAudio },
      { id: 'file.export', label: 'Export all', run: () => this.exportAll(), enabled: () => hasAudio() && !this.exporting },
      { id: 'edit.undo', label: 'Undo', run: () => ed.undo(), enabled: () => ed.canUndo },
      { id: 'edit.redo', label: 'Redo', run: () => ed.redo(), enabled: () => ed.canRedo },
      {
        id: 'edit.delete', label: 'Delete selected', enabled: hasSelection,
        run: () => {
          if (ed.selection) this.deleteRegion(ed.selection.kind, ed.selection.id);
        },
      },
      {
        id: 'edit.escape', label: 'Cancel marks / deselect',
        run: () => {
          if (ed.markIn !== null || ed.cutMark !== null) {
            ed.markIn = null;
            ed.cutMark = null;
            ed.notify('ui');
          } else ed.select(null);
        },
      },
      { id: 'edit.setStart', label: 'Set selected start to playhead', enabled: hasSelection, run: () => this.setEdge('start', ed.playhead) },
      { id: 'edit.setEnd', label: 'Set selected end to playhead', enabled: hasSelection, run: () => this.setEdge('end', ed.playhead) },
      { id: 'tool.select', label: 'Select tool', run: () => ed.setTool('select') },
      { id: 'tool.segment', label: 'Segment tool', run: () => ed.setTool('segment') },
      { id: 'tool.cut', label: 'Cut tool', run: () => ed.setTool('cut') },
      { id: 'play.toggle', label: 'Play / pause', run: () => this.player.toggle(), enabled: hasAudio },
      {
        id: 'play.selection', label: 'Play selection', enabled: hasAudio,
        run: () => (ed.selection ? this.playRegion(ed.selection.kind, ed.selection.id) : void this.player.play()),
      },
      {
        id: 'play.skipCuts', label: 'Skip cuts while playing',
        run: () => {
          ed.skipCuts = !ed.skipCuts;
          ed.notify('ui');
          toast(ed.skipCuts ? 'Playback skips cuts' : 'Playback plays through cuts');
        },
      },
      { id: 'playhead.start', label: 'Playhead to start of file', run: () => this.moveTo(0), enabled: hasAudio },
      { id: 'playhead.end', label: 'Playhead to end of file', run: () => this.moveTo(ed.duration), enabled: hasAudio },
      {
        id: 'playhead.selectionStart', label: 'Playhead to start of selection', enabled: hasSelection,
        run: () => this.moveTo(selection()!.start),
      },
      {
        id: 'playhead.selectionEnd', label: 'Playhead to end of selection', enabled: hasSelection,
        run: () => this.moveTo(selection()!.end),
      },
      {
        id: 'playhead.segmentStart', label: 'Playhead to start of the segment it is in', enabled: hasAudio,
        run: () => this.toSegmentEdge('start'),
      },
      {
        id: 'playhead.segmentEnd', label: 'Playhead to end of the segment it is in', enabled: hasAudio,
        run: () => this.toSegmentEdge('end'),
      },
      { id: 'playhead.prevEdge', label: 'Playhead to previous segment/cut edge', run: () => this.jumpToEdge(-1), enabled: hasAudio },
      { id: 'playhead.nextEdge', label: 'Playhead to next segment/cut edge', run: () => this.jumpToEdge(1), enabled: hasAudio },
      { id: 'playhead.show', label: 'Scroll to playhead', run: () => this.centerOn(ed.playhead), enabled: hasAudio },
      { id: 'view.pageBack', label: 'Scroll one screen left', run: () => ed.scrollBy(-ed.view.widthPx * 0.9), enabled: hasAudio },
      { id: 'view.pageForward', label: 'Scroll one screen right', run: () => ed.scrollBy(ed.view.widthPx * 0.9), enabled: hasAudio },
      { id: 'playhead.back', label: `Playhead back ${STEP_SEC} s`, run: () => seekBy(-STEP_SEC), enabled: hasAudio },
      { id: 'playhead.forward', label: `Playhead forward ${STEP_SEC} s`, run: () => seekBy(STEP_SEC), enabled: hasAudio },
      { id: 'playhead.backBig', label: `Playhead back ${BIG_STEP_SEC} s`, run: () => seekBy(-BIG_STEP_SEC), enabled: hasAudio },
      { id: 'playhead.forwardBig', label: `Playhead forward ${BIG_STEP_SEC} s`, run: () => seekBy(BIG_STEP_SEC), enabled: hasAudio },
      { id: 'mark.in', label: 'Mark segment start at playhead', run: () => this.markIn(), enabled: hasAudio },
      { id: 'mark.out', label: 'Mark segment end at playhead', run: () => this.markOut(), enabled: hasAudio },
      { id: 'mark.cut', label: 'Mark cut start / end at playhead', run: () => this.markCut(), enabled: hasAudio },
      { id: 'nudge.startBack', label: 'Nudge start earlier (10 ms)', run: () => this.nudge('start', -NUDGE_SEC), enabled: hasSelection },
      { id: 'nudge.startForward', label: 'Nudge start later (10 ms)', run: () => this.nudge('start', NUDGE_SEC), enabled: hasSelection },
      { id: 'nudge.endBack', label: 'Nudge end earlier (10 ms)', run: () => this.nudge('end', -NUDGE_SEC), enabled: hasSelection },
      { id: 'nudge.endForward', label: 'Nudge end later (10 ms)', run: () => this.nudge('end', NUDGE_SEC), enabled: hasSelection },
      { id: 'select.next', label: 'Select next segment', run: () => this.cycleSegment(1), enabled: hasAudio },
      { id: 'select.prev', label: 'Select previous segment', run: () => this.cycleSegment(-1), enabled: hasAudio },
      { id: 'zoom.in', label: 'Zoom in', run: () => this.zoom(1.6), enabled: hasAudio },
      { id: 'zoom.out', label: 'Zoom out', run: () => this.zoom(1 / 1.6), enabled: hasAudio },
      { id: 'zoom.fit', label: 'Zoom to whole file', run: () => ed.zoomToFit(), enabled: hasAudio },
      {
        id: 'zoom.selection', label: 'Zoom to selection', enabled: hasSelection,
        run: () => {
          const r = ed.selectedRegion();
          if (r) ed.zoomToRange(r.start, r.end);
        },
      },
      { id: 'app.settings', label: 'Settings', run: () => this.openSettings() },
      { id: 'app.devtools', label: 'Developer tools', run: () => window.studio.toggleDevTools() },
    );
  }

  /** Keyboard playhead moves: seek, and scroll so the playhead stays on screen. */
  private moveTo(t: number): void {
    this.player.seek(t);
    this.editor.ensureVisible(this.editor.playhead);
  }

  private centerOn(t: number): void {
    const ed = this.editor;
    ed.scrollTo(t - (ed.view.widthPx * ed.view.secPerPx) / 2);
  }

  /**
   * The segment containing the playhead. Where segments overlap, the selected one wins,
   * then the one that started most recently.
   */
  private segmentAtPlayhead(): Segment | undefined {
    const ed = this.editor;
    const t = ed.playhead;
    const under = ed.sortedSegments().filter((s) => t >= s.start && t <= s.end);
    return under.find((s) => s.id === ed.selection?.id) ?? under.at(-1);
  }

  private toSegmentEdge(edge: 'start' | 'end'): void {
    const seg = this.segmentAtPlayhead();
    if (!seg) return toast('The playhead is not inside a segment.', 'error');
    this.moveTo(seg[edge]);
  }

  /** Jumps to the nearest segment or cut boundary before/after the playhead (file start and end count too). */
  private jumpToEdge(dir: 1 | -1): void {
    const ed = this.editor;
    const edges = [0, ed.duration];
    for (const r of [...ed.project.segments, ...ed.project.cuts]) edges.push(r.start, r.end);
    edges.sort((a, b) => a - b);
    const eps = 0.0005;
    const target = dir === 1 ? edges.find((t) => t > ed.playhead + eps) : edges.findLast((t) => t < ed.playhead - eps);
    if (target !== undefined) this.moveTo(target);
  }

  private markIn(): void {
    const ed = this.editor;
    ed.markIn = ed.playhead;
    ed.notify('ui');
  }

  private markOut(): void {
    const ed = this.editor;
    if (ed.markIn !== null) {
      const start = Math.min(ed.markIn, ed.playhead);
      const end = Math.max(ed.markIn, ed.playhead);
      ed.markIn = null;
      if (end - start < MIN_REGION_SEC) {
        toast('The segment would be empty: move the playhead past the IN mark first.', 'error');
        ed.notify('ui');
        return;
      }
      const s = ed.newSegment(start, end);
      ed.commit((p) => p.segments.push(s));
      ed.select({ kind: 'segment', id: s.id });
      toast(`Segment #${ed.segmentNumber(s.id)} added. Name it in the list on the right.`);
    } else if (ed.selectedSegment()) {
      this.setEdge('end', ed.playhead);
    } else {
      toast('Press I at the start first (or select a segment to move its end).', 'error');
    }
  }

  private markCut(): void {
    const ed = this.editor;
    if (ed.cutMark === null) {
      ed.cutMark = ed.playhead;
      ed.notify('ui');
      return;
    }
    const start = Math.min(ed.cutMark, ed.playhead);
    const end = Math.max(ed.cutMark, ed.playhead);
    ed.cutMark = null;
    if (end - start < 0.005) {
      ed.notify('ui');
      return;
    }
    const c = ed.newCut(start, end);
    ed.commit((p) => p.cuts.push(c));
    ed.select({ kind: 'cut', id: c.id });
  }

  private setEdge(edge: 'start' | 'end', t: number): void {
    const ed = this.editor;
    const sel = ed.selection;
    if (!sel) return;
    ed.commit(() => {
      const r = ed.region(sel);
      if (!r) return;
      if (edge === 'start') r.start = clamp(t, 0, r.end - MIN_REGION_SEC);
      else r.end = clamp(t, r.start + MIN_REGION_SEC, ed.duration);
    });
  }

  private nudge(edge: 'start' | 'end', delta: number): void {
    const r = this.editor.selectedRegion();
    if (r) this.setEdge(edge, r[edge] + delta);
  }

  private cycleSegment(dir: 1 | -1): void {
    const ed = this.editor;
    const list = ed.sortedSegments();
    if (!list.length) return;
    const current = list.findIndex((s) => s.id === ed.selection?.id);
    const next = list[current === -1 ? (dir === 1 ? 0 : list.length - 1) : (current + dir + list.length) % list.length];
    ed.select({ kind: 'segment', id: next.id });
    if (next.end < ed.view.start || next.start > ed.viewEnd) ed.zoomToRange(next.start, next.end);
  }

  private zoom(factor: number): void {
    const ed = this.editor;
    const x = ed.timeToX(ed.playhead);
    ed.zoomAt(factor, x >= 0 && x <= ed.view.widthPx ? x : ed.view.widthPx / 2);
  }

  private playRegion(kind: RegionKind, id: string): void {
    const r = this.editor.region({ kind, id });
    if (!r) return;
    this.editor.select({ kind, id });
    // Around a cut: two seconds either side, so the join can be heard (the cut itself is skipped).
    if (kind === 'cut') {
      if (!this.editor.skipCuts) toast('Skip cuts is off: you will hear the cut audio too.');
      void this.player.play(Math.max(0, r.start - 2), Math.min(this.editor.duration, r.end + 2));
    } else void this.player.play(r.start, r.end);
  }

  private deleteRegion(kind: RegionKind, id: string): void {
    const ed = this.editor;
    ed.commit((p) => {
      if (kind === 'segment') p.segments = p.segments.filter((s) => s.id !== id);
      else p.cuts = p.cuts.filter((c) => c.id !== id);
    });
    if (ed.selection?.id === id) ed.select(null);
  }

  // ---------- Files ----------

  /** Returns false if the user cancelled. */
  private async confirmDiscard(): Promise<boolean> {
    if (!this.editor.dirty) return true;
    const answer = await choose('Unsaved changes', 'Save the changes to the current project first?', [
      { label: 'Cancel', value: 'cancel' },
      { label: "Don't save", value: 'discard' },
      { label: 'Save', value: 'save', primary: true },
    ], 'cancel');
    if (answer === 'cancel') return false;
    if (answer === 'save') return this.save();
    return true;
  }

  private async openWithDialog(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const path = await window.studio.pickWav();
    if (path) await this.openPath(path, false);
  }

  async openPath(path: string, confirm = true): Promise<void> {
    if (this.exporting) return toast('Wait for the export to finish first.', 'error');
    if (confirm && !(await this.confirmDiscard())) return;
    this.player.pause();
    const loading = showLoading(`Reading ${basename(path)}…`);
    const off = window.studio.onLoadProgress((f) => loading.update(f));
    try {
      const loaded = await window.studio.loadAudio(path);
      const peaks = new PeakPyramid(loaded.peaks);
      this.editor.loadAudio(loaded.info.path, loaded.info, peaks, loaded.project);
      if (!this.editor.project.outputDir) this.editor.project.outputDir = dirname(loaded.info.path);
      this.player.load(loaded.info.path);
      if (loaded.project) toast(`Loaded the saved project for ${basename(path)}`);
    } catch (err) {
      toast(`Could not open ${basename(path)}: ${errorText(err)}`, 'error');
    } finally {
      off();
      loading.close();
    }
  }

  async save(): Promise<boolean> {
    const ed = this.editor;
    if (!ed.wavPath) return false;
    try {
      await window.studio.saveProject(ed.wavPath, ed.project);
      ed.setDirty(false);
      toast('Project saved');
      return true;
    } catch (err) {
      toast(`Saving failed: ${errorText(err)}`, 'error');
      return false;
    }
  }

  private async pickFolder(): Promise<string | null> {
    const ed = this.editor;
    const dir = await window.studio.pickFolder(ed.project.outputDir ?? (ed.wavPath ? dirname(ed.wavPath) : null));
    if (dir && dir !== ed.project.outputDir) ed.commit((p) => (p.outputDir = dir));
    return dir;
  }

  // ---------- Export ----------

  private async exportAll(): Promise<void> {
    const ed = this.editor;
    if (!ed.wavPath || this.exporting) return;
    const segments = ed.sortedSegments();
    if (!segments.length) return toast('There is nothing to export yet. Mark at least one segment.', 'error');

    const issues = validateSegments(segments, ed.project.cuts, ed.settings);
    const firstBad = segments.find((s) => issues.get(s.id)!.errors.length);
    if (firstBad) {
      const count = segments.filter((s) => issues.get(s.id)!.errors.length).length;
      toast(`${count} output file${count > 1 ? 's need' : ' needs'} fixing first (see the red notes in the list).`, 'error');
      ed.select({ kind: 'segment', id: firstBad.id });
      this.panel.focusName(firstBad.id);
      return;
    }

    const outputDir = ed.project.outputDir ?? (await this.pickFolder());
    if (!outputDir) return;

    const names = segments.map((s) => outputFilename(s.filename));
    const existing = await window.studio.existingFiles(outputDir, names);
    if (existing.length) {
      const list = existing.length <= 6 ? existing.join(', ') : `${existing.slice(0, 6).join(', ')} and ${existing.length - 6} more`;
      const answer = await choose('Overwrite files?',
        `${existing.length} file${existing.length > 1 ? 's' : ''} already exist${existing.length > 1 ? '' : 's'} in the output folder and will be replaced: ${list}`,
        [{ label: 'Cancel', value: 'cancel' }, { label: 'Overwrite', value: 'ok', primary: true }], 'cancel');
      if (answer !== 'ok') return;
    }

    this.player.pause();
    this.exporting = true;
    this.refreshChrome();
    const items = segments.map((s, i) => {
      const fill = h('div');
      const bar = h('div', { class: 'bar' }, fill);
      const detail = h('div', { class: 'detail' }, `${s.bitrate} kbps · peak ${s.peakTarget === 1 ? '100%' : '60%'}`);
      const el = h('div', { class: 'export-item' }, h('div', { class: 'name' }, `#${i + 1}  ${names[i]}`), bar, detail);
      return { el, bar, fill, detail };
    });

    const modal = openModal(`Exporting ${segments.length} file${segments.length > 1 ? 's' : ''}`, { wide: true, dismissable: false });
    modal.body.append(h('div', { class: 'form-note' }, `To ${outputDir}`), ...items.map((i) => i.el));
    const cancelBtn = h('button', { onclick: () => void window.studio.cancelExport() }, 'Cancel');
    modal.foot.append(cancelBtn);

    const off = window.studio.onExportProgress((p: ExportProgress) => {
      const item = items[p.index];
      if (!item) return;
      const overall = p.phase === 'measure' ? p.fraction * 0.35 : p.phase === 'encode' ? 0.35 + p.fraction * 0.65 : 1;
      item.fill.style.width = `${Math.round(overall * 100)}%`;
      if (p.phase === 'measure') item.detail.textContent = 'Measuring peak…';
      if (p.phase === 'encode') item.detail.textContent = 'Encoding MP3…';
      if (p.phase === 'done') {
        item.bar.classList.add('done');
        item.detail.textContent = `Done. ${p.message ?? ''}`;
      }
    });

    try {
      const result = await window.studio.startExport({
        wavPath: ed.wavPath,
        outputDir,
        segments,
        cuts: ed.project.cuts,
        settings: ed.settings,
      });
      cancelBtn.remove();
      if (result.ok) {
        modal.body.prepend(h('div', { style: { color: 'var(--ok)', fontWeight: '600' } }, `All ${result.written.length} files exported.`));
        if (ed.dirty) await this.save();
      } else {
        const failedIndex = result.written.length;
        const item = items[failedIndex];
        if (item) {
          item.bar.classList.add('failed');
          item.detail.classList.add('err');
          item.detail.textContent = result.cancelled ? 'Cancelled' : (result.error ?? 'Failed');
        }
        modal.body.prepend(h('div', { style: { color: result.cancelled ? 'var(--warn)' : 'var(--danger)', fontWeight: '600' } },
          result.cancelled ? `Cancelled. ${result.written.length} file(s) were written.` : `Export stopped with an error. ${result.written.length} file(s) were written.`));
      }
      if (result.written.length) {
        modal.foot.append(h('button', { onclick: () => void window.studio.showInFolder(result.written[0]) }, 'Show in folder'));
      }
      const close = h('button', { class: 'primary', onclick: () => modal.close() }, 'Close');
      modal.foot.append(close);
      close.focus();
    } catch (err) {
      modal.close();
      toast(`Export failed: ${errorText(err)}`, 'error');
    } finally {
      off();
      this.exporting = false;
      this.refreshChrome();
    }
  }

  // ---------- Settings ----------

  private openSettings(): void {
    const ed = this.editor;
    const s: Settings = { ...ed.settings };
    const num = (value: number, min: number, max: number, step: number, set: (v: number) => void) =>
      h('input', {
        type: 'number', value: String(value), min: String(min), max: String(max), step: String(step),
        onchange: (e: Event) => {
          const input = e.target as HTMLInputElement;
          const v = Number(input.value);
          if (Number.isFinite(v)) set(clamp(v, min, max));
          input.value = String(clamp(Number.isFinite(v) ? v : value, min, max));
        },
      });
    const curveSelect = (value: FadeCurve, set: (v: FadeCurve) => void) => {
      const sel = h('select', { onchange: () => set(sel.value as FadeCurve) });
      for (const [k, label] of Object.entries(FADE_CURVES)) sel.append(h('option', { value: k, selected: k === value }, label));
      return sel;
    };
    const choice = <T extends string | number>(options: [T, string][], value: T, set: (v: T) => void) => {
      const group = h('div', { class: 'segmented' });
      for (const [v, label] of options) {
        const b = h('button', {
          class: v === value ? 'active' : '',
          onclick: () => {
            set(v);
            group.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
          },
        }, label);
        group.append(b);
      }
      return group;
    };

    const shortcuts = new ShortcutEditor(this.commands.all(), this.keymap.toRecord());
    const m = openModal('Settings', { wide: true, onClose: () => shortcuts.dispose() });
    m.body.append(
      h('div', { class: 'form-section' }, 'Fades (same for every file)'),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Fade-in'),
        h('div', { class: 'inline' }, num(s.fadeInSec, 0, 60, 0.1, (v) => (s.fadeInSec = v)), 'seconds', curveSelect(s.fadeInCurve, (v) => (s.fadeInCurve = v))),
        h('label', {}, 'Fade-out'),
        h('div', { class: 'inline' }, num(s.fadeOutSec, 0, 60, 0.1, (v) => (s.fadeOutSec = v)), 'seconds', curveSelect(s.fadeOutCurve, (v) => (s.fadeOutCurve = v))),
      ),
      h('div', { class: 'form-section' }, 'Export'),
      h('div', { class: 'form-grid' },
        h('label', {}, '"100%" peak level'),
        h('div', { class: 'inline' }, num(s.ceilingDb, -3, 0, 0.1, (v) => (s.ceilingDb = v)), 'dBFS',
          h('span', { class: 'form-note' }, '0 = full scale. −0.3 to −1 avoids slight MP3 clipping.')),
        h('label', {}, 'Crossfade at cuts'),
        h('div', { class: 'inline' }, num(s.cutCrossfadeMs, 1, 200, 1, (v) => (s.cutCrossfadeMs = v)), 'ms'),
        h('label', {}, 'New segments use'),
        h('div', { class: 'inline' },
          choice<number>([[1, '100%'], [0.6, '60%']], s.defaultPeakTarget, (v) => (s.defaultPeakTarget = v as Settings['defaultPeakTarget'])),
          choice<number>([[320, '320 kbps'], [192, '192 kbps']], s.defaultBitrate, (v) => (s.defaultBitrate = v as Settings['defaultBitrate'])),
        ),
      ),
      h('div', { class: 'form-section' }, 'Keyboard shortcuts'),
      shortcuts.el,
    );
    m.foot.append(
      h('button', { onclick: () => m.close() }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: async () => {
          ed.settings = s;
          await window.studio.saveSettings(s);
          await window.studio.saveShortcutOverrides(overridesFrom(shortcuts.result()));
          await this.reloadKeymap();
          ed.notify('settings', 'project');
          m.close();
        },
      }, 'Save'),
    );
  }

  // ---------- Chrome: toolbar, status bar, title ----------

  private buildToolbar(): void {
    const bar = document.getElementById('toolbar')!;
    const btn = (command: string, icon: string, text: string | null, title: string, active?: () => boolean) => {
      const el = h('button', { class: text ? '' : 'icon', html: icon, onclick: () => this.commands.run(command) });
      if (text) el.append(text);
      el.dataset.title = title;
      this.toolbarButtons.push({ el, command, active });
      return el;
    };
    const tool = (t: Tool, icon: string, text: string, title: string) =>
      btn(`tool.${t}`, icon, text, title, () => this.editor.tool === t);
    const group = (...els: HTMLElement[]) => h('div', { class: 'tb-group' }, ...els);
    const sep = () => h('div', { class: 'tb-sep' });

    const playBtn = btn('play.toggle', icons.play, null, 'Play / pause');
    this.toolbarButtons.at(-1)!.active = () => this.editor.playing;

    bar.append(
      group(btn('file.open', icons.open, 'Open', 'Open a WAV file'), btn('file.save', icons.save, 'Save', 'Save segments and cuts next to the WAV')),
      sep(),
      group(btn('edit.undo', icons.undo, null, 'Undo'), btn('edit.redo', icons.redo, null, 'Redo')),
      sep(),
      h('div', { class: 'segmented' },
        tool('select', icons.pointer, 'Select', 'Select tool: click to select and move the playhead, drag to scroll'),
        tool('segment', icons.segment, 'Segment', 'Segment tool: drag on the waveform to mark an output file'),
        tool('cut', icons.cut, 'Cut', 'Cut tool: drag on the waveform to mark audio to remove'),
      ),
      sep(),
      group(
        playBtn,
        btn('play.selection', icons.playSelection, null, 'Play the selected segment or the audio around the selected cut'),
        btn('play.skipCuts', icons.skip, 'Skip cuts', 'Skip cuts during playback, to hear the result', () => this.editor.skipCuts),
      ),
      sep(),
      group(
        btn('zoom.out', icons.zoomOut, null, 'Zoom out'),
        btn('zoom.in', icons.zoomIn, null, 'Zoom in'),
        btn('zoom.selection', icons.zoomSel, null, 'Zoom to selection'),
        btn('zoom.fit', icons.fit, null, 'Zoom to whole file'),
      ),
      h('div', { class: 'tb-spacer' }),
      this.clock,
      btn('app.settings', icons.settings, null, 'Settings: fades, peak level, shortcuts'),
    );
  }

  private buildStatusbar(): void {
    const s = this.status;
    document.getElementById('statusbar')!.append(s.file, s.selection, s.zoom, s.hint);
  }

  private refreshChrome(): void {
    const ed = this.editor;
    for (const b of this.toolbarButtons) {
      b.el.disabled = !this.commands.isEnabled(b.command);
      b.el.classList.toggle('active', b.active?.() ?? false);
      const key = this.keymap.label(b.command);
      b.el.title = key ? `${b.el.dataset.title} (${key})` : b.el.dataset.title ?? '';
    }
    const play = this.toolbarButtons.find((b) => b.command === 'play.toggle');
    if (play) play.el.innerHTML = ed.playing ? icons.pause : icons.play;

    this.clock.textContent = formatTime(ed.playhead);
    document.getElementById('empty-state')!.classList.toggle('hidden', !!ed.info);

    const info = ed.info;
    this.status.file.textContent = info
      ? `${basename(info.path)} · ${info.sampleRate / 1000} kHz · ${info.bitsPerSample}-bit ${info.sampleFormat === 'float' ? 'float' : ''} · ${info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} ch`} · ${formatTime(info.duration, 1)}`
      : 'No file';
    const r = ed.selectedRegion();
    this.status.selection.textContent = r
      ? `${ed.selection!.kind === 'segment' ? `Segment #${ed.segmentNumber(r.id)}` : 'Cut'}: ${formatTime(r.start)} – ${formatTime(r.end)} (${formatTime(r.end - r.start)})`
      : '';
    const msPerPx = ed.view.secPerPx * 1000;
    this.status.zoom.textContent = info ? `1 px = ${msPerPx < 10 ? msPerPx.toFixed(2) : msPerPx.toFixed(0)} ms` : '';

    let hint = '';
    if (ed.markIn !== null) hint = `IN marked at ${formatTime(ed.markIn)}. Press ${this.keymap.label('mark.out') || 'O'} at the end of the segment, or Esc to cancel.`;
    else if (ed.cutMark !== null) hint = `Cut start marked at ${formatTime(ed.cutMark)}. Press ${this.keymap.label('mark.cut') || 'X'} again at the end of the cut, or Esc to cancel.`;
    else if (!info) hint = '';
    else if (ed.tool === 'segment') hint = 'Drag on the waveform to mark an output file. Drag edges to adjust. Hold Alt to turn off snapping.';
    else if (ed.tool === 'cut') hint = 'Drag on the waveform to mark audio to cut out. Drag edges to adjust. Hold Alt to turn off snapping.';
    else hint = 'Drag in the top lane to add a segment, in the bottom lane to add a cut. Wheel zooms, Shift+wheel scrolls. Right-click for more.';
    this.status.hint.textContent = hint;

    const name = ed.wavPath ? basename(ed.wavPath) : null;
    document.title = `${name ? `${name}${ed.dirty ? ' •' : ''} — ` : ''}Studio Audio Editor`;
    window.studio.setTitle(document.title);
  }

  // ---------- Global events ----------

  private bindGlobalEvents(): void {
    // Buttons should not keep keyboard focus, or Space would click them again.
    document.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });

    document.addEventListener('keydown', (e) => {
      if (modalOpen() || e.defaultPrevented) return;
      const id = this.keymap.commandFor(e);
      const target = e.target as HTMLElement;
      const typing = target.matches('input, select, textarea');
      if (typing) {
        // In text fields only app-level Ctrl shortcuts apply; everything else is typing.
        if (!id || !(e.ctrlKey || e.metaKey) || !['file.save', 'file.export', 'file.open', 'app.settings'].includes(id)) return;
        target.blur();
      }
      if (!id) return;
      e.preventDefault();
      closeContextMenu();
      this.commands.run(id);
    });

    document.getElementById('empty-state')!.addEventListener('click', () => this.commands.run('file.open'));

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.body.classList.add('dragging');
    });
    document.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) document.body.classList.remove('dragging');
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dragging');
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const path = window.studio.pathForDroppedFile(file);
      if (!/\.wav$/i.test(path)) return toast('Only .wav files can be opened.', 'error');
      void this.openPath(path);
    });

    window.studio.onSaveAndClose(async () => {
      if (await this.save()) window.studio.closeNow();
    });
  }
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Electron prefixes errors thrown in the main process.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
