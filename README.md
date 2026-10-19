# Studio Audio Editor

[![Build](https://github.com/FeaXR/Studio-Audio-Editor/actions/workflows/build.yml/badge.svg)](https://github.com/FeaXR/Studio-Audio-Editor/actions/workflows/build.yml)

A small Windows editor for cutting **one long WAV into several MP3 files**. Each output gets the same linear fade-in and exponential fade-out, its own peak normalization (100% or 60%) and bitrate (320 or 192 kbps), and any number of cuts (coughs and the like) removed with a short crossfade.

Built with Electron + TypeScript. Audio processing and MP3 encoding use a bundled ffmpeg.

## Using it

1. **Open** a WAV file: use the button or Ctrl+O, drag it onto the window, or drop it onto the program's .exe or shortcut to start the app with that file. Dropping a file onto the icon while the app is running opens it in the existing window. Long files are fine: the waveform overview is computed once (a few seconds for 90 minutes) and cached.
2. **Mark output files (segments)**
   - Mouse: drag in the **top lane** (above the waveform), or pick the **Segment** tool and drag on the waveform.
   - Keyboard, while listening: press **I** at the start, **O** at the end.
3. **Name each file** in the list on the right, and set **100% / 60%** and **320 / 192** per file.
4. **Mark cuts**
   - Mouse: drag in the **bottom lane**, or use the **Cut** tool on the waveform.
   - Keyboard: press **X** at the start of the cough and **X** again at the end.
   - Cuts apply to every segment they fall in, so a cough in an overlap is removed from both files.
5. **Export all** (Ctrl+E). The app checks that every file has a valid, unique Windows filename and asks once before overwriting existing files.

Segments and cuts are saved next to the WAV as `<file>.wav.sae.json` (Ctrl+S). They are also saved after a successful export, and are loaded again when you reopen the WAV.

### Mouse

| Action | How |
| --- | --- |
| Move the playhead | Click the ruler or the waveform |
| Resize a segment or cut | Drag its edge (snaps to the playhead and other edges; hold **Alt** to stop snapping) |
| Move a segment or cut | Drag its bar in the top or bottom lane |
| Zoom | Mouse wheel (over the waveform or the overview) |
| Scroll | Shift + wheel, middle-drag, drag the overview, or drag the waveform with the Select tool |
| More options | Right-click a segment, a cut, or empty space |
| Rename a segment | Double-click it |

### Keyboard

To change them, open **Settings** (the gear icon) and go to **Keyboard shortcuts**. Click **+** next to a command and press the keys you want. Click a key to remove it, use **↺** to restore one command's default, or **Reset all**. A key can belong to only one command, so assigning it moves it and tells you where it was taken from. Changes apply when you click Save. These are the defaults:

| Key | Action |
| --- | --- |
| Space | Play / pause |
| P | Play the selected segment (or the audio around the selected cut) |
| I / O | Mark segment start / end at the playhead |
| Shift+I / Shift+O | Move the selected segment's start / end to the playhead |
| X | Mark cut start, then cut end |
| Alt+← / Alt+→ | Nudge the selected start by 10 ms (add Shift for the end) |
| ← / → | Playhead ±1 s (add Shift for ±10 s) |
| Ctrl+← / Ctrl+→ | Playhead to the previous / next segment or cut edge |
| Home / End | Playhead to the start / end of the file |
| Shift+Home / Shift+End | Playhead to the start / end of the selection |
| Ctrl+Home / Ctrl+End | Playhead to the start / end of the segment it is inside (also in the right-click menu) |
| C | Scroll so the playhead is centered |
| Page Up / Page Down | Scroll one screen left / right |
| ↑ / ↓, Tab / Shift+Tab | Previous / next segment |
| + / − / F / Z | Zoom in / out / whole file / selection |
| 1 / 2 / 3 | Select / Segment / Cut tool (Segment is active at startup) |
| K | Skip cuts while playing (on by default, so you hear the result) |
| Delete | Delete the selection |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S / Ctrl+E / Ctrl+O | Save / export / open |

## Settings

- **Language**: English or Magyar (Hungarian). The default, "Same as Windows", follows the Windows display language. Switching reloads the window; the open file and any unsaved edits are kept, but the undo history starts fresh.
- **Fade-in / fade-out**: length and curve. The defaults are 0.5 s linear in and 2 s exponential out. Set these to match what you used in GoldWave.
- **"100%" peak level**: 0 dBFS by default. MP3 encoding can overshoot by a fraction of a dB, so −0.3 to −1 dBFS is safer if you want to avoid clipping.
- **Crossfade at cuts**: 10 ms by default.
- **Defaults for new segments**: peak target and bitrate.

## How export works

Each output is rendered on its own from the untouched WAV, in two ffmpeg passes:

1. Trim the segment, remove the cuts and join the pieces with short crossfades, apply the fades, then **measure the peak** of that finished audio.
2. Run the same chain again with the gain that brings the peak to the target, and encode to MP3 (CBR).

Files are written as `.part` first and renamed when complete, so a cancelled export never leaves a broken MP3 behind.

## Development

Requires Node.js 22+.

```bash
npm install
npm run dev        # Vite dev server + Electron (renderer hot-reloads)
npm test           # unit tests + an ffmpeg export test
npm run typecheck
npm run dist       # Windows installer + portable .exe in release/
npm run icon       # re-render build/icon.png and build/icon.ico from build/icon.svg
```

### Automatic builds

[GitHub Actions](https://github.com/FeaXR/Studio-Audio-Editor/actions/workflows/build.yml) builds the app on Windows for every push and pull request ([`.github/workflows/build.yml`](.github/workflows/build.yml)). Each run type-checks, runs the tests, and builds the installer and the portable .exe.

- **Download a build:** open a run and download the **studio-audio-editor-windows** artifact at the bottom of the page. It's a zip containing both .exe files and is kept for 90 days.
- **Make a release:** push a version tag, and the two files are attached to a GitHub release:

  ```bash
  git tag v0.2.0
  ```

  ```bash
  git push origin v0.2.0
  ```

  Bump `version` in `package.json` first so the file names match.

Layout:

- `src/main/`: Electron main process (WAV header parsing, peak scan worker and cache, ffmpeg export, the `media://` protocol used for playback)
- `src/preload/`: the IPC bridge (`window.studio`)
- `src/renderer/`: UI (canvas timeline and overview, output list, commands and shortcuts)
- `src/shared/`: types, time formatting, cut/segment planning and filename validation
- `src/shared/i18n/`: translations. `en.ts` is the master list of texts; to add a language, copy `hu.ts`, translate it, and register it in `index.ts` (the type checker reports any missing text, and a test checks the placeholders)
