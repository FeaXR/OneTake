import { formatTime, parseTime } from '../shared/time.ts';
import type { Bitrate, PeakTarget, Segment } from '../shared/types.ts';
import { outputDurationOf } from '../shared/plan.ts';
import { validateSegments } from '../shared/validate.ts';
import { h } from './dom.ts';
import { clamp, MIN_REGION_SEC, type Change, type Editor } from './editor.ts';
import { toast } from './dialogs.ts';
import { icons } from './icons.ts';

export interface PanelActions {
  pickFolder(): void;
  exportAll(): void;
  playRegion(kind: 'segment' | 'cut', id: string): void;
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
  private readonly folderEl = h('div', { class: 'folder-path' });
  private readonly cutsSummary = h('summary');
  private readonly cutsList = h('div', { class: 'cuts-list' });
  private readonly exportBtn: HTMLButtonElement;
  private readonly exportNote = h('span', { class: 'form-note' });

  constructor(root: HTMLElement, editor: Editor, actions: PanelActions) {
    this.editor = editor;
    this.actions = actions;
    this.exportBtn = h('button', { class: 'primary', html: icons.export, onclick: () => actions.exportAll() });
    this.exportBtn.append('Export all');

    root.append(
      h('div', { class: 'panel-head' },
        h('div', { class: 'panel-title' }, 'Output files', this.countEl),
        h('div', { class: 'folder-row' },
          this.folderEl,
          h('button', { html: icons.folder, title: 'Choose the folder the MP3 files are written to', onclick: () => actions.pickFolder() }, 'Folder…'),
        ),
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
    const issues = validateSegments(segments, ed.project.cuts, ed.settings);

    this.countEl.textContent = segments.length ? `(${segments.length})` : '';
    this.emptyEl.style.display = segments.length ? 'none' : '';
    this.emptyEl.innerHTML = ed.info
      ? 'No output files yet.<br>Drag in the <b>top lane</b> (or with the Segment tool on the waveform) to mark one, or press <b>I</b> / <b>O</b> while listening.'
      : 'Open a WAV file to begin.';

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

    const dir = ed.project.outputDir;
    this.folderEl.textContent = dir ?? 'No output folder chosen';
    this.folderEl.title = dir ?? '';
    this.folderEl.classList.toggle('missing', !dir);

    const errorCount = [...issues.values()].filter((v) => v.errors.length).length;
    this.exportBtn.disabled = !ed.info || segments.length === 0;
    this.exportNote.textContent = errorCount ? `${errorCount} to fix` : '';
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
      placeholder: 'Filename (required)',
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
        title: edge === 'start' ? 'Start (h:mm:ss.mmm)' : 'End (h:mm:ss.mmm)',
        onfocus: () => ed.select({ kind: 'segment', id }),
        onchange: () => {
          const s = seg();
          const t = parseTime(input.value);
          if (!s) return;
          if (t === null) {
            toast(`"${input.value}" is not a time. Use h:mm:ss.mmm, m:ss or seconds.`, 'error');
            input.value = formatTime(s[edge]);
            return;
          }
          ed.commit(() => {
            if (edge === 'start') s.start = clamp(t, 0, s.end - MIN_REGION_SEC);
            else s.end = clamp(t, s.start + MIN_REGION_SEC, ed.duration);
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
    const peakGroup = h('div', { class: 'segmented', title: 'Peak normalization target' });
    for (const [value, label] of [[1, '100%'], [0.6, '60%']] as const) {
      const b = h('button', { onclick: () => ed.commit(() => { const s = seg(); if (s) s.peakTarget = value; }) }, label);
      peak.set(value, b);
      peakGroup.append(b);
    }
    const bitrate = new Map<Bitrate, HTMLButtonElement>();
    const bitrateGroup = h('div', { class: 'segmented', title: 'MP3 bitrate (kbps)' });
    for (const value of [320, 192] as const) {
      const b = h('button', { onclick: () => ed.commit(() => { const s = seg(); if (s) s.bitrate = value; }) }, String(value));
      bitrate.set(value, b);
      bitrateGroup.append(b);
    }

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
        iconBtn(icons.playSelection, 'Play this segment', () => this.actions.playRegion('segment', id)),
        iconBtn(icons.target, 'Zoom to this segment', () => this.actions.zoomTo('segment', id)),
        iconBtn(icons.trash, 'Delete this segment', () => this.actions.deleteRegion('segment', id), 'danger'),
      ),
      issues,
    );
    return { el, index, name, start, end, dur, peak, bitrate, issues };
  }

  private fillRow(row: Row, seg: Segment, i: number, issues: { errors: string[]; warnings: string[] }): void {
    const ed = this.editor;
    row.el.style.setProperty('--seg-color', ed.segmentColor(seg.id));
    row.el.classList.toggle('selected', ed.selection?.id === seg.id);
    row.el.classList.toggle('has-error', issues.errors.length > 0);
    row.index.textContent = `#${i + 1}`;
    if (document.activeElement !== row.name) row.name.value = seg.filename;
    row.name.classList.toggle('invalid', issues.errors.some((e) => /ilename|character|reserved|end with/.test(e)));
    if (document.activeElement !== row.start) row.start.value = formatTime(seg.start);
    if (document.activeElement !== row.end) row.end.value = formatTime(seg.end);
    const length = outputDurationOf(seg, ed.project.cuts, ed.settings);
    const cutAway = seg.end - seg.start - length;
    row.dur.textContent = formatTime(Math.max(0, length), 1) + (cutAway > 0.005 ? ` (−${cutAway.toFixed(1)}s)` : '');
    row.dur.title = 'Length after cuts';
    for (const [v, b] of row.peak) b.classList.toggle('active', seg.peakTarget === v);
    for (const [v, b] of row.bitrate) b.classList.toggle('active', seg.bitrate === v);
    row.issues.replaceChildren(
      ...issues.errors.map((e) => h('div', { class: 'err' }, e)),
      ...issues.warnings.map((w) => h('div', { class: 'warn' }, w)),
    );
  }

  private updateCuts(): void {
    const ed = this.editor;
    const cuts = ed.sortedCuts();
    const total = cuts.reduce((acc, c) => acc + c.end - c.start, 0);
    this.cutsSummary.textContent = cuts.length ? `Cuts (${cuts.length}, ${total.toFixed(1)} s total)` : 'Cuts (none)';
    this.cutsList.replaceChildren(
      ...cuts.map((c) =>
        h('div', {
          class: `cut-row${ed.selection?.id === c.id ? ' selected' : ''}`,
          onpointerdown: (e: PointerEvent) => {
            if (!(e.target as HTMLElement).closest('button')) ed.select({ kind: 'cut', id: c.id });
          },
        },
          h('span', { class: 'grow' }, `${formatTime(c.start)} → ${formatTime(c.end)}  (${(c.end - c.start).toFixed(2)} s)`),
          h('button', { class: 'icon', html: icons.playSelection, title: 'Play around this cut', onclick: () => this.actions.playRegion('cut', c.id) }),
          h('button', { class: 'icon', html: icons.target, title: 'Zoom to this cut', onclick: () => this.actions.zoomTo('cut', c.id) }),
          h('button', { class: 'icon danger', html: icons.trash, title: 'Delete this cut', onclick: () => this.actions.deleteRegion('cut', c.id) }),
        ),
      ),
    );
  }
}
