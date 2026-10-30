import { formatNumber, t } from '../shared/i18n/index.ts';
import { formatTime, parseTime } from '../shared/time.ts';
import { ruleFor, usesToken } from '../shared/naming.ts';
import { formatPeak, presetChoices } from '../shared/presets.ts';
import { segmentFolder, type Bitrate, type PeakTarget, type Segment } from '../shared/types.ts';
import { outputDurationOf } from '../shared/plan.ts';
import { onlyStillRecording, type SegmentIssues } from '../shared/validate.ts';
import { h, pathText } from './dom.ts';
import { clamp, MIN_REGION_SEC, type Change, type Editor } from './editor.ts';
import { showContextMenu, toast } from './dialogs.ts';
import { icons } from './icons.ts';
import type { ContextItem } from './timeline.ts';

const folderName = (dir: string) => dir.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '') || dir;

export interface PanelActions {
  /** Replaces folder `index` (0 = the default). */
  changeFolder(index: number): void;
  /** Adds an output folder; `anchor` is the button, for the menu of rule folders. */
  addFolder(anchor: HTMLElement): void;
  removeFolder(index: number): void;
  exportAll(): void;
  playRegion(kind: 'segment' | 'cut', id: string): void;
  playSegmentEdge(id: string, edge: 'start' | 'end'): void;
  zoomTo(kind: 'segment' | 'cut', id: string): void;
  deleteRegion(kind: 'segment' | 'cut', id: string): void;
  togglePlay(): void;
  shortcut(commandId: string): string;
}

interface Row {
  el: HTMLElement;
  index: HTMLElement;
  prefix: HTMLButtonElement;
  name: HTMLInputElement;
  start: HTMLInputElement;
  end: HTMLInputElement;
  dur: HTMLElement;
  titleLine: HTMLElement;
  timesLine: HTMLElement;
  peak: Map<PeakTarget, HTMLButtonElement>;
  bitrate: Map<Bitrate, HTMLButtonElement>;
  peakGroup: HTMLElement;
  bitrateGroup: HTMLElement;
  /** Fills the volume and bitrate buttons from the presets (and the values in use). */
  setChoices(peaks: PeakTarget[], bitrates: Bitrate[]): void;
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
    const issues = ed.validate(segments);

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

    // Segments still being recorded are not something to fix; export just leaves them out.
    const errorCount = [...issues.values()].filter((v) => v.errors.length && !onlyStillRecording(v)).length;
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
        // Names have no spaces, so Space keeps its usual job even while typing a name right
        // after marking a segment: play / pause, to listen on.
        if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          this.actions.togglePlay();
        }
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

    // Choosing the folder's default clears the file's own choice, so it follows the folder again.
    const peak = new Map<PeakTarget, HTMLButtonElement>();
    const peakGroup = h('div', { class: 'segmented' });
    const bitrate = new Map<Bitrate, HTMLButtonElement>();
    const bitrateGroup = h('div', { class: 'segmented' });
    let choicesKey = '';
    const setChoices = (peaks: PeakTarget[], bitrates: Bitrate[]) => {
      const key = `${peaks.join()}|${bitrates.join()}`;
      if (key === choicesKey) return;
      choicesKey = key;
      peak.clear();
      peakGroup.replaceChildren(...peaks.map((value) => {
        const b = h('button', {
          onclick: () => ed.commit(() => {
            const s = seg();
            if (!s) return;
            if (value === ed.outputOptions(s).peakDefault) delete s.peakTarget;
            else s.peakTarget = value;
          }),
        }, formatPeak(value));
        peak.set(value, b);
        return b;
      }));
      bitrate.clear();
      bitrateGroup.replaceChildren(...bitrates.map((value) => {
        const b = h('button', {
          onclick: () => ed.commit(() => {
            const s = seg();
            if (!s) return;
            if (value === ed.outputOptions(s).bitrateDefault) delete s.bitrate;
            else s.bitrate = value;
          }),
        }, String(value));
        bitrate.set(value, b);
        return b;
      }));
    };

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
    const folderMenu = h('button', {
      class: 'folder-menu', title: t('panel.folderMenu.tip'),
      onclick: () => {
        const s = seg();
        if (!s) return;
        ed.select({ kind: 'segment', id });
        const r = folderMenu.getBoundingClientRect();
        this.showFolderMenu(s, r.left, r.bottom + 2);
      },
    }, '▾');
    const folderLine = h('div', { class: 'row-line row-folder' }, h('span', { class: 'row-ext', html: icons.folder }), folder, folderMenu);

    const prefix = h('button', {
      class: 'name-prefix',
      onclick: () => {
        const s = seg();
        if (!s) return;
        ed.select({ kind: 'segment', id });
        if (!ed.namingRule(s)) return this.restoreAutoName(s);
        const r = prefix.getBoundingClientRect();
        this.showNameMenu(s, r.left, r.bottom + 2);
      },
    });

    const index = h('span', { class: 'row-index' });
    const dur = h('span', { class: 'row-dur' });
    const titleLine = h('div', { class: 'row-line' }, index, prefix, name, h('span', { class: 'row-ext' }, '.mp3'));
    const timesLine = h('div', { class: 'row-line' }, start, h('span', { class: 'row-ext' }, '→'), end);
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
      titleLine,
      timesLine,
      // With many presets the buttons on the right move to a line of their own.
      h('div', { class: 'row-line row-options' },
        peakGroup, bitrateGroup,
        h('div', { class: 'row-actions' },
          iconBtn(icons.playStart, t('panel.playStart.tip'), () => this.actions.playSegmentEdge(id, 'start')),
          iconBtn(icons.playSelection, t('panel.play.tip'), () => this.actions.playRegion('segment', id)),
          iconBtn(icons.playEnd, t('panel.playEnd.tip'), () => this.actions.playSegmentEdge(id, 'end')),
          iconBtn(icons.target, t('panel.zoom.tip'), () => this.actions.zoomTo('segment', id)),
          iconBtn(icons.trash, t('panel.delete.tip'), () => this.actions.deleteRegion('segment', id), 'danger'),
        ),
      ),
      folderLine,
      issues,
    );
    return { el, index, prefix, name, start, end, dur, titleLine, timesLine, peak, bitrate, peakGroup, bitrateGroup, setChoices, folderLine, folder, folderKey: '', issues };
  }

  private fillRow(row: Row, seg: Segment, i: number, issues: SegmentIssues): void {
    const ed = this.editor;
    row.el.style.setProperty('--seg-color', ed.segmentColor(seg.id));
    row.el.classList.toggle('selected', ed.selection?.id === seg.id);
    row.el.classList.toggle('has-error', issues.errors.length > 0);
    row.index.textContent = `#${i + 1}`;
    if (document.activeElement !== row.name) row.name.value = seg.filename;
    this.fillPrefix(row, seg, issues);
    row.name.classList.toggle('invalid', issues.errors.some((e) => e.key.startsWith('issue.filename') || e.key === 'issue.duplicate'));
    if (document.activeElement !== row.start) row.start.value = formatTime(seg.start);
    if (document.activeElement !== row.end) row.end.value = formatTime(seg.end);
    const length = outputDurationOf(seg, ed.project.cuts, ed.settings);
    const cutAway = seg.end - seg.start - length;
    row.dur.textContent = formatTime(Math.max(0, length), 1) + (cutAway > 0.005 ? ` (−${formatNumber(cutAway, 1)} s)` : '');
    row.dur.title = t('panel.length.tip');
    // With the times hidden, the length moves up next to the name.
    const showTimes = ed.settings.showSegmentTimes;
    row.timesLine.style.display = showTimes ? '' : 'none';
    const durLine = showTimes ? row.timesLine : row.titleLine;
    if (row.dur.parentElement !== durLine) durLine.append(row.dur);
    const options = ed.outputOptions(seg);
    row.setChoices(
      presetChoices(ed.settings.peakPresets, options.peakTarget, options.peakDefault),
      presetChoices(ed.settings.bitratePresets, options.bitrate, options.bitrateDefault),
    );
    for (const [v, b] of row.peak) b.classList.toggle('active', options.peakTarget === v);
    for (const [v, b] of row.bitrate) b.classList.toggle('active', options.bitrate === v);
    // Marked when the file differs from its folder, so overrides stand out.
    const source = (own: boolean, folderValue: string) => (own ? t('panel.option.own', { value: folderValue }) : t('panel.option.folder'));
    row.peakGroup.classList.toggle('override', seg.peakTarget !== undefined);
    row.peakGroup.title = `${t('panel.peak.tip')}. ${source(seg.peakTarget !== undefined, formatPeak(options.peakDefault))}`;
    row.bitrateGroup.classList.toggle('override', seg.bitrate !== undefined);
    row.bitrateGroup.title = `${t('panel.bitrate.tip')}. ${source(seg.bitrate !== undefined, `${options.bitrateDefault} kbps`)}`;
    this.fillFolder(row, seg);
    row.issues.replaceChildren(
      ...issues.errors.map((e) => h('div', { class: 'err' }, t(e.key, e.params))),
      ...issues.warnings.map((w) => h('div', { class: 'warn' }, t(w.key, w.params))),
    );
  }

  /**
   * The start of the name a naming rule generates, shown before the typed part. Without a rule
   * it is hidden, or offers to switch the rule back on for a file whose name was typed in full.
   */
  private fillPrefix(row: Row, seg: Segment, issues: SegmentIssues): void {
    const ed = this.editor;
    const { prefix, rule } = ed.fileName(seg);
    const ruleOff = !rule && seg.autoName === false && !!ruleFor(ed.settings.folderRules, segmentFolder(ed.project, seg));
    row.prefix.style.display = rule || ruleOff ? '' : 'none';
    row.prefix.textContent = rule ? `${prefix}${rule.types.length > 1 ? ' ▾' : ''}` : ruleOff ? t('panel.autoName') : '';
    row.prefix.title = rule ? t('panel.prefix.tip') : t('panel.autoName.tip');
    row.prefix.classList.toggle('invalid', issues.errors.some((e) => e.key === 'issue.noDate'));
    row.name.placeholder = rule ? t('panel.filenameRest') : t('panel.filename');
  }

  private showNameMenu(seg: Segment, x: number, y: number): void {
    const ed = this.editor;
    const rule = ed.namingRule(seg)!;
    const current = seg.type && rule.types.includes(seg.type) ? seg.type : rule.types[0];
    const siblings = ed.namingSiblings(seg);
    const setType = (targets: Segment[], type: string) => ed.commit(() => {
      for (const s of targets) s.type = type;
    });
    const items: ContextItem[] = rule.types.map((type) => ({ label: `${type === current ? '✓' : '\u2003'} ${type}`, run: () => setType([seg], type) }));
    if (rule.types.length > 1) {
      const after = siblings.slice(siblings.findIndex((s) => s.id === seg.id));
      items.push({ label: '', separator: true });
      for (const type of rule.types) items.push({ label: t('panel.type.following', { type }), run: () => setType(after, type) });
      for (const type of rule.types) items.push({ label: t('panel.type.all', { type }), run: () => setType(siblings, type) });
    }
    if (items.length) items.push({ label: '', separator: true });
    items.push({
      label: t('panel.typeWholeName'),
      run: () => {
        const name = ed.fileName(seg).name;
        ed.commit(() => {
          seg.filename = name;
          seg.autoName = false;
        });
      },
    });
    showContextMenu(x, y, items);
  }

  /** Moves this file and the ones after it (in time order) to one folder. */
  private showFolderMenu(seg: Segment, x: number, y: number): void {
    const ed = this.editor;
    const dirs = ed.project.outputDirs;
    const sorted = ed.sortedSegments();
    const after = sorted.slice(sorted.findIndex((s) => s.id === seg.id));
    const setFolder = (dir: string) => ed.commit(() => {
      for (const s of after) {
        if (dir === dirs[0]) delete s.outputDir;
        else s.outputDir = dir;
      }
    });
    showContextMenu(x, y, dirs.map((dir) => ({ label: t('panel.folder.following', { folder: folderName(dir) }), run: () => setFolder(dir) })));
  }

  /** Switches the naming rule back on, dropping the generated part if it was kept in the name. */
  private restoreAutoName(seg: Segment): void {
    const ed = this.editor;
    ed.commit(() => {
      delete seg.autoName;
      const { prefix } = ed.fileName(seg);
      if (prefix && seg.filename.startsWith(prefix)) seg.filename = seg.filename.slice(prefix.length);
    });
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
    const ed = this.editor;
    const dirs = ed.project.outputDirs;
    const key = [dirs.join('\n'), JSON.stringify(ed.project.numberStarts), ed.settings.folderRules.map((r) => `${r.folder}|${r.template}`).join('\n')].join('\0');
    if (key === this.foldersKey) return;
    this.foldersKey = key;
    const line = (i: number) => {
      const dir = dirs[i] ?? null;
      const path = h('div', { class: `folder-path${dir ? '' : ' missing'}`, title: dir ?? '' }, dir ? pathText(dir) : t('panel.noFolder'));
      return h('div', { class: 'folder-row' },
        dirs.length > 1 ? h('span', { class: 'folder-tag' }, i === 0 ? t('panel.default') : `${i + 1}`) : null,
        path,
        dir ? this.numberStartInput(dir) : null,
        h('button', { class: dirs.length > 1 ? 'icon' : '', html: icons.folder, title: i === 0 ? t('panel.folder.tip') : t('panel.extraFolder.tip'), onclick: () => this.actions.changeFolder(i) },
          dirs.length > 1 ? null : t('panel.folder')),
        dirs.length > 1
          ? h('button', {
            class: 'icon danger', html: icons.trash,
            title: i === 0 ? t('panel.removeDefaultFolder.tip') : t('panel.removeFolder.tip'),
            onclick: () => this.actions.removeFolder(i),
          })
          : null,
      );
    };
    this.foldersEl.replaceChildren(...(dirs.length ? dirs.map((_, i) => line(i)) : [line(0)]));
    if (dirs.length) {
      this.foldersEl.append(h('button', { class: 'folder-add', title: t('panel.addFolder.tip'), onclick: (e: MouseEvent) => this.actions.addFolder(e.currentTarget as HTMLElement) }, t('panel.addFolder')));
    }
  }

  /** First {nn} for a folder whose naming rule numbers the files; editable in case the guess is off. */
  private numberStartInput(dir: string): HTMLElement | null {
    const ed = this.editor;
    const rule = ruleFor(ed.settings.folderRules, dir);
    if (!rule || !usesToken(rule.template, 'nn')) return null;
    const value = ed.project.numberStarts[dir];
    const input = h('input', {
      type: 'number', min: '0', step: '1', value: value === undefined ? '' : String(value), placeholder: '…',
      onchange: () => {
        const v = Math.round(Number(input.value));
        if (input.value === '' || !Number.isFinite(v) || v < 0) {
          input.value = value === undefined ? '' : String(value);
          return;
        }
        ed.commit((p) => (p.numberStarts[dir] = v));
      },
    });
    return h('label', { class: 'folder-num', title: t('panel.numberFrom.tip') }, t('panel.numberFrom'), input);
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
