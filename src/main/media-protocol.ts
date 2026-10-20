import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export const MEDIA_SCHEME = 'media';

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

/**
 * Serves local audio files to the <audio> element as media://local/<encoded path>,
 * with HTTP range support so seeking in a long WAV does not read the whole file.
 * Only the file the user opened is served.
 */
export function handleMediaScheme(isAllowed: (path: string) => boolean): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!isAllowed(path)) return new Response('Forbidden', { status: 403 });

    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }

    // CORS lets the renderer route the audio through Web Audio (for the fade preview).
    const headers = new Headers({ 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' });
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('Range') ?? '');
    if (!range || (range[1] === '' && range[2] === '')) {
      headers.set('Content-Length', String(size));
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers });
    }

    let start: number;
    let end: number;
    if (range[1] === '') {
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    }
    if (start >= size || start > end) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: 206, headers });
  });
}
