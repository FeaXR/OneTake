// The LAME MP3 encoder compiled to WebAssembly, for exports without ffmpeg (src/shared/export.ts).
import { createEncoder } from 'wasm-media-encoders';
import type { Mp3Encoder } from './export.ts';

/** Sample rates an MPEG-1 Layer III file can have; others are resampled by LAME. */
const MPEG1_RATES = [32000, 44100, 48000];

let compiled: WebAssembly.Module | null = null;

/**
 * A constant-bitrate encoder for the given input, keeping its sample rate where MP3 allows it.
 * `wasm` is the library's mp3.wasm: its address, or its bytes. (The library's own copy is a
 * data: URL, which the browser build's content security policy does not allow.)
 */
export async function mp3Encoder(sampleRate: number, channels: number, bitrate: number, wasm: string | Uint8Array): Promise<Mp3Encoder> {
  const encoder = await createEncoder('audio/mpeg', compiled ?? wasm, (module) => (compiled = module));
  encoder.configure({
    sampleRate,
    channels: channels as 1 | 2,
    bitrate: bitrate as 320,
    ...(MPEG1_RATES.includes(sampleRate) ? { outputSampleRate: sampleRate as 48000 } : {}),
  });
  return encoder;
}
