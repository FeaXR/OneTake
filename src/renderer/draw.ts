import type { FadeCurve } from '../shared/types.ts';

/** Sets the canvas backing store to the element size times devicePixelRatio. Returns CSS size. */
export function fitCanvas(canvas: HTMLCanvasElement): { w: number; h: number; dpr: number } {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  return { w, h, dpr };
}

/** Gain (0..1) of a fade-in at position x (0..1), approximating ffmpeg's afade curves for display. */
export function fadeGain(curve: FadeCurve, x: number): number {
  const t = Math.min(1, Math.max(0, x));
  switch (curve) {
    case 'tri': return t;
    case 'exp': return t === 0 ? 0 : Math.exp(-11.512925464970227 * (1 - t));
    case 'log': return t === 0 ? 0 : Math.max(0, Math.min(1, 1 + 0.2 * Math.log10(t)));
    case 'qsin': return Math.sin((t * Math.PI) / 2);
    case 'hsin': return (1 - Math.cos(t * Math.PI)) / 2;
    // As ffmpeg's afade computes it (reaches exactly 1, so a fade ends without a step).
    case 'esin': return 1 - Math.cos((Math.PI / 4) * ((2 * t - 1) ** 3 + 1));
    case 'cub': return t * t * t;
    case 'squ': return Math.sqrt(t);
  }
}

const TICK_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

/** Picks a ruler step so labels are at least `minPx` apart. */
export function tickStep(secPerPx: number, minPx = 90): number {
  return TICK_STEPS.find((s) => s / secPerPx >= minPx) ?? 3600;
}

export function decimalsFor(step: number): number {
  if (step < 0.01) return 3;
  if (step < 0.1) return 2;
  if (step < 1) return 1;
  return 0;
}

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
