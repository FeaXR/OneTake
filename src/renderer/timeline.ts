import { formatNumber, t as tr } from '../shared/i18n/index.ts';
import { formatTime } from '../shared/time.ts';
import type { Cut, FadeMarkerStyle, Segment } from '../shared/types.ts';
import { clamp, MIN_REGION_SEC, type Editor, type RegionKind, type Selection } from './editor.ts';
import { decimalsFor, fadeGain, fitCanvas, tickStep, withAlpha } from './draw.ts';
import type { Player } from './player.ts';

const RULER_H = 26;
const LANE_ROW_H = 20;
const SEG_LANE_H = LANE_ROW_H * 2 + 4;
const CUT_LANE_H = 20;
const EDGE_PX = 6;
const SNAP_PX = 8;
const DRAG_THRESHOLD_PX = 3;
const FADE_MARKER_DASHES: Record<FadeMarkerStyle, number[]> = {
  dotted: [2, 4],
  dashed: [8, 5],
  dashdot: [10, 4, 2, 4],
};

const COLORS = {
  bg: '#14161a',
  laneBg: '#1a1d22',
  rulerBg: '#1e2126',
  rulerText: '#9aa1ad',
  rulerTick: '#4a505a',
  grid: 'rgba(255,255,255,0.04)',
  wave: '#8fa3bf',
  waveCenter: 'rgba(255,255,255,0.08)',
  cut: '#ef5b5b',
  playhead: '#ffd166',
  markIn: '#4cc38a',
  border: '#353a43',
};

type Area = 'ruler' | 'segLane' | 'wave' | 'cutLane';

type Hit =
  | { type: 'edge'; kind: RegionKind; id: string; edge: 'start' | 'end' }
  | { type: 'body'; kind: RegionKind; id: string; area: Area }
  | { type: 'empty'; area: Area };

type Drag =
  | { mode: 'edge'; kind: RegionKind; id: string; edge: 'start' | 'end' }
  | { mode: 'move'; kind: RegionKind; id: string; grabOffset: number; length: number }
  | { mode: 'create'; kind: RegionKind; id: string | null; anchor: number; startX: number }
  | { mode: 'pan'; startX: number; startView: number; moved: boolean; hit: Hit }
  | { mode: 'scrub' };

export interface ContextItem {
  label: string;
  key?: string;
  run?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

export interface TimelineHost {
  showContextMenu(x: number, y: number, items: ContextItem[]): void;
  focusSegmentName(id: string): void;
  shortcut(commandId: string): string;
  run(commandId: string): void;
}

/** The main editing canvas: ruler, segment lanes, waveform and cut lane. */
export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly editor: Editor;
  private readonly player: Player;
  private readonly host: TimelineHost;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private drag: Drag | null = null;
  private lastPointer = { x: 0, y: 0, alt: false };
  private autoScrollTimer = 0;
  private readonly envelope = { min: 0, max: 0 };

  constructor(canvas: HTMLCanvasElement, editor: Editor, player: Player, host: TimelineHost) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.editor = editor;
    this.player = player;
    this.host = host;

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', () => this.endDrag());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    editor.subscribe(() => this.draw());
  }

  private resize(): void {
    const { w, h, dpr } = fitCanvas(this.canvas);
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.editor.setViewWidth(w);
    this.draw();
  }

  // ---------- Geometry ----------

  private get waveTop(): number {
    return RULER_H + SEG_LANE_H;
  }
  private get waveBottom(): number {
    return this.h - CUT_LANE_H;
  }

  private areaAt(y: number): Area {
    if (y < RULER_H) return 'ruler';
    if (y < this.waveTop) return 'segLane';
    if (y < this.waveBottom) return 'wave';
    return 'cutLane';
  }

  /** Lane row (0 or 1) per segment so slightly overlapping segments stay grabbable. */
  private segmentRows(): Map<string, number> {
    const rows = new Map<string, number>();
    const rowEnd = [-Infinity, -Infinity];
    for (const s of this.editor.sortedSegments()) {
      const row = rowEnd[0] <= s.start + 1e-9 ? 0 : rowEnd[1] <= s.start + 1e-9 ? 1 : rowEnd[0] <= rowEnd[1] ? 0 : 1;
      rows.set(s.id, row);
      rowEnd[row] = s.end;
    }
    return rows;
  }

  private rowTop(row: number): number {
    return RULER_H + 2 + row * LANE_ROW_H;
  }

  private hitTest(x: number, y: number): Hit {
    const ed = this.editor;
    const area = this.areaAt(y);
    if (area === 'ruler') return { type: 'empty', area };
    const t = ed.xToTime(x);
    const rows = this.segmentRows();

    let segs: Segment[] = [];
    let cuts: Cut[] = [];
    if (area === 'segLane') {
      const row = clamp(Math.floor((y - RULER_H - 2) / LANE_ROW_H), 0, 1);
      segs = ed.project.segments.filter((s) => rows.get(s.id) === row);
    } else if (area === 'cutLane') {
      cuts = ed.project.cuts;
    } else {
      segs = ed.project.segments;
      cuts = ed.project.cuts;
    }

    // Nearest edge within reach; the selected region wins ties.
    let best: { hit: Hit; dist: number } | null = null;
    const consider = (kind: RegionKind, r: Segment | Cut) => {
      for (const edge of ['start', 'end'] as const) {
        const dist = Math.abs(ed.timeToX(r[edge]) - x);
        const selected = ed.selection?.id === r.id;
        const score = dist - (selected ? 0.5 : 0);
        if (dist <= EDGE_PX && (!best || score < best.dist)) best = { hit: { type: 'edge', kind, id: r.id, edge }, dist: score };
      }
    };
    cuts.forEach((c) => consider('cut', c));
    segs.forEach((s) => consider('segment', s));
    if (best) return (best as { hit: Hit }).hit;

    const cut = cuts.find((c) => t >= c.start && t <= c.end);
    if (cut) return { type: 'body', kind: 'cut', id: cut.id, area };
    const under = segs.filter((s) => t >= s.start && t <= s.end);
    if (under.length) {
      const pick = under.find((s) => s.id === ed.selection?.id) ?? under.sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      return { type: 'body', kind: 'segment', id: pick.id, area };
    }
    return { type: 'empty', area };
  }

  /** Snaps a time to the playhead, pending marks or other region edges within SNAP_PX. */
  private snap(t: number, excludeId: string | null): number {
    if (this.lastPointer.alt) return t;
    const ed = this.editor;
    const candidates: number[] = [ed.playhead];
    if (ed.markIn !== null) candidates.push(ed.markIn);
    if (ed.cutMark !== null) candidates.push(ed.cutMark);
    for (const r of [...ed.project.segments, ...ed.project.cuts]) {
      if (r.id === excludeId) continue;
      candidates.push(r.start, r.end);
    }
    let best = t;
    let bestDist = SNAP_PX * ed.view.secPerPx;
    for (const c of candidates) {
      const d = Math.abs(c - t);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  }

  private listFor(kind: RegionKind): (Segment | Cut)[] {
    return kind === 'segment' ? this.editor.project.segments : this.editor.project.cuts;
  }

  // ---------- Pointer handling ----------

  private pointerPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown(e: PointerEvent): void {
    const ed = this.editor;
    if (!ed.info) return;
    const { x, y } = this.pointerPos(e);
    this.lastPointer = { x, y, alt: e.altKey };

    if (e.button === 1) {
      e.preventDefault();
      this.startDrag(e, { mode: 'pan', startX: x, startView: ed.view.start, moved: true, hit: { type: 'empty', area: 'wave' } });
      return;
    }
    if (e.button !== 0) return;

    const hit = this.hitTest(x, y);
    const t = ed.xToTime(x);

    if (hit.type === 'empty' && hit.area === 'ruler') {
      this.player.seek(t);
      this.startDrag(e, { mode: 'scrub' });
      return;
    }
    if (hit.type === 'edge') {
      ed.select({ kind: hit.kind, id: hit.id });
      ed.beginGesture();
      this.startDrag(e, { mode: 'edge', kind: hit.kind, id: hit.id, edge: hit.edge });
      return;
    }
    if (hit.type === 'body' && hit.area !== 'wave') {
      const r = this.listFor(hit.kind).find((r) => r.id === hit.id)!;
      ed.select({ kind: hit.kind, id: hit.id });
      ed.beginGesture();
      this.startDrag(e, { mode: 'move', kind: hit.kind, id: hit.id, grabOffset: t - r.start, length: r.end - r.start });
      return;
    }

    // Empty lanes always create their own kind; the waveform follows the active tool.
    const createKind: RegionKind | null =
      hit.area === 'segLane' ? 'segment' : hit.area === 'cutLane' ? 'cut' : ed.tool === 'select' ? null : ed.tool;
    if (createKind && hit.type === 'empty') {
      this.startDrag(e, { mode: 'create', kind: createKind, id: null, anchor: this.snap(t, null), startX: x });
      return;
    }
    if (createKind && hit.type === 'body' && hit.area === 'wave') {
      // Creating inside an existing region is allowed (e.g. a cut inside a segment).
      this.startDrag(e, { mode: 'create', kind: createKind, id: null, anchor: this.snap(t, null), startX: x });
      return;
    }
    this.startDrag(e, { mode: 'pan', startX: x, startView: ed.view.start, moved: false, hit });
  }

  private startDrag(e: PointerEvent, drag: Drag): void {
    this.drag = drag;
    this.canvas.setPointerCapture(e.pointerId);
    clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = window.setInterval(() => this.autoScroll(), 30);
  }

  private onPointerMove(e: PointerEvent): void {
    const { x, y } = this.pointerPos(e);
    this.lastPointer = { x, y, alt: e.altKey };
    if (this.drag) this.applyDrag();
    else this.updateCursor(x, y);
  }

  private applyDrag(): void {
    const drag = this.drag;
    const ed = this.editor;
    if (!drag) return;
    const x = this.lastPointer.x;
    const t = clamp(ed.xToTime(x), 0, ed.duration);

    switch (drag.mode) {
      case 'scrub':
        this.player.seek(t);
        break;
      case 'pan':
        if (!drag.moved && Math.abs(x - drag.startX) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        ed.scrollTo(drag.startView - (x - drag.startX) * ed.view.secPerPx);
        break;
      case 'edge':
        ed.live(() => {
          const r = this.listFor(drag.kind).find((r) => r.id === drag.id);
          if (!r) return;
          const v = this.snap(t, r.id);
          if (drag.edge === 'start') r.start = clamp(v, 0, r.end - MIN_REGION_SEC);
          else r.end = clamp(v, r.start + MIN_REGION_SEC, ed.duration);
        });
        break;
      case 'move':
        ed.live(() => {
          const r = this.listFor(drag.kind).find((r) => r.id === drag.id);
          if (!r) return;
          let start = t - drag.grabOffset;
          const snappedStart = this.snap(start, r.id);
          const snappedEnd = this.snap(start + drag.length, r.id);
          if (snappedStart !== start) start = snappedStart;
          else if (snappedEnd !== start + drag.length) start = snappedEnd - drag.length;
          r.start = clamp(start, 0, ed.duration - drag.length);
          r.end = r.start + drag.length;
        });
        break;
      case 'create': {
        if (drag.id === null) {
          if (Math.abs(x - drag.startX) < DRAG_THRESHOLD_PX) return;
          ed.beginGesture();
          const region = drag.kind === 'segment' ? ed.newSegment(drag.anchor, drag.anchor) : ed.newCut(drag.anchor, drag.anchor);
          drag.id = region.id;
          ed.live((p) => (drag.kind === 'segment' ? p.segments.push(region as Segment) : p.cuts.push(region)));
          ed.select({ kind: drag.kind, id: region.id });
        }
        const v = this.snap(t, drag.id);
        ed.live(() => {
          const r = this.listFor(drag.kind).find((r) => r.id === drag.id);
          if (!r) return;
          r.start = Math.min(drag.anchor, v);
          r.end = Math.max(drag.anchor, v);
        });
        break;
      }
    }
  }

  /** While dragging past the left/right edge, keep scrolling. */
  private autoScroll(): void {
    if (!this.drag || this.drag.mode === 'pan') return;
    const x = this.lastPointer.x;
    const over = x < 0 ? x : x > this.w ? x - this.w : 0;
    if (over === 0) return;
    this.editor.scrollBy(clamp(over, -60, 60) * 0.6);
    this.applyDrag();
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    const ed = this.editor;
    if (!drag) return;
    const { x } = this.pointerPos(e);
    const t = clamp(ed.xToTime(x), 0, ed.duration);

    if (drag.mode === 'create') {
      if (drag.id === null) {
        // A click without dragging just moves the playhead.
        this.player.seek(t);
      } else {
        const r = this.listFor(drag.kind).find((r) => r.id === drag.id);
        if (r && r.end - r.start < MIN_REGION_SEC) {
          ed.live((p) => {
            if (drag.kind === 'segment') p.segments = p.segments.filter((s) => s.id !== drag.id);
            else p.cuts = p.cuts.filter((c) => c.id !== drag.id);
          });
          ed.select(null);
        }
        ed.endGesture();
        if (r && drag.kind === 'segment' && ed.selection?.id === r.id) this.host.focusSegmentName(r.id);
      }
    } else if (drag.mode === 'pan' && !drag.moved && e.button === 0) {
      // Plain click on the waveform: move the playhead and select what is under it.
      this.player.seek(t);
      ed.select(drag.hit.type === 'body' ? { kind: drag.hit.kind, id: drag.hit.id } : null);
    }
    this.endDrag();
    this.updateCursor(x, this.pointerPos(e).y);
  }

  private endDrag(): void {
    clearInterval(this.autoScrollTimer);
    if (this.drag && (this.drag.mode === 'edge' || this.drag.mode === 'move' || this.drag.mode === 'create')) {
      this.editor.endGesture();
    }
    this.drag = null;
  }

  private updateCursor(x: number, y: number): void {
    if (!this.editor.info) {
      this.canvas.style.cursor = 'default';
      return;
    }
    const hit = this.hitTest(x, y);
    let cursor = 'default';
    if (hit.type === 'edge') cursor = 'ew-resize';
    else if (hit.type === 'body' && hit.area !== 'wave') cursor = 'grab';
    else if (hit.type === 'empty' && hit.area === 'ruler') cursor = 'pointer';
    else if (hit.type === 'empty' && (hit.area === 'segLane' || hit.area === 'cutLane')) cursor = 'crosshair';
    else if (hit.area === 'wave' && this.editor.tool !== 'select') cursor = 'crosshair';
    this.canvas.style.cursor = cursor;
  }

  private onWheel(e: WheelEvent): void {
    if (!this.editor.info) return;
    e.preventDefault();
    const { x } = this.pointerPos(e);
    const scale = e.deltaMode === 1 ? 40 : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      this.editor.scrollBy(e.shiftKey ? dy || dx : dx);
    } else {
      this.editor.zoomAt(Math.exp(-dy * 0.002), x);
    }
  }

  private onDoubleClick(e: MouseEvent): void {
    const { x, y } = this.pointerPos(e);
    const hit = this.hitTest(x, y);
    if (hit.type === 'body' && hit.kind === 'segment') this.host.focusSegmentName(hit.id);
    else if (hit.type === 'body') {
      const r = this.editor.region({ kind: hit.kind, id: hit.id });
      if (r) this.editor.zoomToRange(r.start, r.end);
    }
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const ed = this.editor;
    if (!ed.info) return;
    const { x, y } = this.pointerPos(e);
    const t = clamp(ed.xToTime(x), 0, ed.duration);
    const hit = this.hitTest(x, y);
    const key = (id: string) => this.host.shortcut(id);
    const items: ContextItem[] = [];

    if (hit.type === 'body' || hit.type === 'edge') {
      const sel: Selection = { kind: hit.kind, id: hit.id };
      const r = ed.region(sel)!;
      ed.select(sel);
      items.push(
        { label: hit.kind === 'segment' ? tr('ctx.playSegment') : tr('ctx.playAroundCut'), key: key('play.selection'), run: () => this.host.run('play.selection') },
        { label: tr('ctx.zoomTo'), key: key('zoom.selection'), run: () => ed.zoomToRange(r.start, r.end) },
        { separator: true, label: '' },
        { label: tr('ctx.playheadToStart'), key: key('playhead.selectionStart'), run: () => this.player.seek(r.start) },
        { label: tr('ctx.playheadToEnd'), key: key('playhead.selectionEnd'), run: () => this.player.seek(r.end) },
        { separator: true, label: '' },
        { label: tr('ctx.setStart'), run: () => this.setEdgeAt(sel, 'start', ed.playhead) },
        { label: tr('ctx.setEnd'), run: () => this.setEdgeAt(sel, 'end', ed.playhead) },
        { separator: true, label: '' },
      );
      if (hit.kind === 'segment') {
        items.push({ label: tr('ctx.rename'), run: () => this.host.focusSegmentName(hit.id) });
        items.push({ label: tr('ctx.toCut'), run: () => this.convert(sel) });
      } else {
        items.push({ label: tr('ctx.toSegment'), run: () => this.convert(sel) });
      }
      items.push({ label: tr('ctx.delete'), key: key('edit.delete'), run: () => this.host.run('edit.delete') });
    } else {
      const span = Math.max(1, 80 * ed.view.secPerPx);
      items.push(
        { label: tr('ctx.playheadHere'), run: () => this.player.seek(t) },
        { label: tr('ctx.playFromHere'), run: () => void this.player.play(t) },
        {
          label: tr('ctx.segmentStart'),
          key: key('playhead.segmentStart'),
          run: () => this.host.run('playhead.segmentStart'),
        },
        {
          label: tr('ctx.segmentEnd'),
          key: key('playhead.segmentEnd'),
          run: () => this.host.run('playhead.segmentEnd'),
        },
        { separator: true, label: '' },
        {
          label: tr('ctx.newSegment'),
          run: () => {
            const s = ed.newSegment(t, Math.min(ed.duration, t + span * 4));
            ed.commit((p) => p.segments.push(s));
            ed.select({ kind: 'segment', id: s.id });
            this.host.focusSegmentName(s.id);
          },
        },
        {
          label: tr('ctx.newCut'),
          run: () => {
            const c = ed.newCut(t, Math.min(ed.duration, t + span));
            ed.commit((p) => p.cuts.push(c));
            ed.select({ kind: 'cut', id: c.id });
          },
        },
        { separator: true, label: '' },
        { label: tr('ctx.zoomFit'), key: key('zoom.fit'), run: () => ed.zoomToFit() },
      );
    }
    this.host.showContextMenu(e.clientX, e.clientY, items);
  }

  private setEdgeAt(sel: Selection, edge: 'start' | 'end', t: number): void {
    const ed = this.editor;
    ed.commit(() => {
      const r = ed.region(sel);
      if (!r) return;
      if (edge === 'start') r.start = clamp(t, 0, r.end - MIN_REGION_SEC);
      else r.end = clamp(t, r.start + MIN_REGION_SEC, ed.duration);
    });
  }

  private convert(sel: Selection): void {
    const ed = this.editor;
    const r = ed.region(sel);
    if (!r) return;
    if (sel.kind === 'segment') {
      const c = ed.newCut(r.start, r.end);
      ed.commit((p) => {
        p.segments = p.segments.filter((s) => s.id !== r.id);
        p.cuts.push(c);
      });
      ed.select({ kind: 'cut', id: c.id });
    } else {
      const s = ed.newSegment(r.start, r.end);
      ed.commit((p) => {
        p.cuts = p.cuts.filter((c) => c.id !== r.id);
        p.segments.push(s);
      });
      ed.select({ kind: 'segment', id: s.id });
      this.host.focusSegmentName(s.id);
    }
  }

  // ---------- Drawing ----------

  draw(): void {
    const { ctx, w, h, dpr } = this;
    const ed = this.editor;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    if (!ed.info || !ed.peaks) return;

    const waveTop = this.waveTop;
    const waveBottom = this.waveBottom;
    const mid = (waveTop + waveBottom) / 2;
    const half = (waveBottom - waveTop) / 2 - 4;

    // Lane backgrounds.
    ctx.fillStyle = COLORS.laneBg;
    ctx.fillRect(0, RULER_H, w, SEG_LANE_H);
    ctx.fillRect(0, waveBottom, w, CUT_LANE_H);

    // Segment tint behind the waveform.
    for (const s of ed.project.segments) {
      const x0 = ed.timeToX(s.start);
      const x1 = ed.timeToX(s.end);
      if (x1 < 0 || x0 > w) continue;
      const selected = ed.selection?.id === s.id;
      ctx.fillStyle = withAlpha(ed.segmentColor(s.id), selected ? 0.16 : 0.08);
      ctx.fillRect(x0, waveTop, x1 - x0, waveBottom - waveTop);
    }

    this.drawGrid(waveTop, waveBottom);

    // Center line and waveform, one column per device pixel.
    ctx.fillStyle = COLORS.waveCenter;
    ctx.fillRect(0, mid, w, 1);
    ctx.fillStyle = COLORS.wave;
    const sr = ed.info.sampleRate;
    const step = 1 / dpr;
    const env = this.envelope;
    for (let px = 0; px < w; px += step) {
      const f0 = ed.xToTime(px) * sr;
      const f1 = ed.xToTime(px + step) * sr;
      if (f1 < 0 || f0 >= ed.info.frames) continue;
      if (!ed.peaks.range(Math.max(0, f0), f1, env)) continue;
      const yTop = mid - env.max * half;
      const yBot = mid - env.min * half;
      ctx.fillRect(px, yTop, step, Math.max(step, yBot - yTop));
    }

    this.drawFades(mid, half);
    this.drawCuts(waveTop, waveBottom);
    this.drawSegmentBars();
    this.drawRuler();
    this.drawMarkers(waveTop, waveBottom);

    // Lane separators.
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(0, waveTop - 1, w, 1);
    ctx.fillRect(0, waveBottom, w, 1);
  }

  private drawGrid(top: number, bottom: number): void {
    const { ctx } = this;
    const ed = this.editor;
    const step = tickStep(ed.view.secPerPx);
    ctx.fillStyle = COLORS.grid;
    for (let t = Math.ceil(ed.view.start / step) * step; t <= ed.viewEnd; t += step) {
      ctx.fillRect(Math.round(ed.timeToX(t)), top, 1, bottom - top);
    }
  }

  private drawRuler(): void {
    const { ctx, w } = this;
    const ed = this.editor;
    ctx.fillStyle = COLORS.rulerBg;
    ctx.fillRect(0, 0, w, RULER_H);
    const step = tickStep(ed.view.secPerPx);
    const minor = step / 5;
    const decimals = decimalsFor(step);
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';

    const first = Math.floor(ed.view.start / minor) * minor;
    for (let i = 0; ; i++) {
      const t = first + i * minor;
      if (t > ed.viewEnd) break;
      const x = Math.round(ed.timeToX(t));
      const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.fillStyle = COLORS.rulerTick;
      ctx.fillRect(x, isMajor ? RULER_H - 10 : RULER_H - 5, 1, isMajor ? 10 : 5);
      if (isMajor) {
        ctx.fillStyle = COLORS.rulerText;
        ctx.fillText(formatTime(t, decimals), x + 4, 4);
      }
    }
    ctx.fillStyle = COLORS.border;
    ctx.fillRect(0, RULER_H - 1, w, 1);
  }

  private drawSegmentBars(): void {
    const { ctx, w } = this;
    const ed = this.editor;
    const rows = this.segmentRows();
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';

    for (const s of ed.sortedSegments()) {
      const x0 = ed.timeToX(s.start);
      const x1 = ed.timeToX(s.end);
      if (x1 < 0 || x0 > w) continue;
      const y = this.rowTop(rows.get(s.id) ?? 0);
      const color = ed.segmentColor(s.id);
      const selected = ed.selection?.id === s.id;

      ctx.fillStyle = withAlpha(color, selected ? 0.85 : 0.55);
      roundRect(ctx, x0, y + 1, Math.max(2, x1 - x0), LANE_ROW_H - 2, 4);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      const label = `#${ed.segmentNumber(s.id)}  ${s.filename.trim() || tr('tl.unnamed')}`;
      const textX = Math.max(x0, 0) + 6;
      const maxW = x1 - textX - 4;
      if (maxW > 12) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(textX, y, maxW, LANE_ROW_H);
        ctx.clip();
        ctx.fillStyle = '#0d0f12';
        ctx.fillText(label, textX, y + LANE_ROW_H / 2 + 1);
        ctx.restore();
      }

      // Edge lines down through the waveform make boundaries easy to see and grab.
      ctx.fillStyle = withAlpha(color, selected ? 0.95 : 0.6);
      ctx.fillRect(Math.round(x0), y, 1.5, this.waveBottom - y);
      ctx.fillRect(Math.round(x1) - 1, y, 1.5, this.waveBottom - y);
    }
  }

  private drawFades(mid: number, half: number): void {
    const { ctx, w } = this;
    const ed = this.editor;
    const { fadeInSec, fadeOutSec, fadeInCurve, fadeOutCurve, fadeMarkerStyle } = ed.settings;
    const dash = FADE_MARKER_DASHES[fadeMarkerStyle] ?? FADE_MARKER_DASHES.dashed;
    ctx.lineWidth = 1.25;

    for (const s of ed.project.segments) {
      const color = withAlpha(ed.segmentColor(s.id), 0.9);
      const curve = (from: number, to: number, gain: (x: number) => number, markAt: number) => {
        const x0 = ed.timeToX(from);
        const x1 = ed.timeToX(to);
        if (x1 < 0 || x0 > w || x1 - x0 < 2) return;
        // Vertical line where the fade meets full volume.
        const xm = Math.round(ed.timeToX(markAt)) + 0.5;
        ctx.save();
        ctx.setLineDash(dash);
        ctx.strokeStyle = withAlpha(ed.segmentColor(s.id), 0.85);
        ctx.beginPath();
        ctx.moveTo(xm, mid - half);
        ctx.lineTo(xm, mid + half);
        ctx.stroke();
        ctx.restore();
        for (const sign of [-1, 1]) {
          ctx.beginPath();
          const steps = Math.min(64, Math.ceil(x1 - x0));
          for (let i = 0; i <= steps; i++) {
            const x = x0 + ((x1 - x0) * i) / steps;
            const y = mid + sign * gain(i / steps) * half;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = color;
          ctx.stroke();
        }
      };
      const len = s.end - s.start;
      const fadeInEnd = s.start + Math.min(fadeInSec, len);
      const fadeOutStart = s.end - Math.min(fadeOutSec, len);
      curve(s.start, fadeInEnd, (x) => fadeGain(fadeInCurve, x), fadeInEnd);
      curve(fadeOutStart, s.end, (x) => fadeGain(fadeOutCurve, 1 - x), fadeOutStart);
    }
  }

  private drawCuts(top: number, bottom: number): void {
    const { ctx, w } = this;
    const ed = this.editor;
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (const c of ed.project.cuts) {
      const x0 = ed.timeToX(c.start);
      const x1 = ed.timeToX(c.end);
      if (x1 < 0 || x0 > w) continue;
      const selected = ed.selection?.id === c.id;
      const width = Math.max(2, x1 - x0);

      ctx.fillStyle = withAlpha(COLORS.cut, selected ? 0.42 : 0.28);
      ctx.fillRect(x0, top, width, bottom - top);
      // Hatching so cuts read as "removed" even over quiet audio.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, top, width, bottom - top);
      ctx.clip();
      ctx.strokeStyle = withAlpha(COLORS.cut, 0.35);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0 - (bottom - top); x < x1; x += 10) {
        ctx.moveTo(x, bottom);
        ctx.lineTo(x + (bottom - top), top);
      }
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = withAlpha(COLORS.cut, selected ? 0.95 : 0.7);
      roundRect(ctx, x0, bottom + 2, width, CUT_LANE_H - 4, 3);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillRect(Math.round(x0), top, 1.5, bottom - top);
      ctx.fillRect(Math.round(x1) - 1, top, 1.5, bottom - top);
      const label = tr('tl.cutLabel', { sec: formatNumber(c.end - c.start, 2) });
      if (width > ctx.measureText(label).width + 10) {
        ctx.fillStyle = '#1a0d0d';
        ctx.fillText(label, x0 + 5, bottom + CUT_LANE_H / 2);
      }
    }
  }

  private drawMarkers(top: number, bottom: number): void {
    const { ctx } = this;
    const ed = this.editor;
    const dashed = (t: number, color: string, label: string) => {
      const x = Math.round(ed.timeToX(t)) + 0.5;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = color;
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.fillText(label, x + 3, top + 8);
    };
    if (ed.markIn !== null) dashed(ed.markIn, COLORS.markIn, tr('tl.markIn'));
    if (ed.cutMark !== null) dashed(ed.cutMark, COLORS.cut, tr('tl.markCut'));

    const x = Math.round(ed.timeToX(ed.playhead));
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(x, 0, 1.5, this.h);
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 7.5, 0);
    ctx.lineTo(x + 0.75, 9);
    ctx.closePath();
    ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}
