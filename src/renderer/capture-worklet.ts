// AudioWorklet: collects the input's first two channels into blocks and posts them to the page,
// which hands them to the main process for the WAV. Runs on the audio thread, so it only copies.

// The AudioWorklet scope is not part of TypeScript's DOM library.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

/** Frames per message: about 43 ms at 48 kHz, often enough for a lively meter. */
const BLOCK_FRAMES = 2048;

export interface CaptureBlock {
  type: 'block';
  /** Left and right, BLOCK_FRAMES long except for the block that a flush sends. */
  planes: [Float32Array, Float32Array];
  /** Highest absolute sample of each channel in the block. */
  peaks: [number, number];
}

export type CaptureMessage = CaptureBlock | { type: 'flushed' };

class CaptureProcessor extends AudioWorkletProcessor {
  private planes = CaptureProcessor.newPlanes();
  private filled = 0;
  private peaks: [number, number] = [0, 0];

  constructor() {
    super();
    // 'flush' sends the partial block; 'flushed' then tells the page that nothing is left.
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data !== 'flush') return;
      this.send();
      this.port.postMessage({ type: 'flushed' } satisfies CaptureMessage);
    };
  }

  private static newPlanes(): [Float32Array, Float32Array] {
    return [new Float32Array(BLOCK_FRAMES), new Float32Array(BLOCK_FRAMES)];
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input?.length) return true;
    // Only inputs 1 and 2. A mono source fills both sides; any further channels (such as the
    // interface's loopback) are left out.
    const left = input[0];
    const right = input[1] ?? input[0];
    let i = 0;
    while (i < left.length) {
      const n = Math.min(left.length - i, BLOCK_FRAMES - this.filled);
      this.planes[0].set(left.subarray(i, i + n), this.filled);
      this.planes[1].set(right.subarray(i, i + n), this.filled);
      for (let j = i; j < i + n; j++) {
        const l = Math.abs(left[j]);
        const r = Math.abs(right[j]);
        if (l > this.peaks[0]) this.peaks[0] = l;
        if (r > this.peaks[1]) this.peaks[1] = r;
      }
      this.filled += n;
      i += n;
      if (this.filled === BLOCK_FRAMES) this.send();
    }
    return true;
  }

  private send(): void {
    if (this.filled === 0) return;
    const planes: [Float32Array, Float32Array] = this.filled === BLOCK_FRAMES
      ? this.planes
      : [this.planes[0].slice(0, this.filled), this.planes[1].slice(0, this.filled)];
    const msg: CaptureBlock = { type: 'block', planes, peaks: this.peaks };
    this.port.postMessage(msg, [planes[0].buffer, planes[1].buffer]);
    this.planes = CaptureProcessor.newPlanes();
    this.filled = 0;
    this.peaks = [0, 0];
  }
}

registerProcessor('capture', CaptureProcessor);
