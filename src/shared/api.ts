import type { AudioInfo, ExportProgress, ExportRequest, ExportResult, LoadedAudio, Project, Settings, UpdateState } from './types.ts';

/** The bridge the preload script exposes to the renderer as `window.studio`. */
export interface StudioApi {
  pickWav(): Promise<string | null>;
  pathForDroppedFile(file: File): string;
  loadAudio(path: string): Promise<LoadedAudio>;
  onLoadProgress(cb: (fraction: number) => void): () => void;
  /** Samples of the open WAV for playback: one array per channel, from frame `start`. */
  readAudio(start: number, count: number): Promise<Float32Array[]>;
  /** Asks for access to audio inputs where the system requires it (macOS); false when refused. */
  allowMicrophone(): Promise<boolean>;
  /**
   * Creates `name` in `dir` (never overwriting) and opens it as a 24-bit WAV that grows as
   * samples are appended. Playback and export read it like any open WAV meanwhile.
   */
  startRecording(dir: string, name: string, sampleRate: number, channels: number): Promise<AudioInfo>;
  /** Appends one array per channel; resolves to the frames on disk, the live end of the file. */
  appendRecording(planes: Float32Array[]): Promise<number>;
  /** Finishes the file (final header, peaks cached); null when nothing was recording. */
  stopRecording(): Promise<AudioInfo | null>;
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
  /** Names in a folder; empty when it does not exist. */
  listFiles(dir: string): Promise<string[]>;
  /** Names of the folders in a folder; empty when it does not exist. */
  listFolders(dir: string): Promise<string[]>;
  showInFolder(path: string): Promise<void>;

  startExport(req: ExportRequest): Promise<ExportResult>;
  cancelExport(): Promise<void>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;

  appVersion(): Promise<string>;
  getUpdateState(): Promise<UpdateState>;
  /** Looks for a newer version on GitHub now (also done at startup when enabled). */
  checkForUpdates(): Promise<UpdateState>;
  onUpdateState(cb: (state: UpdateState) => void): () => void;
  /** Restarts into a downloaded update; the state says why when it could not. */
  installUpdate(): Promise<UpdateState>;
  openDownloadPage(): Promise<void>;

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
