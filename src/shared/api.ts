import type { ExportProgress, ExportRequest, ExportResult, LoadedAudio, Project, Settings } from './types.ts';

/** The bridge the preload script exposes to the renderer as `window.studio`. */
export interface StudioApi {
  pickWav(): Promise<string | null>;
  pathForDroppedFile(file: File): string;
  loadAudio(path: string): Promise<LoadedAudio>;
  onLoadProgress(cb: (fraction: number) => void): () => void;
  /** Samples of the open WAV for playback: one array per channel, from frame `start`. */
  readAudio(start: number, count: number): Promise<Float32Array[]>;
  /** WAV the app was launched with (file dropped on the .exe), or null. Returns it only once. */
  takeStartupFile(): Promise<string | null>;
  /** A WAV dropped on the icon while the app is already running. */
  onOpenFile(cb: (path: string) => void): () => void;

  saveProject(wavPath: string, project: Project): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getShortcutOverrides(): Promise<Record<string, string[]>>;
  /** Saves the key bindings that differ from the defaults. */
  saveShortcutOverrides(overrides: Record<string, string[]>): Promise<void>;

  pickFolder(defaultPath: string | null): Promise<string | null>;
  existingFiles(dir: string, names: string[]): Promise<string[]>;
  showInFolder(path: string): Promise<void>;

  startExport(req: ExportRequest): Promise<ExportResult>;
  cancelExport(): Promise<void>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;

  setDirty(dirty: boolean): void;
  setTitle(title: string): void;
  onSaveAndClose(cb: () => void): () => void;
  closeNow(): void;
  toggleDevTools(): void;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}
