// Bundles the Electron main process, preload script and peak worker with esbuild.
import * as esbuild from 'esbuild';
import { mainBuildOptions } from './esbuild-options.mjs';

await esbuild.build(mainBuildOptions);
