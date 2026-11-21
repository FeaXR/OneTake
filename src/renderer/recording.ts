import { formatNumber, t, translateCodes } from '../shared/i18n/index.ts';
import { formatTime } from '../shared/time.ts';
import { freeName, withWav, type CliCommand } from '../shared/cli.ts';
import type { AudioInfo } from '../shared/types.ts';
import { filenameProblem } from '../shared/validate.ts';
import type { CaptureBlock } from './capture-worklet.ts';
import { choose, openModal, toast } from './dialogs.ts';
import { h, pathText } from './dom.ts';
import type { Editor } from './editor.ts';
import { Meter } from './meter.ts';
import { PeakPyramid } from './peaks.ts';
import { InputCapture, listInputs } from './recorder.ts';

/** Longest wait for the last samples when stopping. */
const FLUSH_TIMEOUT_MS = 1000;
const basename = (p: string) => p.replace(/^.*[\\/]/, '');
const pad2 = (v: number) => String(v).padStart(2, '0');

/** Today as MMDD, the date the naming rules' {date} reads from the start of a WAV name. */
export function todayPrefix(now = new Date()): string {
  return `${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_`;
}

/** The part of a recording name after its MMDD_ date, remembered for the next recording. */
export function nameAfterDate(name: string): string {
  return name.replace(/\.wav$/i, '').replace(/^\d{4}_?/, '');
}

export interface RecordingHost {
  /** Opens the new, still empty recording in the editor (like opening a file). */
  begin(info: AudioInfo, peaks: PeakPyramid): void;
  /** Asks to keep or drop unsaved edits of the open file; false when the user cancelled. */
  confirmDiscard(): Promise<boolean>;
  /** Whether a recording may start now (not while exporting). */
  canStart(): boolean;
  /** Saves unsaved edits of the open file without asking; false when that failed. */
  saveIfDirty(): Promise<boolean>;
  refresh(): void;
}

/**
 * Records from an audio interface into a new WAV that is open in the editor while it grows.
 * The input is opened in the dialog already, so the level can be checked before starting.
 */
export class RecordingController {
  /** Toolbar meter; the dialog has its own. */
  readonly meter = new Meter();
  private readonly editor: Editor;
  private readonly host: RecordingHost;
  private capture: InputCapture | null = null;
  private dialogMeter: Meter | null = null;
  private peaks: PeakPyramid | null = null;
  /** Samples go to the file (after Start, until Stop). */
  private writing = false;
  private lastAppend: Promise<unknown> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private path = '';
  /** Frames still to record when the recording has a set length (from the command line). */
  private framesLeft: number | null = null;
  /** The recording was started from the command line, so what happens is printed there too. */
  private fromCommand = false;
  /** Closes the Record dialog while it is open. */
  private closeDialog: (() => void) | null = null;

  constructor(editor: Editor, host: RecordingHost) {
    this.editor = editor;
    this.host = host;
  }

  /** A recording is running (from Start until it is fully stopped). */
  get active(): boolean {
    return this.writing || this.stopping !== null;
  }

  /** Recorded length, for the toolbar. */
  get elapsedText(): string {
    return formatTime(this.active ? this.editor.duration : 0, 0);
  }

  // ---------- Starting ----------

  async openDialog(): Promise<void> {
    if (this.active || !this.host.canStart()) return;
    if (!(await this.host.confirmDiscard())) return;
    const settings = this.editor.settings;
    let folder = settings.recordFolder;
    let started = false;

    const m = openModal(t('dlg.rec.title'), {
      onClose: () => {
        this.closeDialog = null;
        this.dialogMeter = null;
        if (!started) this.closeInput();
      },
    });
    this.closeDialog = () => m.close();
    const startBtn = h('button', { class: 'primary rec-start', disabled: true, onclick: () => void start() }, t('btn.startRecording'));
    const useInput = async (id: string) => {
      startBtn.disabled = true;
      startBtn.disabled = !(await this.openInput(id, format, error));
    };
    const input = h('select', { onchange: () => void useInput(input.value) });
    const format = h('div', { class: 'form-note' });
    const error = h('div', { class: 'form-note err' });
    const folderPath = h('div', { class: 'folder-path' });
    const showFolder = () => {
      folderPath.textContent = folder ? pathText(folder) : t('dlg.rec.noFolder');
      folderPath.title = folder;
      folderPath.classList.toggle('missing', !folder);
    };
    showFolder();
    const name = h('input', {
      type: 'text', class: 'rec-name', spellcheck: false,
      value: `${todayPrefix()}${settings.recordName}`,
      oninput: () => (error.textContent = ''),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') void start();
      },
    });
    this.dialogMeter = new Meter();

    const start = async () => {
      if (started) return;
      const problem = this.nameProblem(name.value, folder);
      if (problem) {
        error.textContent = problem;
        return;
      }
      const file = /\.wav$/i.test(name.value.trim()) ? name.value.trim() : `${name.value.trim()}.wav`;
      if ((await window.studio.existingFiles(folder, [file])).length) {
        error.textContent = t('dlg.rec.exists', { name: file });
        return;
      }
      if (!this.capture) return;
      started = true;
      startBtn.disabled = true;
      try {
        await this.start(folder, file);
      } catch (err) {
        started = false;
        startBtn.disabled = false;
        error.textContent = errorText(err);
        return;
      }
      settings.recordFolder = folder;
      settings.recordName = nameAfterDate(file);
      settings.recordInput = input.selectedOptions[0]?.textContent ?? '';
      void window.studio.saveSettings(settings);
      m.close();
    };

    m.body.append(
      h('div', { class: 'form-grid' },
        h('label', {}, t('dlg.rec.input')),
        h('div', {}, input, format),
        h('label', {}, t('dlg.rec.level')),
        h('div', { class: 'inline' }, this.dialogMeter.el),
        h('label', {}, t('dlg.rec.folder')),
        h('div', { class: 'inline' }, folderPath, h('button', {
          onclick: async () => {
            const dir = await window.studio.pickFolder(folder || null);
            if (dir) {
              folder = dir;
              error.textContent = '';
              showFolder();
            }
          },
        }, t('dlg.rec.chooseFolder'))),
        h('label', {}, t('dlg.rec.name')),
        h('div', {}, h('div', { class: 'inline' }, name, '.wav'), h('div', { class: 'form-note' }, t('dlg.rec.nameNote'))),
      ),
      error,
    );
    m.foot.append(h('button', { onclick: () => m.close() }, t('btn.cancel')), startBtn);
    queueMicrotask(() => {
      name.focus();
      name.setSelectionRange(name.value.length, name.value.length);
    });

    try {
      const inputs = await listInputs(settings.recordInput);
      if (!inputs.length) throw new Error(t('dlg.rec.noInputs'));
      for (const d of inputs) input.append(h('option', { value: d.id }, d.label));
      input.value = inputs[0].id;
      await useInput(inputs[0].id);
    } catch (err) {
      error.textContent = t('dlg.rec.openFailed', { error: errorText(err) });
    }
  }

  /** Switching input in the dialog reopens it; the meter shows the new one. */
  private async openInput(deviceId: string, format: HTMLElement, error: HTMLElement): Promise<boolean> {
    this.closeInput();
    error.textContent = '';
    format.textContent = '';
    try {
      const capture = await InputCapture.open(deviceId, (b) => this.onBlock(b), () => void this.onInputLost());
      this.capture = capture;
      format.textContent = t('dlg.rec.format', {
        rate: formatNumber(capture.sampleRate / 1000, capture.sampleRate % 1000 ? 1 : 0),
        channels: capture.inputChannels,
      });
      return true;
    } catch (err) {
      error.textContent = t('dlg.rec.openFailed', { error: errorText(err) });
      return false;
    }
  }

  private nameProblem(name: string, folder: string): string | null {
    if (!folder) return t('dlg.rec.noFolder');
    const problem = filenameProblem(name.replace(/\.wav$/i, ''));
    return problem ? t(problem.key, problem.params) : null;
  }

  private async start(folder: string, file: string): Promise<void> {
    const capture = this.capture!;
    const info = await window.studio.startRecording(folder, file, capture.sampleRate, 2);
    this.path = info.path;
    this.peaks = PeakPyramid.empty();
    this.lastAppend = Promise.resolve();
    this.meter.reset();
    this.host.begin(info, this.peaks);
    this.writing = true;
    toast(t('toast.recStarted', { name: basename(info.path) }));
    this.host.refresh();
  }

  // ---------- Command line ----------

  /** Carries out `one-take --record …` or `one-take --stop`, saying what happened in the window and the terminal. */
  async runCommand(command: CliCommand): Promise<void> {
    if (command.kind === 'stop') {
      if (!this.writing) return cliSay(t('cli.notRecording'), true);
      return this.stop(false, true);
    }
    if (command.kind !== 'record') return;
    try {
      await this.startFromCommand(command);
    } catch (err) {
      const text = t('cli.startFailed', { error: errorText(err) });
      toast(text, 'error');
      cliSay(text, true);
    }
  }

  /**
   * Starts recording without the dialog: the input named on the command line (else the last
   * one used), into the folder and name it gives. Unsaved edits are saved first, as nobody may
   * be there to answer; an existing file gets a number added instead of being overwritten.
   */
  private async startFromCommand(command: Extract<CliCommand, { kind: 'record' }>): Promise<void> {
    if (this.active) throw new Error(t('err.alreadyRecording'));
    if (!this.host.canStart()) throw new Error(t('toast.waitForExport'));
    this.closeDialog?.();
    if (!(await this.host.saveIfDirty())) throw new Error(t('cli.saveFailed'));

    const settings = this.editor.settings;
    const name = command.name ?? withWav(`${todayPrefix()}${settings.recordName}`.replace(/_$/, ''));
    const problem = filenameProblem(name.replace(/\.wav$/i, ''));
    if (problem) throw new Error(t(problem.key, problem.params));

    const inputs = await listInputs(settings.recordInput);
    if (!inputs.length) throw new Error(t('dlg.rec.noInputs'));
    const wanted = command.input?.toLowerCase();
    const input = wanted ? inputs.find((d) => d.label.toLowerCase().includes(wanted)) : inputs[0];
    if (!input) throw new Error(t('cli.noSuchInput', { name: command.input!, inputs: inputs.map((d) => d.label).join(', ') }));

    this.closeInput();
    const capture = await InputCapture.open(input.id, (b) => this.onBlock(b), () => void this.onInputLost());
    this.capture = capture;
    const file = freeName(name, await window.studio.listFiles(command.dir));
    this.framesLeft = command.durationSec ? Math.round(command.durationSec * capture.sampleRate) : null;
    this.fromCommand = true;
    try {
      await this.start(command.dir, file);
    } catch (err) {
      this.closeInput();
      this.framesLeft = null;
      this.fromCommand = false;
      throw err;
    }
    cliSay(command.durationSec
      ? t('cli.recordingFor', { path: this.path, input: input.label, time: formatTime(command.durationSec, 0) })
      : t('cli.recordingUntilStopped', { path: this.path, input: input.label }));
    if (file !== name) toast(t('cli.renamed', { name, file }));
  }

  // ---------- Samples ----------

  private onBlock(block: CaptureBlock): void {
    this.meter.update(block.peaks);
    this.dialogMeter?.update(block.peaks);
    if (!this.writing) return;
    let planes: Float32Array[] = block.planes;
    // A recording with a set length takes exactly that many frames, then stops.
    if (this.framesLeft !== null) {
      const left = this.framesLeft;
      if (left <= 0) return;
      if (planes[0].length > left) planes = planes.map((p) => p.subarray(0, left));
      this.framesLeft = left - planes[0].length;
      if (this.framesLeft <= 0) queueMicrotask(() => void this.stop(false, true));
    }
    this.peaks?.append(planes);
    // The main process writes in the order the blocks are sent; the answer is the live point.
    const append = window.studio.appendRecording(planes).then(
      (frames) => this.editor.growTo(frames),
      (err) => {
        if (!this.writing) return;
        const text = t('toast.recWriteFailed', { error: errorText(err) });
        toast(text, 'error');
        if (this.fromCommand) cliSay(text, true);
        void this.stop(false);
      },
    );
    this.lastAppend = append;
  }

  private async onInputLost(): Promise<void> {
    if (!this.writing) {
      this.closeInput();
      return;
    }
    const fromCommand = this.fromCommand;
    await this.stop(false);
    toast(t('toast.recInputLost'), 'error');
    if (fromCommand) cliSay(t('toast.recInputLost'), true);
  }

  // ---------- Stopping ----------

  /**
   * Stops and finishes the file; asks first unless `confirm` is false. `announce` says so when
   * done (a stop from the command line or the end of a set length, where nobody asked).
   */
  async stop(confirm = true, announce = confirm): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.writing) return;
    if (confirm) {
      const answer = await choose(t('dlg.recStop.title'), t('dlg.recStop.message', { name: basename(this.path) }), [
        { label: t('btn.cancel'), value: 'cancel' },
        { label: t('btn.stopRecording'), value: 'stop', primary: true },
      ], 'cancel');
      if (answer !== 'stop' || this.stopping || !this.writing) return;
    }
    this.stopping = (async () => {
      try {
        // Everything the interface delivered until now still goes into the file. An audio
        // engine that stopped answering must not keep the file from being finished.
        await Promise.race([this.capture?.flush(), new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))]);
        this.writing = false;
        this.closeInput();
        await this.lastAppend;
        const info = await window.studio.stopRecording();
        if (info) {
          this.editor.endLive(info);
          if (announce) toast(t('toast.recStopped', { name: basename(info.path), time: formatTime(info.duration, 0) }));
          if (this.fromCommand || announce) cliSay(t('cli.saved', { path: info.path, time: formatTime(info.duration, 1) }));
        }
      } catch (err) {
        toast(errorText(err), 'error');
      } finally {
        this.writing = false;
        this.framesLeft = null;
        this.fromCommand = false;
        this.stopping = null;
        this.meter.reset();
        this.host.refresh();
      }
    })();
    return this.stopping;
  }

  private closeInput(): void {
    this.capture?.close();
    this.capture = null;
  }
}

/** A line in the terminal the app was started from. */
function cliSay(text: string, error = false): void {
  window.studio.cliLog(text, error);
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return translateCodes(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
}
