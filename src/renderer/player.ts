import type { Editor } from './editor.ts';

/** How far ahead the fade gain is ramped each frame; smooth without audible lag. */
const GAIN_RAMP_SEC = 0.05;

/**
 * Streams the source WAV through an <audio> element (range requests, so seeking is instant)
 * and keeps the editor's playhead in sync. Optionally jumps over cuts to preview the result,
 * and plays the selected segment's fades through a Web Audio gain node.
 */
export class Player {
  private readonly audio: HTMLAudioElement;
  private readonly editor: Editor;
  private stopAt: number | null = null;
  private raf = 0;
  private graph: { ctx: AudioContext; gain: GainNode } | null = null;
  private graphFailed = false;

  constructor(audio: HTMLAudioElement, editor: Editor) {
    this.audio = audio;
    this.editor = editor;
    // Web Audio only hears media it is allowed to read; media:// answers with CORS headers.
    audio.crossOrigin = 'anonymous';
    audio.addEventListener('ended', () => this.stopped());
    audio.addEventListener('pause', () => this.stopped());
    audio.addEventListener('error', () => this.stopped());
  }

  load(path: string): void {
    this.pause();
    this.audio.src = `media://local/${encodeURIComponent(path)}`;
    this.audio.load();
  }

  get playing(): boolean {
    return !this.audio.paused;
  }

  /** Plays from `from` (default: playhead). Stops at `until` when given. */
  async play(from = this.editor.playhead, until: number | null = null): Promise<void> {
    if (!this.editor.info) return;
    if (from >= this.editor.duration - 0.01) from = 0;
    this.stopAt = until;
    this.audio.currentTime = from;
    this.editor.setPlayhead(from);
    this.ensureGraph();
    void this.graph?.ctx.resume();
    this.applyGain(from, true);
    try {
      await this.audio.play();
    } catch {
      return;
    }
    this.editor.playing = true;
    this.editor.notify('ui');
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (!this.audio.paused) this.audio.pause();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  /** Moves playback (if running) and the playhead. */
  seek(t: number): void {
    this.editor.setPlayhead(t);
    if (this.playing) {
      this.stopAt = null;
      this.audio.currentTime = this.editor.playhead;
    }
  }

  private tick = () => {
    if (this.audio.paused) return;
    let t = this.audio.currentTime;

    if (this.editor.skipCuts) {
      const cut = this.editor.project.cuts.find((c) => t >= c.start && t < c.end - 0.01);
      if (cut) {
        this.audio.currentTime = cut.end;
        t = cut.end;
      }
    }
    if (this.stopAt !== null && t >= this.stopAt) {
      this.audio.pause();
      this.editor.setPlayhead(this.stopAt);
      return;
    }

    this.applyGain(t);
    this.editor.setPlayhead(t);
    // Page-follow: when the playhead leaves the view, flip to the next page.
    if (t > this.editor.viewEnd || t < this.editor.view.start) this.editor.ensureVisible(t);
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Created on the first play, which comes from a click or key press as autoplay rules require. */
  private ensureGraph(): void {
    if (this.graph || this.graphFailed) return;
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      ctx.createMediaElementSource(this.audio).connect(gain).connect(ctx.destination);
      this.graph = { ctx, gain };
    } catch {
      this.graphFailed = true;
    }
  }

  /** Follows the fade curve of the selected segment; `immediate` jumps instead of ramping. */
  private applyGain(t: number, immediate = false): void {
    const ed = this.editor;
    if (!this.graph) {
      // Fallback without Web Audio: coarser, but the fades are still audible.
      this.audio.volume = ed.previewGain(t);
      return;
    }
    const param = this.graph.gain.gain;
    const now = this.graph.ctx.currentTime;
    param.cancelScheduledValues(now);
    if (immediate) {
      param.setValueAtTime(ed.previewGain(t), now);
    } else {
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(ed.previewGain(t + GAIN_RAMP_SEC * this.audio.playbackRate), now + GAIN_RAMP_SEC);
    }
  }

  private stopped(): void {
    cancelAnimationFrame(this.raf);
    this.stopAt = null;
    if (this.editor.playing) {
      this.editor.playing = false;
      this.editor.notify('ui');
    }
  }
}
