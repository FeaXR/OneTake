import type {} from '../shared/api.ts';
import { resolveLanguage, setLanguage } from '../shared/i18n/index.ts';
import { App } from './app.ts';
import { applyTheme } from './theme.ts';

// The web build talks to the One Take server instead of Electron, the browser-only build does it all
// in the page (both are dropped from the desktop build).
if (import.meta.env.MODE === 'web') await import('../web/bridge.ts');
if (import.meta.env.MODE === 'browser') await import('../browser/bridge.ts');

// The language must be known before any UI text is created.
const settings = await window.studio.getSettings();
setLanguage(resolveLanguage(settings.language, navigator.language));
applyTheme(settings.theme, settings.accent);

const app = new App(settings);
await app.init();

// Handy from the dev tools console (F12) while developing.
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;
