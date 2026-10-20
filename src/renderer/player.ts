import { keptPieces } from '../shared/plan.ts';
import type { Change, Editor } from './editor.ts';

/** Frames per read. Chunks sit on a fixed grid of the file, so re-planning reuses what was read. */
const CHUNK_FRAMES = 16384;
/** How far ahead of the output audio is scheduled. */
const LOOKAHEAD_SEC = 1.5;
/** From pressing play to the first sample; covers reading the first chunk. */
const START_DELAY_SEC = 0.04;
const PUMP_MS = 50;
const CACHE_CHUNKS = 96;
/** The fade preview gain is evaluated every this many frames and interpolated in between. */
const GAIN_STEP = 64;
/** Edits while playing are applied after this pause, so a drag does not re-plan every frame. */
const REPLAN_DELAY_MS = 80;

/** A stretch of the file to play, in frames. */
interface Piece {
  start: number;
  end: number;
}

/** Where scheduling continues. */
interface Cursor {
  pieces: Piece[];
  index: number;
  frame: number;
  /** Context time the next frame plays at; null until the first chunk has been read. */
  time: number | null;
  /** The current piece was reached through a join, so it fades in. */
  joined: boolean;
  stopFrame: number;
  gain: ((t: number) => number) | null;
}

interface Scheduled {
  node: AudioBufferSourceNode;
  start: number;
  end: number;
  fromFrame: number;
  toFrame: number;
}

/**
 * Plays the open WAV through Web Audio, read in chunks from the main process and scheduled
 * back to back with sample accuracy. What is scheduled is what the export would produce:
 * cuts are skipped with the export's crossfade, and inside the selected segment its fade-in
 * and fade-out are applied. Keeps the editor's playhead in sync.
 */
export class Player {
  private readonly editor: Editor;
  private ctx: AudioContext | null = null;
  private active = false;
  private cursor: Cursor | null = null;
  private scheduled: Scheduled[] = [];
  /** Bumped whenever scheduling starts over; reads that finish for an old one are dropped. */
  private generation = 0;
  private pumpingGeneration = -1;
  private readonly cache = new Map<number, Promise<Float32Array[]>>();
  private stopAt: number | null = null;
  private startedFrom = 0;
  private skipCuts: boolean;
  private timer = 0;
  private raf = 0;
  private replanTimer = 0;

  constructor(editor: Editor) {
    this.editor = editor;
    this.skipCuts = editor.skipCuts;
    editor.subscribe((changes) => this.onChange(changes));
  }

  /** Call when a new file is opened. */
  load(): void {
    this.pause();
    this.cache.clear();
  }

  get playing(): boolean {
    return this.active;
  }

  /** Plays from `from` (default: playhead). Stops at `until` when given. */
  async play(from = this.editor.playhead, until: number | null = null): Promise<void> {
    const ed = this.editor;
    if (!ed.info) return;
    if (from >= ed.duration - 0.01) from = 0;
    this.halt();
    const ctx = this.context(ed.info.sampleRate);
    const generation = this.generation;
    await ctx.resume();
    if (generation !== this.generation) return;

    this.stopAt = until;
    this.startedFrom = from;
    ed.setPlayhead(from);
    this.cursor = this.plan(Math.round(from * ed.info.sampleRate), null);
    if (!this.cursor) return;
    this.active = true;
    ed.playing = true;
    ed.notify('ui');
    this.timer = window.setInterval(() => this.update(false), PUMP_MS);
    this.raf = requestAnimationFrame(this.frame);
    void this.pump();
  }

  pause(): void {
    if (!this.active) return;
    const t = this.position();
    this.halt();
    this.finish(t);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  /** Moves playback (if running) and the playhead. */
  seek(t: number): void {
    this.editor.setPlayhead(t);
    if (this.active) void this.play(this.editor.playhead);
  }

  // ---------- Scheduling ----------

  /** One context per sample rate, so chunks line up on its sample grid exactly. */
  private context(sampleRate: number): AudioContext {
    if (this.ctx?.sampleRate === sampleRate) return this.ctx;
    void this.ctx?.close();
    try {
      this.ctx = new AudioContext({ sampleRate });
    } catch {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  private crossfadeFrames(): number {
    return Math.round((this.editor.settings.cutCrossfadeMs / 1000) * this.editor.info!.sampleRate);
  }

  /** The stretches to play: the whole file, or the parts between cuts. */
  private pieces(): Piece[] {
    const ed = this.editor;
    const { sampleRate, frames } = ed.info!;
    const whole = { start: 0, end: ed.duration };
    const spans = ed.skipCuts ? keptPieces(whole, ed.project.cuts, ed.settings.cutCrossfadeMs / 1000) : [whole];
    return spans
      .map((p) => ({ start: Math.round(p.start * sampleRate), end: Math.min(frames, Math.round(p.end * sampleRate)) }))
      .filter((p) => p.end > p.start);
  }

  /**
   * Starts scheduling at `fromFrame`. `time` is where it continues in the context (null for a
   * fresh start); continuing across a skipped cut overlaps the join like the export does.
   */
  private plan(fromFrame: number, time: number | null): Cursor | null {
    const ed = this.editor;
    const pieces = this.pieces();
    const index = pieces.findIndex((p) => p.end > fromFrame);
    if (index < 0) return null;
    const frame = Math.max(fromFrame, pieces[index].start);
    const joined = time !== null && frame > fromFrame && index > 0;
    if (joined) time! -= this.crossfadeFrames() / ed.info!.sampleRate;
    const stopFrame = this.stopAt !== null ? Math.round(this.stopAt * ed.info!.sampleRate) : ed.info!.frames;
    return { pieces, index, frame, time, joined, stopFrame, gain: ed.previewGainCurve() };
  }

  private async pump(): Promise<void> {
    const generation = this.generation;
    const ctx = this.ctx;
    if (!ctx || this.pumpingGeneration === generation) return;
    this.pumpingGeneration = generation;
    try {
      while (generation === this.generation) {
        const c = this.cursor;
        if (!c || (c.time !== null && c.time > ctx.currentTime + LOOKAHEAD_SEC)) break;
        await this.scheduleNext(ctx, c, generation);
      }
    } catch (err) {
      reportError(err);
      this.pause();
    } finally {
      if (this.pumpingGeneration === generation) this.pumpingGeneration = -1;
    }
  }

  /** Schedules the next stretch of the current piece, up to the end of its chunk. */
  private async scheduleNext(ctx: AudioContext, c: Cursor, generation: number): Promise<void> {
    const rate = this.editor.info!.sampleRate;
    const piece = c.pieces[c.index];
    const chunkIndex = Math.floor(c.frame / CHUNK_FRAMES);
    const end = Math.min(piece.end, c.stopFrame, (chunkIndex + 1) * CHUNK_FRAMES);
    if (c.frame >= end) {
      this.cursor = null;
      return;
    }
    const data = await this.chunk(chunkIndex);
    if (generation !== this.generation) return;
    const offset = c.frame - chunkIndex * CHUNK_FRAMES;
    const count = Math.min(end - c.frame, (data[0]?.length ?? 0) - offset);
    if (count <= 0) {
      this.cursor = null;
      return;
    }

    const buffer = ctx.createBuffer(data.length, count, rate);
    const gain = this.gainFor(c, piece, count);
    data.forEach((channel, ch) => {
      const out = buffer.getChannelData(ch);
      out.set(channel.subarray(offset, offset + count));
      if (gain) for (let i = 0; i < count; i++) out[i] *= gain[i];
    });

    // Fell behind (a slow read): leave a gap rather than piling chunks on top of each other.
    if (c.time === null || c.time < ctx.currentTime + 0.005) {
      c.time = Math.ceil((ctx.currentTime + START_DELAY_SEC) * rate) / rate;
    }
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.start(c.time);
    this.scheduled.push({ node, start: c.time, end: c.time + count / rate, fromFrame: c.frame, toFrame: c.frame + count });

    c.frame += count;
    c.time += count / rate;
    if (c.frame < piece.end && c.frame < c.stopFrame) return;
    if (this.joinsNext(c)) {
      c.index++;
      c.frame = c.pieces[c.index].start;
      c.joined = true;
      c.time -= this.crossfadeFrames() / rate;
    } else {
      this.cursor = null;
    }
  }

  /** Playback continues from the current piece into the next one (across a cut). */
  private joinsNext(c: Cursor): boolean {
    const next = c.pieces[c.index + 1];
    return !!next && next.start < c.stopFrame;
  }

  /**
   * Per-frame gain for the next `count` frames: the export's linear crossfade at joins and the
   * previewed segment's fades. Null when it is 1 throughout.
   */
  private gainFor(c: Cursor, piece: Piece, count: number): Float32Array | null {
    const rate = this.editor.info!.sampleRate;
    const xf = this.crossfadeFrames();
    const first = c.frame;
    const last = c.frame + count;
    const fadeOutFrom = xf > 0 && this.joinsNext(c) ? piece.end - xf : Infinity;
    const fadeInTo = xf > 0 && c.joined ? piece.start + xf : -Infinity;
    if (!c.gain && last <= fadeOutFrom && first >= fadeInTo) return null;

    const g = new Float32Array(count).fill(1);
    if (c.gain) {
      let prev = c.gain(first / rate);
      for (let i = 0; i < count; i += GAIN_STEP) {
        const span = Math.min(GAIN_STEP, count - i);
        const next = c.gain((first + i + span) / rate);
        for (let j = 0; j < span; j++) g[i + j] = prev + ((next - prev) * j) / span;
        prev = next;
      }
    }
    for (let i = 0; i < count; i++) {
      const f = first + i;
      if (f >= fadeOutFrom) g[i] *= (piece.end - f) / xf;
      if (f < fadeInTo) g[i] *= (f - piece.start) / xf;
    }
    return g;
  }

  private chunk(index: number): Promise<Float32Array[]> {
    let data = this.cache.get(index);
    if (data) {
      // Keep recently used chunks at the end, so the oldest is evicted first.
      this.cache.delete(index);
    } else {
      data = window.studio.readAudio(index * CHUNK_FRAMES, CHUNK_FRAMES);
      data.catch(() => this.cache.delete(index));
    }
    this.cache.set(index, data);
    if (this.cache.size > CACHE_CHUNKS) this.cache.delete(this.cache.keys().next().value!);
    return data;
  }

  // ---------- Edits while playing ----------

  private onChange(changes: Set<Change>): void {
    const skipCutsChanged = this.skipCuts !== this.editor.skipCuts;
    this.skipCuts = this.editor.skipCuts;
    if (!this.active || this.replanTimer) return;
    if (skipCutsChanged || changes.has('project') || changes.has('selection') || changes.has('settings')) {
      this.replanTimer = window.setTimeout(() => {
        this.replanTimer = 0;
        this.replan();
      }, REPLAN_DELAY_MS);
    }
  }

  /** Drops what has not started yet and schedules again from there with the current edits. */
  private replan(): void {
    const ctx = this.ctx;
    if (!this.active || !ctx) return;
    const now = ctx.currentTime;
    const keep: Scheduled[] = [];
    for (const s of this.scheduled) {
      if (s.start > now + 0.02) this.stopNode(s.node);
      else keep.push(s);
    }
    this.scheduled = keep;
    this.generation++;
    const last = keep.reduce<Scheduled | null>((a, s) => (!a || s.end > a.end ? s : a), null);
    if (!last) {
      void this.play(this.position(), this.stopAt);
      return;
    }
    this.cursor = this.plan(last.toFrame, last.end);
    void this.pump();
  }

  // ---------- Playhead ----------

  /** Source time being heard now. */
  private position(): number {
    const ctx = this.ctx;
    const rate = this.editor.info?.sampleRate;
    if (!ctx || !rate || !this.scheduled.length) return this.startedFrom;
    const now = this.heardTime(ctx);
    // During a join both sides play; the earlier one is shown until it ends.
    const current = this.scheduled.find((s) => s.start <= now && now < s.end);
    if (current) return (current.fromFrame + (now - current.start) * rate) / rate;
    if (now < this.scheduled[0].start) return this.scheduled[0].fromFrame / rate;
    return this.scheduled.reduce((a, s) => (s.end > a.end ? s : a)).toFrame / rate;
  }

  /** Context time of the sample reaching the speakers. */
  private heardTime(ctx: AudioContext): number {
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  private frame = () => {
    this.update(true);
    if (this.active) this.raf = requestAnimationFrame(this.frame);
  };

  private update(visual: boolean): void {
    const ctx = this.ctx;
    if (!this.active || !ctx) return;
    void this.pump();
    const now = this.heardTime(ctx);
    this.scheduled = this.scheduled.filter((s) => s.end > now - 1);
    const lastEnd = this.scheduled.reduce((a, s) => Math.max(a, s.end), -Infinity);
    if (!this.cursor && now >= lastEnd) {
      const t = this.stopAt ?? this.position();
      this.halt();
      this.finish(t);
      return;
    }
    if (!visual) return;
    const t = this.position();
    this.editor.setPlayhead(t);
    // Page-follow: when the playhead leaves the view, flip to the next page.
    if (t > this.editor.viewEnd || t < this.editor.view.start) this.editor.ensureVisible(t);
  }

  /** Stops all audio and timers; the caller decides what the playhead shows. */
  private halt(): void {
    this.generation++;
    for (const s of this.scheduled) this.stopNode(s.node);
    this.scheduled = [];
    this.cursor = null;
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.replanTimer);
    this.replanTimer = 0;
  }

  private stopNode(node: AudioBufferSourceNode): void {
    try {
      node.stop();
    } catch {
      // Not started yet in some engines; disconnecting is enough.
    }
    node.disconnect();
  }

  private finish(playhead: number): void {
    this.active = false;
    this.stopAt = null;
    this.editor.setPlayhead(playhead);
    if (this.editor.playing) {
      this.editor.playing = false;
      this.editor.notify('ui');
    }
  }
}
