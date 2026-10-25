import type { CaptureBlock, CaptureMessage } from './capture-worklet.ts';
import workletUrl from './capture-worklet.ts?worker&url';

/** Inputs whose name says they are the Focusrite interface; picked by default. */
const PREFERRED_INPUT = /scarlett|focusrite/i;

export interface InputDevice {
  id: string;
  label: string;
}

/**
 * Audio inputs, the preferred one first: the last one used, else a Scarlett, else the system
 * default. Names are only shown once the app may use an input, so access is asked for first.
 */
export async function listInputs(lastLabel: string): Promise<InputDevice[]> {
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
  probe.getTracks().forEach((t) => t.stop());
  const inputs = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `#${i + 1}` }));
  const rank = (d: InputDevice) => (d.label === lastLabel ? 0 : PREFERRED_INPUT.test(d.label) ? 1 : d.id === 'default' ? 2 : 3);
  return inputs.sort((a, b) => rank(a) - rank(b));
}

/**
 * One audio input, open and running: blocks of its first two channels arrive through
 * `onBlock` from the moment it opens (for the level meter). Nothing is monitored on the
 * speakers. Signal processing meant for calls (echo cancellation, noise suppression, automatic
 * gain) is switched off, so the recording is what the interface delivers.
 */
export class InputCapture {
  readonly sampleRate: number;
  /** Channels the input delivers (only the first two are used). */
  readonly inputChannels: number;
  private readonly stream: MediaStream;
  private readonly ctx: AudioContext;
  private readonly node: AudioWorkletNode;
  private flushWaiters: (() => void)[] = [];
  private closed = false;

  private constructor(stream: MediaStream, ctx: AudioContext, node: AudioWorkletNode, inputChannels: number) {
    this.stream = stream;
    this.ctx = ctx;
    this.node = node;
    this.sampleRate = ctx.sampleRate;
    this.inputChannels = inputChannels;
  }

  static async open(
    deviceId: string,
    onBlock: (block: CaptureBlock) => void,
    onEnded: () => void,
  ): Promise<InputCapture> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
      },
    });
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    let ctx: AudioContext;
    try {
      // The context runs at the device's rate, so the samples are recorded as they come, not resampled.
      ctx = new AudioContext({ sampleRate: settings.sampleRate, latencyHint: 'playback' });
    } catch {
      ctx = new AudioContext({ latencyHint: 'playback' });
    }
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const source = ctx.createMediaStreamSource(stream);
      // 'max' keeps every channel of the input apart; the worklet takes the first two.
      const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCountMode: 'max' });
      const capture = new InputCapture(stream, ctx, node, settings.channelCount ?? source.channelCount);
      node.port.onmessage = (e: MessageEvent<CaptureMessage>) => {
        if (e.data.type === 'block') onBlock(e.data);
        else capture.flushWaiters.splice(0).forEach((resolve) => resolve());
      };
      source.connect(node);
      track.addEventListener('ended', () => {
        if (!capture.closed) onEnded();
      });
      await ctx.resume();
      return capture;
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      throw err;
    }
  }

  /** Resolves once every captured sample has reached `onBlock`. */
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      this.node.port.postMessage('flush');
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushWaiters.splice(0).forEach((resolve) => resolve());
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }
}
