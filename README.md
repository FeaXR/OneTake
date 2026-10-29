<h1><img src="build/icon.png" alt="" width="40" align="top"> One Take</h1>

[![Build](https://github.com/FeaXR/OneTake/actions/workflows/build.yml/badge.svg)](https://github.com/FeaXR/OneTake/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A focused desktop editor for cutting **one long WAV recording into several MP3 files**, for Windows, macOS and Linux. It can also record that WAV itself, and you can start marking and exporting while the recording goes on.

Most audio editors work the other way round: many tracks in, one file out. One Take is for the opposite job: a long recording of a concert, a radio show or a lecture that has to become a set of separate, finished files. You mark where each file starts and ends, cut out coughs and noises, and export them all in one go. Each file gets consistent fades and its own loudness and bitrate.

![One Take with a 25-minute recording split into five output files](docs/screenshots/main.png)

## Features

- **One input, many outputs.** Mark any number of output files (segments) on a single WAV. Segments may slightly overlap.
- **Cuts.** Remove coughs, clicks or chatter. A cut applies to every segment it falls in, and the audio either side is joined with a short crossfade.
- **Consistent fades.** The same fade-in and fade-out on every file: linear in and exponential out by default, with other curves available.
- **Per-file peak normalization** to 100% or 60%, and **per-file bitrate** of 320 or 192 kbps (MP3, constant bitrate). Folders can have their own defaults, and any file can still differ.
- **Several output folders.** Files go to the session's default folder, or to any other folder you add for them.
- **Folder rules for names.** A rule can fill in the repetitive start of each filename: the next free number in the folder, the order within the recording, the date from the WAV's name, or a per-file type such as SH / HSZ. You type only the rest.
- **Record and edit at the same time.** Record from an audio interface (such as a Focusrite Scarlett) into a new 24-bit WAV, and mark, play and export finished pieces while the recording goes on.
- **Built for long files.** A 90-minute 24-bit recording opens in about 3 seconds and stays smooth while zooming and scrolling. The waveform overview is cached, so reopening is instant.
- **Mouse or keyboard.** Every action works with the mouse, and every action can also have a shortcut. Mark files with I/O and cuts with X while listening, and rebind any key in Settings.
- **Hear the result.** Playback skips the cuts by default, joining them with the same crossfade as the export, and inside the selected segment it plays that file's fade-in and fade-out too. Two buttons on each file play just its start or its end, to check the fades quickly.
- **Safe export.** Filenames are checked before anything is written, you're asked before files are overwritten, and a cancelled export never leaves half-written files.
- **Sessions are saved** in one place (Documents → One Take), so you can come back later and re-export.
- **English and Hungarian** interface.

| Fades at a track boundary | A cut, ready to be removed |
| --- | --- |
| ![Zoomed in on the end of one segment and the start of the next, with the fade-out and fade-in curves drawn over the waveform](docs/screenshots/fades.png) | ![Zoomed in on a short cut, shown as a red hatched region](docs/screenshots/cut.png) |

| Exporting | Settings |
| --- | --- |
| ![Export window showing per-file progress, measured peak and applied gain](docs/screenshots/export.png) | ![Settings with language, fades, export options and the keyboard shortcut editor](docs/screenshots/settings.png) |

<details>
<summary>Hungarian interface</summary>

![The same session with the interface in Hungarian](docs/screenshots/main-hu.png)

</details>

## Download

Get the latest version from the [Releases page](https://github.com/FeaXR/OneTake/releases).

| System | File | Notes |
| --- | --- | --- |
| Windows | `One-Take-Setup-<version>.exe` | Installer with Start menu entry and uninstaller |
| Windows | `One-Take-<version>-portable.exe` | Single file, no installation. Starts a little slower because it unpacks itself each time. |
| macOS | `One-Take-<version>-mac-arm64.dmg` | For Macs with Apple silicon (M1 and later). Open it and drag One Take into Applications. |
| Linux | `One-Take-<version>-x86_64.AppImage` | Runs on most distributions. Make it executable first: `chmod +x One-Take-*.AppImage` |
| Linux | `one-take_<version>_amd64.deb` | For Debian, Ubuntu and derivatives |

The builds are not code-signed. On Windows, SmartScreen may show "Windows protected your PC" the first time; choose **More info → Run anyway**. On a Mac, the first start is refused with "One Take is damaged" or "cannot be verified". After dragging it into Applications, run this once in Terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/One Take.app"
```

On a Mac, use **Cmd** wherever this page says Ctrl, and **Option** for Alt. Shortcuts are shown with the Mac symbols in the app.

### Updates

The app looks for a new version on GitHub when it starts (switch this off in **Settings → Updates**, where **Check now** also is). The Windows installer version and the AppImage download it in the background; the status bar then offers **restart to update**, and otherwise it is installed when you close the app. It never restarts during a recording or an export, and asks about unsaved changes first. The AppImage keeps its file name, so launchers made by AppImage managers keep working. The portable .exe, the .deb and the Mac version show a link to the download page instead.

Builds of every commit are also available from the [Actions page](https://github.com/FeaXR/OneTake/actions/workflows/build.yml). Open a run and download the artifact at the bottom (requires a GitHub account).

## Using it

1. **Open a WAV file** (or [record one](#recording)). Use the Open button or Ctrl+O, or drag the file onto the window. You can also drop it onto the program's icon or shortcut (on a Mac, the Dock icon) to start the app with that file.
2. **Mark the output files (segments).**
   - Mouse: drag in the **top lane** above the waveform, or drag on the waveform with the **Segment** tool (active at startup).
   - Keyboard, while listening: press **I** at the start and **O** at the end.
3. **Name each file** in the list on the right, and choose **100% / 60%** and **320 / 192** for each one. Names have no spaces: while you type one, **Space** still plays and pauses, so you can name a file right after marking it and keep listening.
   - **Settings → Folder rules** can set the volume and bitrate for everything written to a folder (and its subfolders). Each file follows its folder unless you pick something else for it; overridden choices are outlined, and picking the folder's value again makes the file follow the folder.
   - With a naming rule for the output folder, the start of each name is filled in for you: `{nn}` is the next free number in the folder, `{n}` the order within the recording, `{date}` comes from the WAV name (`1018_….wav` → `261018`), and `{type}` is a per-file choice such as SH / HSZ. Rules also apply to subfolders. Click the generated part to change the type, for one file, it and the ones after it, or the whole folder.
4. **Mark cuts.**
   - Mouse: drag in the **bottom lane**, or use the **Cut** tool.
   - Keyboard: press **X** where the noise starts and **X** again where it ends.
5. **Export all** with Ctrl+E. Files go to the folder shown at the top of the list, which defaults to the WAV's folder. To send some files elsewhere, use **+ Add folder**: each file then gets a folder picker, and the first folder stays the default.

Your segments and cuts are saved in `Documents/One Take/Sessions`, one file per WAV (Ctrl+S). The session is tied to the WAV's location, so moving or renaming the WAV starts a new one. Sessions saved next to the WAV by older versions (`<file>.wav.sae.json`) still open. They're also saved after every successful export, and they load again when you reopen the WAV.

### Recording

Press **Record** in the toolbar (Ctrl+R) to record a new WAV instead of opening one.

![Recording in progress: two pieces already marked and named, the red live point at 1:30, the input meter and the Stop button in the toolbar](docs/screenshots/recording.png)

- The dialog opens the input straight away, so you can check the level before starting. A Scarlett is chosen by default (afterwards, the input you used last). Inputs 1 and 2 are recorded as 24-bit stereo at the interface's sample rate; nothing is played back on the speakers while recording.
- Choose the folder and the file name. The name starts with today's date (`1025_…`), so folder rules can fill in `{date}`.
- While it records, the timeline grows to the red **live point**. Mark, cut and play as with any file: playback stops when it reaches the live point. The view follows the live point while it is on screen (toggle with **L** or the arrow button next to the meter).
- **Export all** writes the files whose end is already recorded; files that reach past the live point are marked *Still recording* and left for a later export.
- The meter shows both inputs; **CLIP** lights up when an input reaches full scale and stays lit until you click it.
- **Stop** asks first, then finishes the WAV. The computer is kept from going to sleep while recording, and the WAV's header is updated every second, so a crash or power cut loses at most the last second.

### Mouse

| Action | How |
| --- | --- |
| Move the playhead | Click the ruler or the waveform |
| Resize a segment or cut | Drag its edge (it snaps to the playhead and other edges; hold **Alt** to stop snapping) |
| Move a segment or cut | Drag its bar in the top or bottom lane |
| Zoom | Mouse wheel over the waveform or the overview |
| Scroll | Shift + wheel, middle-drag, drag the overview, or drag the waveform with the Select tool |
| More options | Right-click a segment, a cut, or empty space |
| Rename a segment | Double-click it |

### Keyboard

These are the defaults. You can change any of them in **Settings → Keyboard shortcuts**: click **+** next to a command and press the keys you want.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| P | Play the selected segment, or the audio around the selected cut |
| Shift+P / Alt+P | Play the start (fade-in) or the end (fade-out) of the segment |
| I / O | Mark a segment's start / end at the playhead |
| Shift+I / Shift+O | Move the selected segment's start / end to the playhead |
| X | Mark a cut's start, then its end |
| Alt+← / Alt+→ | Nudge the selected start by 10 ms (add Shift to nudge the end) |
| ← / → | Playhead ±1 s (add Shift for ±10 s) |
| Ctrl+← / Ctrl+→ | Playhead to the previous / next segment or cut edge |
| Home / End | Playhead to the start / end of the file |
| Shift+Home / Shift+End | Playhead to the start / end of the selection |
| Ctrl+Home / Ctrl+End | Playhead to the start / end of the segment it's inside |
| C | Center the view on the playhead |
| Page Up / Page Down | Scroll one screen left / right |
| ↑ / ↓, Tab / Shift+Tab | Previous / next segment |
| + / − / F / Z | Zoom in / out / whole file / selection |
| 1 / 2 / 3 | Select / Segment / Cut tool |
| K | Skip cuts while playing (on by default) |
| Delete | Delete the selection |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S / Ctrl+E / Ctrl+O | Save / export / open |
| Ctrl+R | Record a new WAV |
| L | While recording: follow the live point or not |

## Settings

- **Language:** English or Magyar (Hungarian). "System language" follows your operating system. Switching reloads the window; your open file and unsaved edits are kept, but undo history starts fresh.
- **Fade-in / fade-out:** length and curve. The defaults are 0.5 s linear in and 2 s exponential out.
- **"100%" peak level:** 0 dBFS by default. MP3 encoding can overshoot by a fraction of a dB, so −0.3 to −1 dBFS is safer if you want to avoid any clipping.
- **Crossfade at cuts:** 10 ms by default.
- **File list:** show each file's start and end time for typing exact times (hidden by default; the edges can always be dragged on the timeline).
- **Fade boundary line:** dotted, dashed or dash-dotted marker where a fade reaches full volume.
- **Folder rules:** for a folder and its subfolders, the start of filenames (`{nn}`, `{n}`, `{date}`, `{type}`), the `{type}` options, and default volume and bitrate. The deepest matching rule wins; a setting a rule leaves unset comes from a parent folder's rule.
- **Files use:** the peak target and bitrate for files that no folder rule covers.
- **Updates:** look for a new version when the app starts, or check now (see [Updates](#updates)).

Settings are stored in `%APPDATA%\One Take` on Windows, `~/Library/Application Support/One Take` on macOS and `~/.config/One Take` on Linux. Versions from before the rename called the app Studio Audio Editor; its settings and sessions folders are moved to the new names on the first start.

## How export works

Each output file is rendered from the untouched WAV in two ffmpeg passes (ffmpeg reads the samples directly, without trusting the WAV header's length, so a file that is still being recorded exports the same way):

1. Trim the segment, remove the cuts, join the pieces with short crossfades and apply the fades. Then **measure the peak** of that finished audio.
2. Run the same chain again with the gain that brings the peak to its target, and encode to MP3.

Because the peak is measured after cuts and fades, a cut-out cough can't hold the level down. Files are written as `.part` first and renamed when complete.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev        # Vite dev server + Electron (UI hot-reloads)
npm test           # unit tests and an ffmpeg export test
npm run typecheck
npm run dist       # installers for the current OS, in release/
npm run icon       # re-render build/icon.png and build/icon.ico from build/icon.svg
```

`npm run dist` builds for the system it runs on: the installer and portable .exe on Windows, the .dmg on macOS, the AppImage and .deb on Linux.

### Automatic builds and releases

[GitHub Actions](.github/workflows/build.yml) builds and tests the app on Windows, macOS and Linux for every push and pull request. To publish a release, bump `version` in `package.json`, commit, then push a matching tag. The workflow attaches the five downloads to a new GitHub release, together with the `latest*.yml` and `.blockmap` files that installed copies use to update themselves:

```bash
git tag v1.0.0
```

```bash
git push origin v1.0.0
```

### Project layout

- `src/main/`: Electron main process (WAV parsing, waveform scan and cache, ffmpeg export, reading samples for playback, writing recordings)
- `src/preload/`: the bridge between the UI and the main process (`window.studio`)
- `src/renderer/`: the UI (canvas timeline and overview, output list, commands and shortcuts)
- `src/shared/`: types, time formatting, cut/segment planning and filename validation
- `src/shared/i18n/`: translations. `en.ts` is the master list of texts. To add a language, copy `hu.ts`, translate it, and register it in `index.ts`. The type checker reports any missing text, and a test checks that placeholders match.

### Contributing

Issues and pull requests are welcome. Please run `npm run typecheck` and `npm test` before opening a pull request. CI runs both on Windows and Linux.

## License

[MIT](LICENSE) © FeaXR

The app bundles a static build of [FFmpeg](https://ffmpeg.org/) through [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static). FFmpeg is licensed under the GPL v3, and its license and source reference ship with the app (`resources/app.asar.unpacked/node_modules/ffmpeg-static/`). It runs as a separate program, and the MIT license above covers only One Take's own code.
