import type {} from '../shared/api.ts';
import { App } from './app.ts';

const app = new App();
void app.init();

// Handy from the dev tools console (F12) while developing.
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;
