import { formatNumber, getLanguage, LANGUAGES, resolveLanguage, t, translateCodes, type LanguageSetting } from '../shared/i18n/index.ts';
import { highestNumber, usesToken, type FolderRule } from '../shared/naming.ts';
import { formatTime } from '../shared/time.ts';
import { FADE_CURVES, FADE_MARKER_STYLES, type Bitrate, type ExportProgress, type FadeCurve, type FadeMarkerStyle, type PeakTarget, type Project, type Segment, type Settings, type UpdateState, segmentFolder } from '../shared/types.ts';
import { onlyStillRecording, outputFilename } from '../shared/validate.ts';
import { CommandRegistry, Keymap, overridesFrom } from './commands.ts';
import { ShortcutEditor } from './shortcut-editor.ts';
import { choose, closeContextMenu, modalOpen, openModal, showContextMenu, showLoading, toast } from './dialogs.ts';
import { h, pathText } from './dom.ts';
import { clamp, Editor, MIN_REGION_SEC, type RegionKind, type Selection, type Tool } from './editor.ts';
import { icons } from './icons.ts';
import { Overview } from './overview.ts';
import { OutputPanel } from './panel.ts';
import { PeakPyramid } from './peaks.ts';
import { Player } from './player.ts';
import { RecordingController } from './recording.ts';
import { Timeline } from './timeline.ts';

const NUDGE_SEC = 0.01;
const STEP_SEC = 1;
const BIG_STEP_SEC = 10;
/** sessionStorage key holding the open work while the window reloads to switch language. */
const RELOAD_STATE_KEY = 'sae.reloadState';

/** Context played after a fade-in or before a fade-out by the segment start/end preview. */
const EDGE_PREVIEW_SEC = 3;
const basename = (p: string) => p.replace(/^.*[\\/]/, '');
const dirname = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

interface ReloadState {
  wavPath: string;
  project: Project;
  dirty: boolean;
  view: { start: number; secPerPx: number };
  playhead: number;
  selection: Selection | null;
  tool: Tool;
  skipCuts: boolean;
}

export class App {
  readonly editor = new Editor();
  readonly commands = new CommandRegistry();
  private keymap = new Keymap();
  private readonly player: Player;
  private readonly panel: OutputPanel;
  private readonly toolbarButtons: { el: HTMLButtonElement; command: string; active?: () => boolean }[] = [];
  private readonly clock = h('div', { id: 'clock' }, '0:00.000');
  private readonly recording: RecordingController;
  private readonly rec = {
    button: h('button', { class: 'rec-button', onclick: () => this.commands.run(this.recording.active ? 'rec.stop' : 'rec.start') }),
    time: h('div', { class: 'rec-time', title: t('tb.recTime.tip') }),
    box: h('div', { class: 'tb-group rec-live hidden' }),
  };
  private readonly status = {
    file: h('span'),
    selection: h('span'),
    zoom: h('span'),
    hint: h('span', { class: 'hint' }),
  };
  private exporting = false;
  /** Status bar notice for a new version: downloading, ready to install, or to download. */
  private readonly updateNotice = h('button', { class: 'update-notice hidden', onclick: () => void this.onUpdateNotice() });
  private update: UpdateState = { status: 'idle' };
  private version = '';
  /** Output folders being scanned for their next free {nn}. */
  private readonly numbering = new Map<string, Promise<void>>();

  constructor(settings: Settings) {
    const ed = this.editor;
    ed.settings = settings;
    document.documentElement.lang = getLanguage();
    document.getElementById('empty-title')!.textContent = t('empty.title');
    document.getElementById('empty-record')!.textContent = t('empty.record');

    this.player = new Player(ed);
    this.recording = new RecordingController(ed, {
      begin: (info, peaks) => {
        this.player.pause();
        ed.startLive(info, peaks);
        ed.project.outputDirs = [dirname(info.path)];
        this.player.load();
      },
      confirmDiscard: () => this.confirmDiscard(),
      canStart: () => {
        if (this.exporting) toast(t('toast.waitForExport'), 'error');
        return !this.exporting;
      },
      refresh: () => this.refreshChrome(),
    });
    new Overview(document.getElementById('overview') as HTMLCanvasElement, ed);
    new Timeline(document.getElementById('timeline') as HTMLCanvasElement, ed, this.player, {
      showContextMenu,
      focusSegmentName: (id) => this.panel.focusName(id),
      shortcut: (id) => this.keymap.label(id),
      run: (id) => this.commands.run(id),
    });
    this.panel = new OutputPanel(document.getElementById('panel')!, ed, {
      changeFolder: (index) => void this.changeFolder(index),
      addFolder: () => void this.addFolder(),
      removeFolder: (index) => this.removeFolder(index),
      exportAll: () => this.commands.run('file.export'),
      playRegion: (kind, id) => this.playRegion(kind, id),
      playSegmentEdge: (id, edge) => this.playSegmentEdge(edge, id),
      zoomTo: (kind, id) => {
        const r = ed.region({ kind, id });
        if (r) ed.zoomToRange(r.start, r.end);
        ed.select({ kind, id });
      },
      deleteRegion: (kind, id) => this.deleteRegion(kind, id),
      togglePlay: () => this.player.toggle(),
      shortcut: (id) => this.keymap.label(id),
    });

    this.registerCommands();
    this.buildToolbar();
    this.buildStatusbar();
    this.bindGlobalEvents();
    ed.subscribe(() => this.refreshChrome());
    ed.subscribe((changes) => {
      if (changes.has('project') || changes.has('settings') || changes.has('audio')) void this.ensureNumbering();
    });
  }

  async init(): Promise<void> {
    await this.reloadKeymap();
    this.version = await window.studio.appVersion();
    window.studio.onUpdateState((state) => this.showUpdate(state));
    this.showUpdate(await window.studio.getUpdateState());
    this.editor.notify('settings', 'ui');
    window.studio.onOpenFile((path) => void this.openPath(path));
    if (await this.restoreAfterReload()) return;
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
      { id: 'file.open', label: t('cmd.file.open'), run: () => this.openWithDialog() },
      { id: 'file.save', label: t('cmd.file.save'), run: () => void this.save(), enabled: hasAudio },
      { id: 'file.export', label: t('cmd.file.export'), run: () => this.exportAll(), enabled: () => hasAudio() && !this.exporting },
      { id: 'edit.undo', label: t('cmd.edit.undo'), run: () => ed.undo(), enabled: () => ed.canUndo },
      { id: 'edit.redo', label: t('cmd.edit.redo'), run: () => ed.redo(), enabled: () => ed.canRedo },
      {
        id: 'edit.delete', label: t('cmd.edit.delete'), enabled: hasSelection,
        run: () => {
          if (ed.selection) this.deleteRegion(ed.selection.kind, ed.selection.id);
        },
      },
      {
        id: 'edit.escape', label: t('cmd.edit.escape'),
        run: () => {
          if (ed.markIn !== null || ed.cutMark !== null) {
            ed.markIn = null;
            ed.cutMark = null;
            ed.notify('ui');
          } else ed.select(null);
        },
      },
      { id: 'edit.setStart', label: t('cmd.edit.setStart'), enabled: hasSelection, run: () => this.setEdge('start', ed.playhead) },
      { id: 'edit.setEnd', label: t('cmd.edit.setEnd'), enabled: hasSelection, run: () => this.setEdge('end', ed.playhead) },
      { id: 'tool.select', label: t('cmd.tool.select'), run: () => ed.setTool('select') },
      { id: 'tool.segment', label: t('cmd.tool.segment'), run: () => ed.setTool('segment') },
      { id: 'tool.cut', label: t('cmd.tool.cut'), run: () => ed.setTool('cut') },
      { id: 'play.toggle', label: t('cmd.play.toggle'), run: () => this.player.toggle(), enabled: hasAudio },
      {
        id: 'play.selection', label: t('cmd.play.selection'), enabled: hasAudio,
        run: () => (ed.selection ? this.playRegion(ed.selection.kind, ed.selection.id) : void this.player.play()),
      },
      { id: 'play.segmentStart', label: t('cmd.play.segmentStart'), enabled: hasAudio, run: () => this.playSegmentEdge('start') },
      { id: 'play.segmentEnd', label: t('cmd.play.segmentEnd'), enabled: hasAudio, run: () => this.playSegmentEdge('end') },
      {
        id: 'play.skipCuts', label: t('cmd.play.skipCuts'),
        run: () => {
          ed.skipCuts = !ed.skipCuts;
          ed.notify('ui');
          toast(ed.skipCuts ? t('toast.skipCutsOn') : t('toast.skipCutsOff'));
        },
      },
      { id: 'playhead.start', label: t('cmd.playhead.start'), run: () => this.moveTo(0), enabled: hasAudio },
      { id: 'playhead.end', label: t('cmd.playhead.end'), run: () => this.moveTo(ed.duration), enabled: hasAudio },
      {
        id: 'playhead.selectionStart', label: t('cmd.playhead.selectionStart'), enabled: hasSelection,
        run: () => this.moveTo(selection()!.start),
      },
      {
        id: 'playhead.selectionEnd', label: t('cmd.playhead.selectionEnd'), enabled: hasSelection,
        run: () => this.moveTo(selection()!.end),
      },
      {
        id: 'playhead.segmentStart', label: t('cmd.playhead.segmentStart'), enabled: hasAudio,
        run: () => this.toSegmentEdge('start'),
      },
      {
        id: 'playhead.segmentEnd', label: t('cmd.playhead.segmentEnd'), enabled: hasAudio,
        run: () => this.toSegmentEdge('end'),
      },
      { id: 'playhead.prevEdge', label: t('cmd.playhead.prevEdge'), run: () => this.jumpToEdge(-1), enabled: hasAudio },
      { id: 'playhead.nextEdge', label: t('cmd.playhead.nextEdge'), run: () => this.jumpToEdge(1), enabled: hasAudio },
      { id: 'playhead.show', label: t('cmd.playhead.show'), run: () => this.centerOn(ed.playhead), enabled: hasAudio },
      { id: 'view.pageBack', label: t('cmd.view.pageBack'), run: () => ed.scrollBy(-ed.view.widthPx * 0.9), enabled: hasAudio },
      { id: 'view.pageForward', label: t('cmd.view.pageForward'), run: () => ed.scrollBy(ed.view.widthPx * 0.9), enabled: hasAudio },
      { id: 'playhead.back', label: t('cmd.playhead.back', { sec: STEP_SEC }), run: () => seekBy(-STEP_SEC), enabled: hasAudio },
      { id: 'playhead.forward', label: t('cmd.playhead.forward', { sec: STEP_SEC }), run: () => seekBy(STEP_SEC), enabled: hasAudio },
      { id: 'playhead.backBig', label: t('cmd.playhead.backBig', { sec: BIG_STEP_SEC }), run: () => seekBy(-BIG_STEP_SEC), enabled: hasAudio },
      { id: 'playhead.forwardBig', label: t('cmd.playhead.forwardBig', { sec: BIG_STEP_SEC }), run: () => seekBy(BIG_STEP_SEC), enabled: hasAudio },
      { id: 'mark.in', label: t('cmd.mark.in'), run: () => this.markIn(), enabled: hasAudio },
      { id: 'mark.out', label: t('cmd.mark.out'), run: () => this.markOut(), enabled: hasAudio },
      { id: 'mark.cut', label: t('cmd.mark.cut'), run: () => this.markCut(), enabled: hasAudio },
      { id: 'nudge.startBack', label: t('cmd.nudge.startBack'), run: () => this.nudge('start', -NUDGE_SEC), enabled: hasSelection },
      { id: 'nudge.startForward', label: t('cmd.nudge.startForward'), run: () => this.nudge('start', NUDGE_SEC), enabled: hasSelection },
      { id: 'nudge.endBack', label: t('cmd.nudge.endBack'), run: () => this.nudge('end', -NUDGE_SEC), enabled: hasSelection },
      { id: 'nudge.endForward', label: t('cmd.nudge.endForward'), run: () => this.nudge('end', NUDGE_SEC), enabled: hasSelection },
      { id: 'select.next', label: t('cmd.select.next'), run: () => this.cycleSegment(1), enabled: hasAudio },
      { id: 'select.prev', label: t('cmd.select.prev'), run: () => this.cycleSegment(-1), enabled: hasAudio },
      { id: 'zoom.in', label: t('cmd.zoom.in'), run: () => this.zoom(1.6), enabled: hasAudio },
      { id: 'zoom.out', label: t('cmd.zoom.out'), run: () => this.zoom(1 / 1.6), enabled: hasAudio },
      { id: 'zoom.fit', label: t('cmd.zoom.fit'), run: () => ed.zoomToFit(), enabled: hasAudio },
      {
        id: 'zoom.selection', label: t('cmd.zoom.selection'), enabled: hasSelection,
        run: () => {
          const r = ed.selectedRegion();
          if (r) ed.zoomToRange(r.start, r.end);
        },
      },
      { id: 'rec.start', label: t('cmd.rec.start'), run: () => this.recording.openDialog(), enabled: () => !this.recording.active },
      { id: 'rec.stop', label: t('cmd.rec.stop'), run: () => this.recording.stop(), enabled: () => this.recording.active },
      {
        id: 'view.followLive', label: t('cmd.view.followLive'), enabled: () => ed.recording,
        run: () => {
          ed.followLive = !ed.followLive;
          if (ed.followLive) this.centerOn(ed.duration);
          ed.notify('ui');
          toast(ed.followLive ? t('toast.followLiveOn') : t('toast.followLiveOff'));
        },
      },
      { id: 'app.settings', label: t('cmd.app.settings'), run: () => this.openSettings() },
      { id: 'app.devtools', label: t('cmd.app.devtools'), run: () => window.studio.toggleDevTools() },
    );
  }

  /** Keyboard playhead moves: seek, and scroll so the playhead stays on screen. */
  private moveTo(time: number): void {
    this.player.seek(time);
    this.editor.ensureVisible(this.editor.playhead);
  }

  private centerOn(time: number): void {
    const ed = this.editor;
    ed.scrollTo(time - (ed.view.widthPx * ed.view.secPerPx) / 2);
  }

  /**
   * The segment containing the playhead. Where segments overlap, the selected one wins,
   * then the one that started most recently.
   */
  private segmentAtPlayhead(): Segment | undefined {
    const ed = this.editor;
    const time = ed.playhead;
    const under = ed.sortedSegments().filter((s) => time >= s.start && time <= s.end);
    return under.find((s) => s.id === ed.selection?.id) ?? under.at(-1);
  }

  private toSegmentEdge(edge: 'start' | 'end'): void {
    const seg = this.segmentAtPlayhead();
    if (!seg) return toast(t('toast.notInSegment'), 'error');
    this.moveTo(seg[edge]);
  }

  /** Jumps to the nearest segment or cut boundary before/after the playhead (file start and end count too). */
  private jumpToEdge(dir: 1 | -1): void {
    const ed = this.editor;
    const edges = [0, ed.duration];
    for (const r of [...ed.project.segments, ...ed.project.cuts]) edges.push(r.start, r.end);
    edges.sort((a, b) => a - b);
    const eps = 0.0005;
    const target = dir === 1 ? edges.find((e) => e > ed.playhead + eps) : edges.findLast((e) => e < ed.playhead - eps);
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
        toast(t('toast.emptySegment'), 'error');
        ed.notify('ui');
        return;
      }
      const s = ed.newSegment(start, end);
      ed.commit((p) => p.segments.push(s));
      ed.select({ kind: 'segment', id: s.id });
      toast(t('toast.segmentAdded', { n: ed.segmentNumber(s.id) }));
    } else if (ed.selectedSegment()) {
      this.setEdge('end', ed.playhead);
    } else {
      toast(t('toast.pressInFirst', { key: this.keymap.label('mark.in') || 'I' }), 'error');
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

  private setEdge(edge: 'start' | 'end', time: number): void {
    const ed = this.editor;
    const sel = ed.selection;
    if (!sel) return;
    ed.commit(() => {
      const r = ed.region(sel);
      if (!r) return;
      if (edge === 'start') r.start = clamp(time, 0, r.end - MIN_REGION_SEC);
      else r.end = clamp(time, r.start + MIN_REGION_SEC, ed.duration);
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
      if (!this.editor.skipCuts) toast(t('toast.skipCutsIsOff'));
      void this.player.play(Math.max(0, r.start - 2), Math.min(this.editor.duration, r.end + 2));
    } else void this.player.play(r.start, r.end);
  }

  /**
   * Plays just the fade-in (start) or fade-out (end) of a segment with a few seconds of
   * context: the segment given, else the selected one, else the one under the playhead.
   */
  private playSegmentEdge(edge: 'start' | 'end', id?: string): void {
    const ed = this.editor;
    const seg = id ? ed.project.segments.find((s) => s.id === id) : ed.previewSegment ?? this.segmentAtPlayhead();
    if (!seg) return toast(t('toast.notInSegment'), 'error');
    ed.select({ kind: 'segment', id: seg.id });
    if (!ed.skipCuts) toast(t('toast.skipCutsIsOff'));
    const { fadeInSec, fadeOutSec } = ed.settings;
    if (edge === 'start') void this.player.play(seg.start, Math.min(seg.end, seg.start + fadeInSec + EDGE_PREVIEW_SEC));
    else void this.player.play(Math.max(seg.start, seg.end - fadeOutSec - EDGE_PREVIEW_SEC), seg.end);
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
    const answer = await choose(t('dlg.unsaved.title'), t('dlg.unsaved.message'), [
      { label: t('btn.cancel'), value: 'cancel' },
      { label: t('btn.dontSave'), value: 'discard' },
      { label: t('btn.save'), value: 'save', primary: true },
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

  /** Opens a WAV. Resolves to true when it loaded. */
  async openPath(path: string, confirm = true, quiet = false): Promise<boolean> {
    if (this.exporting) {
      toast(t('toast.waitForExport'), 'error');
      return false;
    }
    if (this.recording.active) {
      toast(t('toast.stopRecordingFirst'), 'error');
      return false;
    }
    if (confirm && !(await this.confirmDiscard())) return false;
    this.player.pause();
    const loading = showLoading(t('dlg.loading', { name: basename(path) }));
    const off = window.studio.onLoadProgress((f) => loading.update(f));
    try {
      const loaded = await window.studio.loadAudio(path);
      const peaks = new PeakPyramid(loaded.peaks);
      this.editor.loadAudio(loaded.info.path, loaded.info, peaks, loaded.project);
      if (!this.editor.project.outputDirs.length) this.editor.project.outputDirs = [dirname(loaded.info.path)];
      this.player.load();
      if (loaded.project && !quiet) toast(t('toast.projectLoaded', { name: basename(path) }));
      return true;
    } catch (err) {
      toast(t('toast.openFailed', { name: basename(path), error: errorText(err) }), 'error');
      return false;
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
      toast(t('toast.saved'));
      return true;
    } catch (err) {
      toast(t('toast.saveFailed', { error: errorText(err) }), 'error');
      return false;
    }
  }

  // ---------- Output folders ----------

  /**
   * Gives each output folder whose naming rule uses {nn} its first number: one past the highest
   * already in the folder. Found once and kept in the session, so exporting again does not
   * count the session's own files.
   */
  private ensureNumbering(): Promise<void> {
    const ed = this.editor;
    const pending: Promise<void>[] = [];
    for (const seg of ed.project.segments) {
      const rule = ed.namingRule(seg);
      const folder = segmentFolder(ed.project, seg);
      if (!rule || !folder || !usesToken(rule.template, 'nn') || folder in ed.project.numberStarts) continue;
      let scan = this.numbering.get(folder);
      if (!scan) {
        scan = this.scanNumbers(folder, rule).finally(() => this.numbering.delete(folder));
        this.numbering.set(folder, scan);
      }
      pending.push(scan);
    }
    return Promise.all(pending).then(() => {});
  }

  private async scanNumbers(folder: string, rule: FolderRule): Promise<void> {
    const ed = this.editor;
    const files = await window.studio.listFiles(folder);
    if (folder in ed.project.numberStarts) return;
    // Not an edit of its own: it is saved with the next save or export.
    ed.project.numberStarts[folder] = highestNumber(rule.template, rule.types, files) + 1;
    ed.notify('project');
  }

  /** Asks for a folder, refusing one that is already in the list (except at `keep`). */
  private async askFolder(start: string | null, keep = -1): Promise<string | null> {
    const ed = this.editor;
    const dir = await window.studio.pickFolder(start ?? ed.project.outputDirs[0] ?? (ed.wavPath ? dirname(ed.wavPath) : null));
    if (!dir) return null;
    const at = ed.project.outputDirs.indexOf(dir);
    if (at >= 0 && at !== keep) {
      toast(t('toast.folderAlreadyAdded', { dir }), 'error');
      return null;
    }
    return dir;
  }

  /** Replaces folder `index`; segments that used it move along. Index 0 on an empty list sets the default. */
  private async changeFolder(index: number): Promise<string | null> {
    const ed = this.editor;
    const old = ed.project.outputDirs[index] ?? null;
    const dir = await this.askFolder(old, index);
    if (!dir || dir === old) return dir;
    ed.commit((p) => {
      p.outputDirs[index] = dir;
      for (const s of p.segments) if (old && s.outputDir === old) s.outputDir = dir;
    });
    return dir;
  }

  private async addFolder(): Promise<void> {
    const dir = await this.askFolder(null);
    if (dir) this.editor.commit((p) => p.outputDirs.push(dir));
  }

  /**
   * Removes a folder; its segments go to the default folder. Removing the default makes the
   * next folder the default, so its segments (and the removed default's) follow the new one.
   */
  private removeFolder(index: number): void {
    if (index < 0 || this.editor.project.outputDirs.length < 2) return;
    this.editor.commit((p) => {
      const [removed] = p.outputDirs.splice(index, 1);
      const fallback = index === 0 ? p.outputDirs[0] : null;
      for (const s of p.segments) if (s.outputDir === removed || s.outputDir === fallback) delete s.outputDir;
    });
  }

  // ---------- Language switch ----------

  /**
   * The UI is built once in the chosen language, so switching reloads the window. The open
   * file, its unsaved edits and the view are carried over in sessionStorage (undo history is not).
   */
  private reloadForLanguage(): void {
    const ed = this.editor;
    // Reloading would end the recording; the new language is used from the next start instead.
    if (this.recording.active) return toast(t('toast.languageAfterRecording'));
    if (ed.wavPath) {
      const state: ReloadState = {
        wavPath: ed.wavPath,
        project: ed.project,
        dirty: ed.dirty,
        view: { start: ed.view.start, secPerPx: ed.view.secPerPx },
        playhead: ed.playhead,
        selection: ed.selection,
        tool: ed.tool,
        skipCuts: ed.skipCuts,
      };
      try {
        sessionStorage.setItem(RELOAD_STATE_KEY, JSON.stringify(state));
      } catch {
        // Without storage the file simply is not reopened.
      }
    }
    // The reload itself must not trigger the unsaved-changes prompt; the edits travel along.
    window.studio.setDirty(false);
    location.reload();
  }

  private async restoreAfterReload(): Promise<boolean> {
    let state: ReloadState | null = null;
    try {
      const raw = sessionStorage.getItem(RELOAD_STATE_KEY);
      sessionStorage.removeItem(RELOAD_STATE_KEY);
      state = raw ? (JSON.parse(raw) as ReloadState) : null;
    } catch {
      state = null;
    }
    if (!state) return false;
    toast(t('toast.languageReloaded'));
    if (!(await this.openPath(state.wavPath, false, true))) return true;

    const ed = this.editor;
    ed.project = state.project;
    ed.setDirty(state.dirty);
    ed.tool = state.tool;
    ed.skipCuts = state.skipCuts;
    ed.selection = state.selection && ed.region(state.selection) ? state.selection : null;
    ed.view.secPerPx = state.view.secPerPx;
    ed.scrollTo(state.view.start);
    this.player.seek(state.playhead);
    ed.notify('project', 'selection', 'view', 'ui');
    return true;
  }

  // ---------- Export ----------

  private async exportAll(): Promise<void> {
    const ed = this.editor;
    if (!ed.wavPath || this.exporting) return;
    const all = ed.sortedSegments();
    if (!all.length) return toast(t('toast.nothingToExport'), 'error');

    if (!ed.project.outputDirs.length && !(await this.changeFolder(0))) return;
    await this.ensureNumbering();

    const issues = ed.validate(all);
    // While recording, files whose end is not recorded yet wait for a later export.
    const waiting = all.filter((s) => onlyStillRecording(issues.get(s.id)));
    const segments = all.filter((s) => !waiting.includes(s));
    if (!segments.length) return toast(t('toast.allStillRecording'), 'error');
    const firstBad = segments.find((s) => issues.get(s.id)!.errors.length);
    if (firstBad) {
      const count = segments.filter((s) => issues.get(s.id)!.errors.length).length;
      toast(t('toast.needsFixing', { count }), 'error');
      ed.select({ kind: 'segment', id: firstBad.id });
      this.panel.focusName(firstBad.id);
      return;
    }

    const folders = segments.map((s) => segmentFolder(ed.project, s)!);
    const multipleFolders = new Set(folders).size > 1;

    const names = segments.map((s) => outputFilename(ed.fileName(s).name));
    const options = segments.map((s) => ed.outputOptions(s));
    const existing: string[] = [];
    for (const dir of new Set(folders)) {
      const inDir = names.filter((_, i) => folders[i] === dir);
      for (const name of await window.studio.existingFiles(dir, inDir)) {
        existing.push(multipleFolders ? `${basename(dir)}/${name}` : name);
      }
    }
    if (existing.length) {
      const list = existing.length <= 6
        ? existing.join(', ')
        : t('dlg.overwrite.more', { list: existing.slice(0, 6).join(', '), n: existing.length - 6 });
      const answer = await choose(t('dlg.overwrite.title'), t('dlg.overwrite.message', { count: existing.length, list }),
        [{ label: t('btn.cancel'), value: 'cancel' }, { label: t('btn.overwrite'), value: 'ok', primary: true }], 'cancel');
      if (answer !== 'ok') return;
    }

    this.player.pause();
    this.exporting = true;
    this.refreshChrome();
    const items = segments.map((s, i) => {
      const fill = h('div');
      const bar = h('div', { class: 'bar' }, fill);
      const detail = h('div', { class: 'detail' },
        t('export.itemDetail', { bitrate: options[i].bitrate, peak: options[i].peakTarget === 1 ? '100%' : '60%' }));
      const name = h('div', { class: 'name' }, `#${i + 1}  ${names[i]}`);
      if (multipleFolders) name.append(h('span', { class: 'form-note', title: folders[i] }, `  → ${basename(folders[i])}`));
      const el = h('div', { class: 'export-item' }, name, bar, detail);
      return { el, bar, fill, detail };
    });

    const modal = openModal(t('export.title', { count: segments.length }), { wide: true, dismissable: false });
    modal.body.append(
      h('div', { class: 'form-note' }, multipleFolders ? t('export.toMany', { count: new Set(folders).size }) : t('export.to', { dir: folders[0] })),
      ...items.map((i) => i.el),
    );
    if (waiting.length) {
      const list = waiting.map((s) => `#${ed.segmentNumber(s.id)} ${outputFilename(ed.fileName(s).name)}`).join(', ');
      modal.body.append(h('div', { class: 'form-note' }, t('export.skippedRecording', { list })));
    }
    const cancelBtn = h('button', { onclick: () => void window.studio.cancelExport() }, t('btn.cancel'));
    modal.foot.append(cancelBtn);

    const off = window.studio.onExportProgress((p: ExportProgress) => {
      const item = items[p.index];
      if (!item) return;
      const overall = p.phase === 'measure' ? p.fraction * 0.35 : p.phase === 'encode' ? 0.35 + p.fraction * 0.65 : 1;
      item.fill.style.width = `${Math.round(overall * 100)}%`;
      if (p.phase === 'measure') item.detail.textContent = t('export.measuring');
      if (p.phase === 'encode') item.detail.textContent = t('export.encoding');
      if (p.phase === 'done') {
        item.bar.classList.add('done');
        item.detail.textContent = t('export.done', {
          peak: formatNumber(p.peakDb ?? 0, 1),
          gain: formatNumber(p.gainDb ?? 0, 2),
        });
      }
    });

    try {
      const result = await window.studio.startExport({
        wavPath: ed.wavPath,
        segments: segments.map((s, i) => ({
          ...s, filename: names[i], outputDir: folders[i], peakTarget: options[i].peakTarget, bitrate: options[i].bitrate,
        })),
        cuts: ed.project.cuts,
        settings: ed.settings,
      });
      cancelBtn.remove();
      const count = result.written.length;
      if (result.ok) {
        modal.body.prepend(h('div', { style: { color: 'var(--ok)', fontWeight: '600' } }, t('export.allDone', { count })));
        // Always saved, so the numbers found for the folders stay with what was exported.
        await this.save();
      } else {
        const item = items[count];
        if (item) {
          item.bar.classList.add('failed');
          item.detail.classList.add('err');
          item.detail.textContent = result.cancelled ? t('export.cancelled') : translateCodes(result.error ?? t('export.failed'));
        }
        modal.body.prepend(h('div', { style: { color: result.cancelled ? 'var(--warn)' : 'var(--danger)', fontWeight: '600' } },
          result.cancelled ? t('export.cancelledSummary', { count }) : t('export.errorSummary', { count })));
      }
      if (count) {
        modal.foot.append(h('button', { onclick: () => void window.studio.showInFolder(result.written[0]) }, t('btn.showInFolder')));
      }
      const close = h('button', { class: 'primary', onclick: () => modal.close() }, t('btn.close'));
      modal.foot.append(close);
      close.focus();
    } catch (err) {
      modal.close();
      toast(t('toast.exportFailed', { error: errorText(err) }), 'error');
    } finally {
      off();
      this.exporting = false;
      this.refreshChrome();
    }
  }

  // ---------- Settings ----------

  private openSettings(): void {
    const ed = this.editor;
    const s: Settings = { ...ed.settings, folderRules: ed.settings.folderRules.map((r) => ({ ...r, types: [...r.types] })) };
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
      for (const k of FADE_CURVES) sel.append(h('option', { value: k, selected: k === value }, t(`curve.${k}`)));
      return sel;
    };
    const languageSelect = () => {
      const sel = h('select', { onchange: () => (s.language = sel.value as LanguageSetting) });
      const options: [LanguageSetting, string][] = [
        ['system', t('settings.languageSystem')],
        ...(Object.entries(LANGUAGES) as [LanguageSetting, string][]),
      ];
      for (const [value, label] of options) sel.append(h('option', { value, selected: value === s.language }, label));
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
    const m = openModal(t('settings.title'), { wide: true, onClose: () => shortcuts.dispose() });
    m.body.append(
      h('div', { class: 'form-section' }, t('settings.language')),
      h('div', { class: 'form-grid' },
        h('label', {}, t('settings.languageLabel')),
        h('div', { class: 'inline' }, languageSelect()),
      ),
      h('div', { class: 'form-section' }, t('settings.fileList')),
      h('div', { class: 'form-grid' },
        h('label', { for: 'show-times' }, t('settings.showTimes')),
        h('div', { class: 'inline' },
          h('input', { type: 'checkbox', id: 'show-times', checked: s.showSegmentTimes, onchange: (e: Event) => (s.showSegmentTimes = (e.target as HTMLInputElement).checked) }),
          h('span', { class: 'form-note' }, t('settings.showTimesNote')),
        ),
      ),
      h('div', { class: 'form-section' }, t('settings.fades')),
      h('div', { class: 'form-grid' },
        h('label', {}, t('settings.fadeIn')),
        h('div', { class: 'inline' }, num(s.fadeInSec, 0, 60, 0.1, (v) => (s.fadeInSec = v)), t('settings.seconds'), curveSelect(s.fadeInCurve, (v) => (s.fadeInCurve = v))),
        h('label', {}, t('settings.fadeOut')),
        h('div', { class: 'inline' }, num(s.fadeOutSec, 0, 60, 0.1, (v) => (s.fadeOutSec = v)), t('settings.seconds'), curveSelect(s.fadeOutCurve, (v) => (s.fadeOutCurve = v))),
        h('label', {}, t('settings.fadeMarker')),
        h('div', { class: 'inline' },
          choice(FADE_MARKER_STYLES.map((k): [FadeMarkerStyle, string] => [k, t(`marker.${k}`)]), s.fadeMarkerStyle, (v) => (s.fadeMarkerStyle = v))),
      ),
      h('div', { class: 'form-section' }, t('settings.naming')),
      h('div', { class: 'form-note', html: t('settings.naming.note') }),
      this.folderRulesEditor(s.folderRules),
      h('div', { class: 'form-section' }, t('settings.export')),
      h('div', { class: 'form-grid' },
        h('label', {}, t('settings.ceiling')),
        h('div', { class: 'inline' }, num(s.ceilingDb, -3, 0, 0.1, (v) => (s.ceilingDb = v)), 'dBFS',
          h('span', { class: 'form-note' }, t('settings.ceilingNote'))),
        h('label', {}, t('settings.crossfade')),
        h('div', { class: 'inline' }, num(s.cutCrossfadeMs, 1, 200, 1, (v) => (s.cutCrossfadeMs = v)), 'ms'),
        h('label', {}, t('settings.defaults')),
        h('div', { class: 'inline' },
          choice<number>([[1, '100%'], [0.6, '60%']], s.defaultPeakTarget, (v) => (s.defaultPeakTarget = v as Settings['defaultPeakTarget'])),
          choice<number>([[320, '320 kbps'], [192, '192 kbps']], s.defaultBitrate, (v) => (s.defaultBitrate = v as Settings['defaultBitrate'])),
        ),
      ),
      h('div', { class: 'form-section' }, t('settings.updates')),
      h('div', { class: 'form-grid' },
        h('label', { for: 'check-updates' }, t('settings.checkUpdates')),
        h('div', { class: 'inline' },
          h('input', { type: 'checkbox', id: 'check-updates', checked: s.checkUpdates, onchange: (e: Event) => (s.checkUpdates = (e.target as HTMLInputElement).checked) }),
          h('span', { class: 'form-note' }, t('settings.checkUpdatesNote')),
        ),
        h('label', {}, t('settings.version')),
        h('div', { class: 'inline' }, this.version, h('button', { onclick: () => void this.checkForUpdatesNow() }, t('settings.checkNow'))),
      ),
      h('div', { class: 'form-section' }, t('settings.shortcuts')),
      shortcuts.el,
    );
    m.foot.append(
      h('button', { onclick: () => m.close() }, t('btn.cancel')),
      h('button', {
        class: 'primary',
        onclick: async () => {
          const languageChanged = resolveLanguage(s.language, navigator.language) !== getLanguage();
          ed.settings = s;
          await window.studio.saveSettings(s);
          await window.studio.saveShortcutOverrides(overridesFrom(shortcuts.result()));
          m.close();
          if (languageChanged) return this.reloadForLanguage();
          await this.reloadKeymap();
          ed.notify('settings', 'project');
        },
      }, t('btn.save')),
    );
  }

  /** Editable list of naming rules (folder, start of the name, {type} options); edits `rules` in place. */
  private folderRulesEditor(rules: FolderRule[]): HTMLElement {
    const list = h('div', { class: 'naming-rules' });
    const render = () => {
      list.replaceChildren(
        ...rules.map((rule, i) => {
          const template = h('input', {
            type: 'text', class: 'naming-template', value: rule.template, placeholder: '{nn}_{type}_',
            spellcheck: false, title: t('settings.naming.template'),
            oninput: () => (rule.template = template.value),
          });
          const types = h('input', {
            type: 'text', class: 'naming-types', value: rule.types.join(', '), placeholder: t('settings.naming.types'),
            spellcheck: false, title: t('settings.naming.types'),
            onchange: () => {
              rule.types = [...new Set(types.value.split(',').map((v) => v.trim()).filter(Boolean))];
              types.value = rule.types.join(', ');
            },
          });
          const option = <T extends number>(values: [T, string][], value: T | undefined, set: (v: T | undefined) => void) => {
            const sel = h('select', { onchange: () => set(sel.value === '' ? undefined : (Number(sel.value) as T)) });
            sel.append(h('option', { value: '', selected: value === undefined }, t('settings.rule.notSet')));
            for (const [v, label] of values) sel.append(h('option', { value: String(v), selected: v === value }, label));
            return sel;
          };
          const options = h('div', { class: 'naming-rule-options' },
            t('settings.rule.peak'),
            option<PeakTarget>([[1, '100%'], [0.6, '60%']], rule.peakTarget, (v) => {
              if (v === undefined) delete rule.peakTarget;
              else rule.peakTarget = v;
            }),
            t('settings.rule.bitrate'),
            option<Bitrate>([[320, '320 kbps'], [192, '192 kbps']], rule.bitrate, (v) => {
              if (v === undefined) delete rule.bitrate;
              else rule.bitrate = v;
            }),
          );
          return h('div', { class: 'naming-rule-wrap' }, h('div', { class: 'naming-rule' },
            h('div', { class: 'folder-path', title: rule.folder }, pathText(rule.folder)),
            h('button', {
              class: 'icon', html: icons.folder, title: t('settings.naming.folder.tip'),
              onclick: async () => {
                const dir = await window.studio.pickFolder(rule.folder);
                if (dir) {
                  rule.folder = dir;
                  render();
                }
              },
            }),
            template,
            types,
            h('button', {
              class: 'icon danger', html: icons.trash, title: t('settings.naming.remove.tip'),
              onclick: () => {
                rules.splice(i, 1);
                render();
              },
            }),
          ), options);
        }),
      );
      if (!rules.length) list.append(h('div', { class: 'form-note' }, t('settings.naming.empty')));
      list.append(h('button', {
        class: 'folder-add',
        onclick: async () => {
          const dir = await window.studio.pickFolder(this.editor.project.outputDirs[0] ?? null);
          if (!dir) return;
          rules.push({ id: crypto.randomUUID(), folder: dir, template: '', types: [] });
          render();
        },
      }, t('settings.naming.add')));
    };
    render();
    return list;
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
    const tool = (tl: Tool, icon: string, text: string, title: string) =>
      btn(`tool.${tl}`, icon, text, title, () => this.editor.tool === tl);
    const group = (...els: HTMLElement[]) => h('div', { class: 'tb-group' }, ...els);
    const sep = () => h('div', { class: 'tb-sep' });

    this.rec.box.append(
      this.rec.time,
      this.recording.meter.el,
      btn('view.followLive', icons.follow, null, t('tb.follow.tip'), () => this.editor.followLive),
    );

    const playBtn = btn('play.toggle', icons.play, null, t('tb.play.tip'));
    this.toolbarButtons.at(-1)!.active = () => this.editor.playing;

    bar.append(
      group(btn('file.open', icons.open, t('tb.open'), t('tb.open.tip')), btn('file.save', icons.save, t('tb.save'), t('tb.save.tip'))),
      sep(),
      group(btn('edit.undo', icons.undo, null, t('tb.undo.tip')), btn('edit.redo', icons.redo, null, t('tb.redo.tip'))),
      sep(),
      h('div', { class: 'segmented' },
        tool('select', icons.pointer, t('tb.select'), t('tb.select.tip')),
        tool('segment', icons.segment, t('tb.segment'), t('tb.segment.tip')),
        tool('cut', icons.cut, t('tb.cut'), t('tb.cut.tip')),
      ),
      sep(),
      group(
        playBtn,
        btn('play.selection', icons.playSelection, null, t('tb.playSelection.tip')),
        btn('play.skipCuts', icons.skip, t('tb.skipCuts'), t('tb.skipCuts.tip'), () => this.editor.skipCuts),
      ),
      sep(),
      group(
        btn('zoom.out', icons.zoomOut, null, t('tb.zoomOut.tip')),
        btn('zoom.in', icons.zoomIn, null, t('tb.zoomIn.tip')),
        btn('zoom.selection', icons.zoomSel, null, t('tb.zoomSelection.tip')),
        btn('zoom.fit', icons.fit, null, t('tb.zoomFit.tip')),
      ),
      sep(),
      this.rec.button,
      this.rec.box,
      h('div', { class: 'tb-spacer' }),
      this.clock,
      btn('app.settings', icons.settings, null, t('tb.settings.tip')),
    );
  }

  private buildStatusbar(): void {
    const s = this.status;
    document.getElementById('statusbar')!.append(s.file, s.selection, s.zoom, s.hint, this.updateNotice);
  }

  // ---------- Updates ----------

  private showUpdate(state: UpdateState): void {
    this.update = state;
    const el = this.updateNotice;
    const shown = state.status === 'downloading' || state.status === 'ready' || state.status === 'available';
    el.classList.toggle('hidden', !shown);
    el.disabled = state.status === 'downloading';
    if (state.status === 'downloading') {
      el.textContent = t('update.downloading', { version: state.version, percent: state.percent });
      el.title = '';
    } else if (state.status === 'ready') {
      el.textContent = t('update.ready', { version: state.version });
      el.title = t('update.ready.tip');
    } else if (state.status === 'available') {
      el.textContent = t('update.available', { version: state.version });
      el.title = t('update.available.tip');
    }
  }

  private async onUpdateNotice(): Promise<void> {
    const state = this.update;
    if (state.status === 'available') return void window.studio.openDownloadPage();
    if (state.status !== 'ready') return;
    // Restarting must not lose anything: not during a recording or an export, and edits are
    // saved or deliberately dropped first.
    if (this.recording.active) return toast(t('update.afterRecording'), 'error');
    if (this.exporting) return toast(t('toast.waitForExport'), 'error');
    if (!(await this.confirmDiscard())) return;
    const ed = this.editor;
    const wasDirty = ed.dirty;
    ed.setDirty(false);
    const result = await window.studio.installUpdate();
    if (result.status === 'error') {
      ed.setDirty(wasDirty);
      toast(t('update.installFailed', { error: result.message }), 'error');
      this.showUpdate({ status: 'available', version: state.version });
    }
  }

  /** "Check now" in Settings: says what was found, unlike the quiet check at startup. */
  private async checkForUpdatesNow(): Promise<void> {
    toast(t('update.checking'));
    const state = await window.studio.checkForUpdates();
    if (state.status === 'none') toast(t('update.upToDate', { version: this.version }));
    else if (state.status === 'unsupported') toast(t('update.devBuild'));
    else if (state.status === 'error') toast(t('update.failed', { error: state.message }), 'error');
    else if (state.status === 'downloading' || state.status === 'ready' || state.status === 'available') {
      toast(t('update.found', { version: state.version }));
    }
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
    const recording = this.recording.active;
    const rb = this.rec.button;
    rb.innerHTML = recording ? icons.stop : icons.record;
    rb.append(recording ? t('tb.stop') : t('tb.record'));
    rb.classList.toggle('recording', recording);
    rb.disabled = !this.commands.isEnabled(recording ? 'rec.stop' : 'rec.start');
    const recKey = this.keymap.label(recording ? 'rec.stop' : 'rec.start');
    const recTip = recording ? t('tb.stop.tip') : t('tb.record.tip');
    rb.title = recKey ? `${recTip} (${recKey})` : recTip;
    this.rec.box.classList.toggle('hidden', !recording);
    this.rec.time.textContent = `● ${this.recording.elapsedText}`;
    document.getElementById('empty-state')!.classList.toggle('hidden', !!ed.info);
    document.getElementById('empty-sub')!.textContent = t('empty.sub', { key: this.keymap.label('file.open') || 'Ctrl+O' });

    const info = ed.info;
    if (info) {
      const channels = info.channels === 1 ? t('status.mono') : info.channels === 2 ? t('status.stereo') : t('status.channels', { n: info.channels });
      const bits = `${info.bitsPerSample}-bit${info.sampleFormat === 'float' ? ` ${t('status.float')}` : ''}`;
      this.status.file.textContent =
        `${basename(info.path)} · ${formatNumber(info.sampleRate / 1000, info.sampleRate % 1000 ? 1 : 0)} kHz · ${bits} · ${channels} · ${formatTime(info.duration, 1)}${ed.recording ? ` · ${t('status.recording')}` : ''}`;
    } else {
      this.status.file.textContent = t('status.noFile');
    }
    const r = ed.selectedRegion();
    this.status.selection.textContent = r
      ? `${ed.selection!.kind === 'segment' ? t('status.segment', { n: ed.segmentNumber(r.id) }) : t('status.cut')}: ${formatTime(r.start)} – ${formatTime(r.end)} (${formatTime(r.end - r.start)})`
      : '';
    const msPerPx = ed.view.secPerPx * 1000;
    this.status.zoom.textContent = info ? t('status.zoom', { ms: formatNumber(msPerPx, msPerPx < 10 ? 2 : 0) }) : '';

    let hint = '';
    if (ed.markIn !== null) hint = t('hint.markIn', { time: formatTime(ed.markIn), key: this.keymap.label('mark.out') || 'O' });
    else if (ed.cutMark !== null) hint = t('hint.cutMark', { time: formatTime(ed.cutMark), key: this.keymap.label('mark.cut') || 'X' });
    else if (!info) hint = '';
    else if (ed.tool === 'segment') hint = t('hint.segment');
    else if (ed.tool === 'cut') hint = t('hint.cut');
    else hint = t('hint.select');
    this.status.hint.textContent = hint;

    const name = ed.wavPath ? basename(ed.wavPath) : null;
    document.title = `${name ? `${name}${ed.dirty ? ' •' : ''} — ` : ''}${t('app.name')}`;
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
      if (!/\.wav$/i.test(path)) return toast(t('toast.onlyWav'), 'error');
      void this.openPath(path);
    });

    window.studio.onSaveAndClose(async () => {
      if (await this.save()) window.studio.closeNow();
    });
  }
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Electron prefixes errors thrown in the main process; coded errors become the UI language.
  return translateCodes(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
}
