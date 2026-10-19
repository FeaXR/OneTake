import type {} from '../shared/api.ts';
import { resolveLanguage, setLanguage } from '../shared/i18n/index.ts';
import { App } from './app.ts';

// The language must be known before any UI text is created.
const settings = await window.studio.getSettings();
setLanguage(resolveLanguage(settings.language, navigator.language));

const app = new App(settings);
await app.init();

// Handy from the dev tools console (F12) while developing.
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;
