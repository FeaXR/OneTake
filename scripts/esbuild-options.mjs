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
  // Loaded from node_modules at run time (electron-builder packs the dependencies).
  external: ['electron', 'ffmpeg-static', 'electron-updater'],
  logLevel: 'info',
};
