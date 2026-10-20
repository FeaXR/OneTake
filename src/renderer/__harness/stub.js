// Temporary test harness: fake window.studio so the renderer runs in a plain browser.
const frames = 48000 * 600;
const buckets = Math.ceil(frames / 256);
const mins = new Int16Array(buckets), maxs = new Int16Array(buckets);
for (let i = 0; i < buckets; i++) { const v = Math.round(Math.abs(Math.sin(i / 500)) * 20000); mins[i] = -v; maxs[i] = v; }
const saved = {
  version: 1, cuts: [{ id: 'c1', start: 30, end: 32 }], outputDir: 'C:\\Music\\Out',
  segments: [
    { id: 's1', filename: 'One', start: 5, end: 120, peakTarget: 1, bitrate: 320 },
    { id: 's2', filename: 'Two', start: 130, end: 300, peakTarget: 0.6, bitrate: 192 },
  ],
};
window.__log = [];
window.addEventListener('error', (e) => window.__log.push('error: ' + e.message));
const origRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => origRaf((t) => { try { cb(t); } catch (e) { window.__log.push('raf: ' + e.message); throw e; } });
window.addEventListener('unhandledrejection', (e) => window.__log.push('rejection: ' + (e.reason?.stack || e.reason)));
const noop = () => () => {};
window.studio = {
  pickWav: async () => 'C:\\Music\\concert.wav',
  pathForDroppedFile: () => '',
  loadAudio: async (path) => {
    if (!location.search.includes('startup')) await new Promise((r) => setTimeout(r, 300));
    return { info: { path, sampleRate: 48000, channels: 2, bitsPerSample: 24, sampleFormat: 'int', frames, duration: frames / 48000 },
      peaks: { framesPerBucket: 256, mins, maxs }, project: structuredClone(saved) };
  },
  onLoadProgress: noop, takeStartupFile: async () => (location.search.includes('startup') ? 'C:\\Music\\concert.wav' : null), onOpenFile: noop,
  saveProject: async () => {}, getSettings: async () => ({ language: 'en', fadeInSec: 0.5, fadeInCurve: 'tri', fadeOutSec: 2, fadeOutCurve: 'exp', ceilingDb: 0, cutCrossfadeMs: 10, defaultBitrate: 320, defaultPeakTarget: 1 }),
  saveSettings: async () => {}, getShortcutOverrides: async () => ({}), saveShortcutOverrides: async () => {},
  pickFolder: async () => null, existingFiles: async () => [], showInFolder: async () => {},
  startExport: async () => ({ ok: true, cancelled: false, written: [] }), cancelExport: async () => {}, onExportProgress: noop,
  setDirty: () => {}, setTitle: () => {}, onSaveAndClose: noop, closeNow: () => {}, toggleDevTools: () => {},
};
