import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// `--mode web` builds the page the One Take server hands to browsers (see src/server).
export default defineConfig(({ mode }) => ({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, mode === 'web' ? 'dist/web' : 'dist/renderer'),
    emptyOutDir: true,
    target: mode === 'web' ? 'es2022' : 'chrome130',
  },
  server: {
    port: 5183,
    strictPort: true,
  },
}));
