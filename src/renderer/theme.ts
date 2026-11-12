import type { ThemeSetting } from '../shared/types.ts';

/**
 * Colors the canvases draw with. They come from the CSS variables of the current theme
 * (styles.css), read again whenever the theme changes; these are the dark theme's.
 */
export const canvasColors = {
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
  live: '#ff4d4d',
  notRecorded: 'rgba(0, 0, 0, 0.28)',
  /** Outline of the selected segment or cut. */
  selected: '#ffffff',
  /** Text on a segment's colored bar, and on a cut's. */
  segmentText: '#0d0f12',
  cutText: '#1a0d0d',
  overviewBg: '#121418',
  overviewWave: '#5f6f86',
  overviewShade: 'rgba(0, 0, 0, 0.35)',
  overviewFrame: 'rgba(255, 255, 255, 0.7)',
};

/** The CSS variable each canvas color is read from: `--canvas-` plus the name in kebab case. */
const cssName = (key: string) => `--canvas-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

const systemLight = window.matchMedia('(prefers-color-scheme: light)');
let setting: ThemeSetting = 'system';
const listeners: (() => void)[] = [];

/** Shows the app in `theme`; 'system' follows the operating system, also when it changes later. */
export function applyTheme(theme: ThemeSetting): void {
  setting = theme;
  update();
}

/** Called after the theme in use changes (to redraw what the canvases show). */
export function onThemeChange(cb: () => void): void {
  listeners.push(cb);
}

function update(): void {
  const theme = setting === 'system' ? (systemLight.matches ? 'light' : 'dark') : setting;
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  root.dataset.theme = theme;
  const style = getComputedStyle(root);
  for (const key of Object.keys(canvasColors) as (keyof typeof canvasColors)[]) {
    const value = style.getPropertyValue(cssName(key)).trim();
    if (value) canvasColors[key] = value;
  }
  for (const cb of listeners) cb();
}

systemLight.addEventListener('change', update);
