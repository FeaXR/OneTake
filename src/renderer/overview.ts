import type { Change, Editor } from './editor.ts';
import { fitCanvas, withAlpha } from './draw.ts';

/** Whole-file strip above the timeline. Click or drag to move the view; wheel to zoom. */
export class Overview {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly editor: Editor;
  private waveCache: HTMLCanvasElement | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private dragOffset: number | null = null;

  constructor(canvas: HTMLCanvasElement, editor: Editor) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.editor = editor;
    new ResizeObserver(() => this.resize()).observe(canvas);
    editor.subscribe((changes) => this.onChange(changes));

    canvas.addEventListener('pointerdown', (e) => {
      if (!editor.info || e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      const t = this.xToTime(this.localX(e));
      const span = editor.viewEnd - editor.view.start;
      // Grabbing inside the view rectangle keeps the grab point; outside, centre on the click.
      this.dragOffset = t >= editor.view.start && t <= editor.viewEnd ? t - editor.view.start : span / 2;
      editor.scrollTo(t - this.dragOffset);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragOffset === null) return;
      editor.scrollTo(this.xToTime(this.localX(e)) - this.dragOffset);
    });
    canvas.addEventListener('pointerup', () => (this.dragOffset = null));
    canvas.addEventListener('wheel', (e) => {
      if (!editor.info) return;
      e.preventDefault();
      const t = this.xToTime(this.localX(e));
      editor.zoomAt(Math.exp(-e.deltaY * 0.002), editor.timeToX(t));
    }, { passive: false });
  }

  private localX(e: MouseEvent): number {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  /** Time across the strip: the file, or while recording also the empty view ahead of the live point. */
  private span(): number {
    const ed = this.editor;
    return ed.recording ? Math.max(ed.duration, ed.viewEnd) : ed.duration;
  }

  private xToTime(x: number): number {
    return (x / this.w) * this.span();
  }

  private timeToX(t: number): number {
    return (t / (this.span() || 1)) * this.w;
  }

  private resize(): void {
    const { w, h, dpr } = fitCanvas(this.canvas);
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.waveCache = null;
    this.draw();
  }

  private onChange(changes: Set<Change>): void {
    if (changes.has('audio') || changes.has('length') || (this.editor.recording && changes.has('view'))) this.waveCache = null;
    this.draw();
  }

  /** The waveform only changes with the file, so it is rendered once into an offscreen canvas. */
  private renderWave(): HTMLCanvasElement {
    const ed = this.editor;
    const c = document.createElement('canvas');
    c.width = Math.round(this.w * this.dpr);
    c.height = Math.round(this.h * this.dpr);
    const ctx = c.getContext('2d')!;
    if (!ed.info || !ed.peaks) return c;
    const mid = c.height / 2;
    const half = c.height / 2 - 2;
    const framesPerPx = (this.span() * ed.info.sampleRate) / c.width;
    const env = { min: 0, max: 0 };
    ctx.fillStyle = '#5f6f86';
    for (let x = 0; x < c.width; x++) {
      if (x * framesPerPx >= ed.info.frames) break;
      if (!ed.peaks.range(x * framesPerPx, (x + 1) * framesPerPx, env)) continue;
      const top = mid - env.max * half;
      ctx.fillRect(x, top, 1, Math.max(1, mid - env.min * half - top));
    }
    return c;
  }

  draw(): void {
    const { ctx, w, h, dpr } = this;
    const ed = this.editor;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#121418';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // Not measured yet (a file opened before the first layout); resize() draws again.
    if (!ed.info || !w || !h) return;

    this.waveCache ??= this.renderWave();
    ctx.drawImage(this.waveCache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    for (const s of ed.project.segments) {
      const x0 = this.timeToX(s.start);
      const x1 = this.timeToX(s.end);
      ctx.fillStyle = withAlpha(ed.segmentColor(s.id), ed.selection?.id === s.id ? 0.35 : 0.18);
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.fillStyle = ed.segmentColor(s.id);
      ctx.fillRect(x0, h - 5, Math.max(1, x1 - x0 - 1), 5);
    }
    ctx.fillStyle = 'rgba(239, 91, 91, 0.8)';
    for (const c of ed.project.cuts) {
      const x0 = this.timeToX(c.start);
      ctx.fillRect(x0, 0, Math.max(1, this.timeToX(c.end) - x0), 6);
    }

    // Visible window.
    const vx0 = this.timeToX(ed.view.start);
    const vx1 = this.timeToX(ed.viewEnd);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, vx0, h);
    ctx.fillRect(vx1, 0, w - vx1, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vx0 + 0.5, 0.5, Math.max(2, vx1 - vx0 - 1), h - 1);

    ctx.fillStyle = '#ffd166';
    ctx.fillRect(this.timeToX(ed.playhead), 0, 1.5, h);
  }
}
