// How the web build's browser and server pass values over HTTP. JSON carries everything
// except typed arrays (the waveform peaks), which travel as base64; sample blocks, the
// bulk of the traffic, use a binary layout of their own.

const TYPED = { Int16Array, Float32Array } as const;
type TypedName = keyof typeof TYPED;

interface TaggedArray {
  $typed: TypedName;
  data: string;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(data: string): ArrayBuffer {
  if (typeof Buffer !== 'undefined') {
    const b = Buffer.from(data, 'base64');
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) => {
    for (const name of Object.keys(TYPED) as TypedName[]) {
      if (v instanceof TYPED[name]) {
        return { $typed: name, data: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } satisfies TaggedArray;
      }
    }
    return v;
  });
}

export function decodeJson<T>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    const tagged = v as TaggedArray | null;
    if (tagged && typeof tagged === 'object' && typeof tagged.$typed === 'string' && tagged.$typed in TYPED) {
      return new TYPED[tagged.$typed](fromBase64(tagged.data));
    }
    return v;
  }) as T;
}

/** One array per channel as [channels u32][frames u32][samples of each channel, f32 LE]. */
export function encodePlanes(planes: Float32Array[]): Uint8Array<ArrayBuffer> {
  const frames = planes[0]?.length ?? 0;
  const out = new Uint8Array(8 + planes.length * frames * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, planes.length, true);
  view.setUint32(4, frames, true);
  planes.forEach((p, i) => out.set(new Uint8Array(p.buffer, p.byteOffset, frames * 4), 8 + i * frames * 4));
  return out;
}

export function decodePlanes(bytes: Uint8Array): Float32Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint32(0, true);
  const frames = view.getUint32(4, true);
  if (bytes.byteLength !== 8 + channels * frames * 4) throw new Error('Malformed sample block');
  // Copied out, so each plane is aligned and owns its memory. ArrayBuffer.slice always copies
  // (a Node Buffer's own slice() would return a view of the whole pooled buffer).
  const at = (i: number) => bytes.byteOffset + 8 + i * frames * 4;
  return Array.from({ length: channels }, (_, i) => new Float32Array(bytes.buffer.slice(at(i), at(i + 1)) as ArrayBuffer));
}
