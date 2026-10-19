// Dev runner: builds the main process, starts the Vite dev server and launches Electron.
// Renderer changes hot-reload; main/preload changes need the app to be restarted.
import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';
import { mainBuildOptions } from './esbuild-options.mjs';

await esbuild.build(mainBuildOptions);

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`Renderer dev server: ${url}`);

const app = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
