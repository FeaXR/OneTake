import { app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { UpdateState } from '../shared/types.ts';
import { compareVersions } from '../shared/version.ts';

const REPO = 'FeaXR/OneTake';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/**
 * How this copy can be updated. The Windows installer and an AppImage update themselves;
 * the portable .exe, the .deb (a system package) and the Mac app (not signed with an Apple
 * certificate) can only be told that a new version exists. Not at all when run from source.
 */
function updateMode(): 'self' | 'notify' | null {
  if (!app.isPackaged) return null;
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_DIR ? 'notify' : 'self';
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'self' : 'notify';
  return 'notify';
}

/**
 * Checks GitHub for a newer release. Self-updating copies download it in the background; it is
 * installed when the user restarts from the notice, or when the app is closed.
 */
export class Updater {
  state: UpdateState = { status: 'idle' };
  private readonly mode = updateMode();
  private readonly onState: (state: UpdateState) => void;
  /** A downloaded AppImage, put in place of the running one on restart or quit. */
  private pendingAppImage: string | null = null;
  private checking: Promise<UpdateState> | null = null;

  constructor(onState: (state: UpdateState) => void) {
    this.onState = onState;
    if (this.mode !== 'self') return;
    autoUpdater.logger = null;
    autoUpdater.autoDownload = true;
    // The AppImage is replaced here instead (see installAppImage), so that it keeps its name.
    autoUpdater.autoInstallOnAppQuit = process.platform === 'win32';
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => {
      if (this.state.status === 'downloading') this.set({ ...this.state, percent: Math.floor(p.percent) });
    });
    autoUpdater.on('update-downloaded', (e) => {
      if (process.platform === 'linux') this.pendingAppImage = e.downloadedFile;
      this.set({ status: 'ready', version: e.version });
    });
    autoUpdater.on('error', (err) => {
      if (this.state.status !== 'ready') this.set({ status: 'error', message: err.message });
    });
    app.on('will-quit', () => {
      if (this.pendingAppImage) this.installAppImage();
    });
  }

  /** Looks for a newer version; a check already running or a finished download is reused. */
  check(): Promise<UpdateState> {
    if (!this.mode) return Promise.resolve(this.set({ status: 'unsupported' }));
    if (this.state.status === 'downloading' || this.state.status === 'ready') return Promise.resolve(this.state);
    this.checking ??= (async () => {
      this.set({ status: 'checking' });
      try {
        if (this.mode === 'self') {
          const result = await autoUpdater.checkForUpdates();
          const latest = result?.updateInfo.version;
          // A newer version is now downloading (the events above say so); otherwise there is none.
          if (this.state.status === 'checking') {
            this.set(latest && compareVersions(latest, app.getVersion()) > 0
              ? { status: 'downloading', version: latest, percent: 0 }
              : { status: 'none' });
          }
        } else {
          const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OneTake' },
          });
          if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
          const latest = String((await res.json() as { tag_name?: string }).tag_name ?? '').replace(/^v/i, '');
          this.set(latest && compareVersions(latest, app.getVersion()) > 0 ? { status: 'available', version: latest } : { status: 'none' });
        }
      } catch (err) {
        this.set({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      return this.state;
    })().finally(() => (this.checking = null));
    return this.checking;
  }

  /** Restarts into the downloaded version. The caller makes sure nothing unsaved is lost. */
  install(): void {
    if (this.state.status !== 'ready') return;
    if (process.platform === 'win32') {
      autoUpdater.quitAndInstall(true, true);
      return;
    }
    const appImage = process.env.APPIMAGE!;
    if (!this.installAppImage()) return;
    restartAppImage(appImage);
    app.quit();
  }

  openDownloadPage(): void {
    void shell.openExternal(RELEASES_PAGE);
  }

  /**
   * Puts the downloaded AppImage in place of the running one, under the same name, so menu
   * entries made by AppImage managers keep working. Returns false (and reports why) on failure,
   * for example when the AppImage sits in a folder the user cannot write to.
   */
  private installAppImage(): boolean {
    const source = this.pendingAppImage;
    const target = process.env.APPIMAGE;
    if (!source || !target) return false;
    const temp = join(dirname(target), `.${basename(target)}.update`);
    try {
      copyFileSync(source, temp);
      chmodSync(temp, 0o755);
      renameSync(temp, target);
      this.pendingAppImage = null;
      return true;
    } catch (err) {
      rmSync(temp, { force: true });
      this.pendingAppImage = null;
      this.set({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private set(state: UpdateState): UpdateState {
    this.state = state;
    this.onState(state);
    return state;
  }
}

/**
 * Starts the AppImage again once this instance has quit. app.relaunch() cannot do it: its helper
 * runs from the AppImage's mount, which disappears as soon as this process exits.
 */
function restartAppImage(file: string): void {
  const env = { ...process.env };
  const mount = env.APPDIR;
  // The new AppImage sets these up for its own mount; the old mount's entries would only dangle.
  for (const key of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete env[key];
  if (mount) {
    for (const key of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
      const kept = env[key]?.split(':').filter((p) => p && !p.startsWith(mount));
      if (kept?.length) env[key] = kept.join(':');
      else delete env[key];
    }
  }
  // The new instance must find the single-instance lock free; the pause lets this one finish quitting.
  app.releaseSingleInstanceLock();
  spawn('/bin/sh', ['-c', 'sleep 1; exec "$0"', file], { detached: true, stdio: 'ignore', env }).unref();
}
