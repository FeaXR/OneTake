import { t } from '../shared/i18n/index.ts';
import { h } from './dom.ts';

/** Bottom of the meter scale. */
const FLOOR_DB = -60;
/** How fast the bars fall back after a peak. */
const FALL_DB_PER_SEC = 24;
/** A sample this close to full scale counts as clipping (24-bit full scale is 1 − 2⁻²³). */
const CLIP_LEVEL = 0.999;

/**
 * Peak meter for the two recorded channels, with a clip light that stays on until clicked,
 * so a clip during a concert is still visible afterwards.
 */
export class Meter {
  readonly el: HTMLElement;
  private readonly covers: HTMLElement[];
  private readonly clip: HTMLElement;
  private shown = [FLOOR_DB, FLOOR_DB];
  private last = 0;

  constructor() {
    this.covers = [h('div', { class: 'meter-cover' }), h('div', { class: 'meter-cover' })];
    this.clip = h('button', { class: 'meter-clip', onclick: () => this.clearClip() }, t('meter.clip'));
    this.el = h('div', { class: 'meter', title: t('tb.meter.tip') },
      h('div', { class: 'meter-bars' }, ...this.covers.map((c) => h('div', { class: 'meter-bar' }, c))),
      this.clip,
    );
    this.reset();
  }

  /** Peaks (0..1) of the latest block, left and right. */
  update(peaks: readonly number[]): void {
    const now = performance.now();
    const fall = this.last ? ((now - this.last) / 1000) * FALL_DB_PER_SEC : Infinity;
    this.last = now;
    peaks.slice(0, 2).forEach((peak, c) => {
      const db = peak > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(peak)) : FLOOR_DB;
      this.shown[c] = Math.max(db, this.shown[c] - fall);
      const fraction = (this.shown[c] - FLOOR_DB) / -FLOOR_DB;
      this.covers[c].style.width = `${Math.round((1 - fraction) * 1000) / 10}%`;
      if (peak >= CLIP_LEVEL) this.clip.classList.add('on');
    });
  }

  clearClip(): void {
    this.clip.classList.remove('on');
  }

  reset(): void {
    this.shown = [FLOOR_DB, FLOOR_DB];
    this.last = 0;
    for (const c of this.covers) c.style.width = '100%';
    this.clearClip();
  }
}
