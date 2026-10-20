import { formatNumber, t } from '../shared/i18n/index.ts';
import { formatTime, parseTime } from '../shared/time.ts';
import { segmentFolder, type Bitrate, type PeakTarget, type Segment } from '../shared/types.ts';
import { outputDurationOf } from '../shared/plan.ts';
import { validateSegments, type SegmentIssues } from '../shared/validate.ts';
import { h } from './dom.ts';
import { clamp, MIN_REGION_SEC, type Change, type Editor } from './editor.ts';
import { toast } from './dialogs.ts';
import { icons } from './icons.ts';

const folderName = (dir: string) => dir.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || dir;

export interface PanelActions {
  /** Replaces folder `index` (0 = the default). */
  changeFolder(index: number): void;
  addFolder(): void;
  removeFolder(index: number): void;
  exportAll(): void;
  playRegion(kind: 'segment' | 'cut', id: string): void;
  playSegmentEdge(id: string, edge: 'start' | 'end'): void;
  zoomTo(kind: 'segment' | 'cut', id: string): void;
  deleteRegion(kind: 'segment' | 'cut', id: string): void;
  shortcut(commandId: string): string;
}

interface Row {
  el: HTMLElement;
  index: HTMLElement;
  name: HTMLInputElement;
  start: HTMLInputElement;
  end: HTMLInputElement;
  dur: HTMLElement;
  peak: Map<PeakTarget, HTMLButtonElement>;
  bitrate: Map<Bitrate, HTMLButtonElement>;
  folderLine: HTMLElement;
  folder: HTMLSelectElement;
  folderKey: string;
  issues: HTMLElement;
}

/** Right-hand list of output files with their per-file options. */
export class OutputPanel {
  private readonly editor: Editor;
  private readonly actions: PanelActions;
  private readonly rows = new Map<string, Row>();
  private readonly rowsEl = h('div', { class: 'rows' });
  private readonly emptyEl = h('div', { class: 'rows-empty' });
  private readonly countEl = h('span', { class: 'count' });
  private readonly foldersEl = h('div', { class: 'folder-list' });
  private foldersKey: string | null = null;
  private readonly cutsSummary = h('summary');
  private readonly cutsList = h('div', { class: 'cuts-list' });
  private readonly exportBtn: HTMLButtonElement;
  private readonly exportNote = h('span', { class: 'form-note' });

  constructor(root: HTMLElement, editor: Editor, actions: PanelActions) {
    this.editor = editor;
    this.actions = actions;
    this.exportBtn = h('button', { class: 'primary', html: icons.export, onclick: () => actions.exportAll() });
    this.exportBtn.append(t('panel.exportAll'));

    root.append(
      h('div', { class: 'panel-head' },
        h('div', { class: 'panel-title' }, t('panel.title'), this.countEl),
        this.foldersEl,
      ),
      this.rowsEl,
      h('details', { class: 'cuts' }, this.cutsSummary, this.cutsList),
      h('div', { class: 'panel-foot' }, this.exportBtn, this.exportNote),
    );
    this.rowsEl.append(this.emptyEl);
    editor.subscribe((changes) => this.onChange(changes));
    this.update();
  }

  private onChange(changes: Set<Change>): void {
    if (changes.has('project') || changes.has('selection') || changes.has('audio') || changes.has('settings') || changes.has('ui')) {
      this.update(changes.has('selection'));
    }
  }

  focusName(id: string): void {
    this.update();
    const row = this.rows.get(id);
    if (!row) return;
    row.el.scrollIntoView({ block: 'nearest' });
    row.name.focus();
    row.name.select();
  }

  private update(scrollToSelection = false): void {
    const ed = this.editor;
    const segments = ed.sortedSegments();
    const issues = validateSegments(segments, ed.project.cuts, ed.settings, (s) => segmentFolder(ed.project, s));

    this.countEl.textContent = segments.length ? `(${segments.length})` : '';
    this.emptyEl.style.display = segments.length ? 'none' : '';
    this.emptyEl.innerHTML = ed.info
      ? t('panel.empty', { in: this.actions.shortcut('mark.in') || 'I', out: this.actions.shortcut('mark.out') || 'O' })
      : t('panel.emptyNoFile');

    const seen = new Set<string>();
    segments.forEach((seg, i) => {
      seen.add(seg.id);
      let row = this.rows.get(seg.id);
      if (!row) {
        row = this.createRow(seg.id);
        this.rows.set(seg.id, row);
      }
      if (this.rowsEl.children[i + 1] !== row.el) this.rowsEl.insertBefore(row.el, this.rowsEl.children[i + 1] ?? null);
      this.fillRow(row, seg, i, issues.get(seg.id)!);
    });
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }

    this.updateFolders();

    const errorCount = [...issues.values()].filter((v) => v.errors.length).length;
    this.exportBtn.disabled = !ed.info || segments.length === 0;
    this.exportNote.textContent = errorCount ? t('panel.toFix', { n: errorCount }) : '';
    this.exportNote.style.color = errorCount ? 'var(--danger)' : '';

    this.updateCuts();

    if (scrollToSelection && ed.selection?.kind === 'segment') {
      this.rows.get(ed.selection.id)?.el.scrollIntoView({ block: 'nearest' });
    }
  }

  private createRow(id: string): Row {
    const ed = this.editor;
    const seg = () => ed.project.segments.find((s) => s.id === id);

    const name = h('input', {
      type: 'text',
      class: 'name',
      placeholder: t('panel.filename'),
      spellcheck: false,
      onfocus: () => {
        ed.select({ kind: 'segment', id });
        ed.beginGesture();
      },
      oninput: () => ed.live(() => {
        const s = seg();
        if (s) s.filename = name.value;
      }),
      onblur: () => ed.endGesture(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === 'Escape') name.blur();
      },
    });

    const timeInput = (edge: 'start' | 'end') => {
      const input = h('input', {
        type: 'text',
        class: 'time',
        title: edge === 'start' ? t('panel.start.tip') : t('panel.end.tip'),
        onfocus: () => ed.select({ kind: 'segment', id }),
        onchange: () => {
          const s = seg();
          const time = parseTime(input.value);
          if (!s) return;
          if (time === null) {
            toast(t('toast.notATime', { text: input.value }), 'error');
            input.value = formatTime(s[edge]);
            return;
          }
          ed.commit(() => {
            if (edge === 'start') s.start = clamp(time, 0, s.end - MIN_REGION_SEC);
            else s.end = clamp(time, s.start + MIN_REGION_SEC, ed.duration);
          });
          input.value = formatTime(s[edge]);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') input.blur();
          if (e.key === 'Escape') {
            const s = seg();
            if (s) input.value = formatTime(s[edge]);
            input.blur();
          }
        },
      });
      return input;
    };
    const start = timeInput('start');
    const end = timeInput('end');

    const peak = new Map<PeakTarget, HTMLButtonElement>();
    const peakGroup = h('div', { class: 'segmented', title: t('panel.peak.tip') });
    for (const [value, label] of [[1, '100%'], [0.6, '60%']] as const) {
      const b = h('button', { onclick: () => ed.commit(() => { const s = seg(); if (s) s.peakTarget = value; }) }, label);
      peak.set(value, b);
      peakGroup.append(b);
    }
    const bitrate = new Map<Bitrate, HTMLButtonElement>();
    const bitrateGroup = h('div', { class: 'segmented', title: t('panel.bitrate.tip') });
    for (const value of [320, 192] as const) {
      const b = h('button', { onclick: () => ed.commit(() => { const s = seg(); if (s) s.bitrate = value; }) }, String(value));
      bitrate.set(value, b);
      bitrateGroup.append(b);
    }

    const folder = h('select', {
      title: t('panel.rowFolder.tip'),
      onfocus: () => ed.select({ kind: 'segment', id }),
      onchange: () => ed.commit(() => {
        const s = seg();
        if (!s) return;
        if (folder.value) s.outputDir = folder.value;
        else delete s.outputDir;
      }),
    });
    const folderLine = h('div', { class: 'row-line row-folder' }, h('span', { class: 'row-ext', html: icons.folder }), folder);

    const index = h('span', { class: 'row-index' });
    const dur = h('span', { class: 'row-dur' });
    const issues = h('div', { class: 'row-issues' });
    const iconBtn = (icon: string, title: string, onclick: () => void, cls = '') =>
      h('button', { class: `icon ${cls}`, html: icon, title, onclick });

    const el = h('div', {
      class: 'row',
      onpointerdown: (e: PointerEvent) => {
        if (!(e.target as HTMLElement).closest('input, button')) {
          ed.select({ kind: 'segment', id });
          const s = seg();
          if (s && (s.end < ed.view.start || s.start > ed.viewEnd)) ed.zoomToRange(s.start, s.end);
        }
      },
    },
      h('div', { class: 'row-line' }, index, name, h('span', { class: 'row-ext' }, '.mp3')),
      h('div', { class: 'row-line' },
        start, h('span', { class: 'row-ext' }, '→'), end,
        dur,
      ),
      h('div', { class: 'row-line' },
        peakGroup, bitrateGroup,
        h('span', { style: { flex: '1' } }),
        iconBtn(icons.playStart, t('panel.playStart.tip'), () => this.actions.playSegmentEdge(id, 'start')),
        iconBtn(icons.playSelection, t('panel.play.tip'), () => this.actions.playRegion('segment', id)),
        iconBtn(icons.playEnd, t('panel.playEnd.tip'), () => this.actions.playSegmentEdge(id, 'end')),
        iconBtn(icons.target, t('panel.zoom.tip'), () => this.actions.zoomTo('segment', id)),
        iconBtn(icons.trash, t('panel.delete.tip'), () => this.actions.deleteRegion('segment', id), 'danger'),
      ),
      folderLine,
      issues,
    );
    return { el, index, name, start, end, dur, peak, bitrate, folderLine, folder, folderKey: '', issues };
  }

  private fillRow(row: Row, seg: Segment, i: number, issues: SegmentIssues): void {
    const ed = this.editor;
    row.el.style.setProperty('--seg-color', ed.segmentColor(seg.id));
    row.el.classList.toggle('selected', ed.selection?.id === seg.id);
    row.el.classList.toggle('has-error', issues.errors.length > 0);
    row.index.textContent = `#${i + 1}`;
    if (document.activeElement !== row.name) row.name.value = seg.filename;
    row.name.classList.toggle('invalid', issues.errors.some((e) => e.key.startsWith('issue.filename') || e.key === 'issue.duplicate'));
    if (document.activeElement !== row.start) row.start.value = formatTime(seg.start);
    if (document.activeElement !== row.end) row.end.value = formatTime(seg.end);
    const length = outputDurationOf(seg, ed.project.cuts, ed.settings);
    const cutAway = seg.end - seg.start - length;
    row.dur.textContent = formatTime(Math.max(0, length), 1) + (cutAway > 0.005 ? ` (−${formatNumber(cutAway, 1)} s)` : '');
    row.dur.title = t('panel.length.tip');
    for (const [v, b] of row.peak) b.classList.toggle('active', seg.peakTarget === v);
    for (const [v, b] of row.bitrate) b.classList.toggle('active', seg.bitrate === v);
    this.fillFolder(row, seg);
    row.issues.replaceChildren(
      ...issues.errors.map((e) => h('div', { class: 'err' }, t(e.key, e.params))),
      ...issues.warnings.map((w) => h('div', { class: 'warn' }, t(w.key, w.params))),
    );
  }

  /** The folder choice only appears once the project has more than one folder. */
  private fillFolder(row: Row, seg: Segment): void {
    const dirs = this.editor.project.outputDirs;
    row.folderLine.style.display = dirs.length > 1 ? '' : 'none';
    if (dirs.length < 2) return;
    const key = dirs.join('\n');
    if (row.folderKey !== key) {
      row.folderKey = key;
      row.folder.replaceChildren(
        ...dirs.map((dir, i) => h('option', { value: i === 0 ? '' : dir, title: dir },
          i === 0 ? t('panel.defaultFolder', { name: folderName(dir) }) : folderName(dir))),
      );
    }
    const current = segmentFolder(this.editor.project, seg);
    row.folder.value = current === dirs[0] ? '' : current ?? '';
    row.folder.title = current ?? '';
  }

  /** Folder list in the header: the first is the default, the others can be chosen per file. */
  private updateFolders(): void {
    const dirs = this.editor.project.outputDirs;
    const key = dirs.join('\n');
    if (key === this.foldersKey) return;
    this.foldersKey = key;
    const line = (i: number) => {
      const dir = dirs[i] ?? null;
      const path = h('div', { class: `folder-path${dir ? '' : ' missing'}`, title: dir ?? '' }, dir ?? t('panel.noFolder'));
      return h('div', { class: 'folder-row' },
        dirs.length > 1 ? h('span', { class: 'folder-tag' }, i === 0 ? t('panel.default') : `${i + 1}`) : null,
        path,
        h('button', { class: dirs.length > 1 ? 'icon' : '', html: icons.folder, title: i === 0 ? t('panel.folder.tip') : t('panel.extraFolder.tip'), onclick: () => this.actions.changeFolder(i) },
          dirs.length > 1 ? null : t('panel.folder')),
        i > 0 ? h('button', { class: 'icon danger', html: icons.trash, title: t('panel.removeFolder.tip'), onclick: () => this.actions.removeFolder(i) }) : null,
      );
    };
    this.foldersEl.replaceChildren(...(dirs.length ? dirs.map((_, i) => line(i)) : [line(0)]));
    if (dirs.length) {
      this.foldersEl.append(h('button', { class: 'folder-add', title: t('panel.addFolder.tip'), onclick: () => this.actions.addFolder() }, t('panel.addFolder')));
    }
  }

  private updateCuts(): void {
    const ed = this.editor;
    const cuts = ed.sortedCuts();
    const total = cuts.reduce((acc, c) => acc + c.end - c.start, 0);
    this.cutsSummary.textContent = cuts.length
      ? t('panel.cuts', { count: cuts.length, total: formatNumber(total, 1) })
      : t('panel.cutsNone');
    this.cutsList.replaceChildren(
      ...cuts.map((c) =>
        h('div', {
          class: `cut-row${ed.selection?.id === c.id ? ' selected' : ''}`,
          onpointerdown: (e: PointerEvent) => {
            if (!(e.target as HTMLElement).closest('button')) ed.select({ kind: 'cut', id: c.id });
          },
        },
          h('span', { class: 'grow' }, `${formatTime(c.start)} → ${formatTime(c.end)}  (${formatNumber(c.end - c.start, 2)} s)`),
          h('button', { class: 'icon', html: icons.playSelection, title: t('panel.cutPlay.tip'), onclick: () => this.actions.playRegion('cut', c.id) }),
          h('button', { class: 'icon', html: icons.target, title: t('panel.cutZoom.tip'), onclick: () => this.actions.zoomTo('cut', c.id) }),
          h('button', { class: 'icon danger', html: icons.trash, title: t('panel.cutDelete.tip'), onclick: () => this.actions.deleteRegion('cut', c.id) }),
        ),
      ),
    );
  }
}
