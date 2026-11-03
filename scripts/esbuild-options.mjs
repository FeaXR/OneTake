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

// esbuild settings for the web build's server (Docker), which reuses the main process modules.
export const serverBuildOptions = {
  ...mainBuildOptions,
  entryPoints: {
    server: 'src/server/server.ts',
    'peaks-worker': 'src/main/peaks-worker.ts',
  },
  outdir: 'dist/server',
  external: ['ffmpeg-static'],
};
