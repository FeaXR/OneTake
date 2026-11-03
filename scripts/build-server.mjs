// Bundles the web build's server and peak worker with esbuild.
import * as esbuild from 'esbuild';
import { serverBuildOptions } from './esbuild-options.mjs';

await esbuild.build(serverBuildOptions);
