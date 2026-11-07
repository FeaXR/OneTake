// What both servers share: the optional password, HTTPS, and handing out the built page.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { extname, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

/** When set, the browser asks for it (any user name) before showing anything. */
export const PASSWORD = process.env.ONETAKE_PASSWORD ?? '';
export const PORT = Number(process.env.PORT ?? 8080);
export const HOST = process.env.HOST ?? '0.0.0.0';
const TLS_CERT = process.env.ONETAKE_TLS_CERT;
const TLS_KEY = process.env.ONETAKE_TLS_KEY;
export const HTTPS = !!(TLS_CERT && TLS_KEY);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

export function send(res: ServerResponse, status: number, body: string | Uint8Array, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function authorized(req: IncomingMessage): boolean {
  if (!PASSWORD) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), 'base64').toString('utf8').replace(/^[^:]*:/, ''));
  const expected = Buffer.from(PASSWORD);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Asks the browser for the password. */
export function askPassword(res: ServerResponse): void {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="One Take", charset="UTF-8"' });
  res.end();
}

/** Sends a file of the built page from `dir`; 404 for anything else. */
export function serveStatic(dir: string, url: URL, res: ServerResponse, headers: Record<string, string> = {}): void {
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = resolve(dir, rel);
  if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
  // Built assets have a hash in their name and never change; the page itself is always fetched fresh.
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  createReadStream(file).pipe(res);
}

export function createServer(handler: RequestListener) {
  return HTTPS ? createHttpsServer({ cert: readFileSync(TLS_CERT!), key: readFileSync(TLS_KEY!) }, handler) : createHttpServer(handler);
}
