import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

// `--mode web` builds the page the One Take server hands to browsers (see src/server);
// `--mode browser` the page that does everything in the browser itself (see src/browser).
/**
 * The browser-only build compiles the MP3 encoder (WebAssembly) and may ask GitHub for the latest
 * version; nothing else leaves the page, which this policy makes sure of.
 */
const BROWSER_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self' https://api.github.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
].join('; ');

const browserPolicy = (): Plugin => ({
  name: 'one-take-browser-csp',
  transformIndexHtml: (html) => html.replace(/(http-equiv="Content-Security-Policy" content=")[^"]*/, `$1${BROWSER_CSP}`),
});

export default defineConfig(({ mode }) => {
  const browser = mode === 'web' || mode === 'browser';
  return {
    plugins: mode === 'browser' ? [browserPolicy()] : [],
    root: resolve(import.meta.dirname, 'src/renderer'),
    base: './',
    publicDir: mode === 'browser' ? resolve(import.meta.dirname, 'src/browser/public') : false,
    build: {
      outDir: resolve(import.meta.dirname, browser ? `dist/${mode}` : 'dist/renderer'),
      emptyOutDir: true,
      target: browser ? 'es2022' : 'chrome130',
    },
    ...(mode === 'browser' ? { worker: { format: 'es' as const } } : {}),
    server: {
      port: 5183,
      strictPort: true,
    },
  };
});
