// esbuild settings for the Electron main process, preload script and peak worker.
export const mainBuildOptions = {
  entryPoints: {
    main: 'src/main/main.ts',
    'peaks-worker': 'src/main/peaks-worker.ts',
    preload: 'src/preload/preload.ts',
  },
  outdir: 'dist/main',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron', 'ffmpeg-static'],
  logLevel: 'info',
};
