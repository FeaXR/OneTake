import type { AccentPreset, AccentSetting, ThemeSetting } from '../shared/types.ts';

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

/** Each preset accent color as used on the dark theme and on the light one (darker, to stand out on white). */
export const ACCENT_COLORS: Record<AccentPreset, { dark: string; light: string }> = {
  blue: { dark: '#4f9cf7', light: '#2b78d8' },
  teal: { dark: '#2ec4b6', light: '#13877d' },
  green: { dark: '#4cc38a', light: '#23905d' },
  purple: { dark: '#a27cf5', light: '#7548d4' },
  pink: { dark: '#f06292', light: '#c7356b' },
  orange: { dark: '#f2a541', light: '#c06a10' },
  red: { dark: '#ef6b6b', light: '#c93c3c' },
};

/** The color an accent setting stands for in a theme; a color of the user's own is the same in both. */
export function accentColor(accent: AccentSetting, theme: 'dark' | 'light'): string {
  return accent.startsWith('#') ? accent : ACCENT_COLORS[accent as AccentPreset][theme];
}

/** Dark text on light accent colors and white on dark ones, for buttons filled with the accent. */
export function textOn(hex: string): string {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return luminance > 0.4 ? '#0d0f12' : '#ffffff';
}

const systemLight = window.matchMedia('(prefers-color-scheme: light)');
let setting: ThemeSetting = 'system';
let accent: AccentSetting = 'blue';
const listeners: (() => void)[] = [];

/** The theme in use: the setting, or the operating system's for 'system'. */
export function currentTheme(): 'dark' | 'light' {
  return setting === 'system' ? (systemLight.matches ? 'light' : 'dark') : setting;
}

/**
 * Shows the app in `theme` with the `accentSetting` color; 'system' follows the operating
 * system, also when it changes later.
 */
export function applyTheme(theme: ThemeSetting, accentSetting: AccentSetting = accent): void {
  setting = theme;
  accent = accentSetting;
  update();
}

/** Called after the theme in use changes (to redraw what the canvases show). */
export function onThemeChange(cb: () => void): void {
  listeners.push(cb);
}

function update(): void {
  const theme = currentTheme();
  const root = document.documentElement;
  const color = accentColor(accent, theme);
  root.style.setProperty('--accent', color);
  root.style.setProperty('--on-accent', textOn(color));
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
