// One Take that runs entirely in the browser (the browser-only build, src/browser): this server only
// hands out its files. Audio, settings and sessions never reach it; they stay in the browser.
import { join } from 'node:path';
import { APP_VERSION } from '../shared/links.ts';
import { askPassword, authorized, createServer, HOST, HTTPS, PASSWORD, PORT, send, serveStatic } from './http.ts';

const WEB_DIR = join(__dirname, '..', 'browser');

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
  if (!authorized(req)) return askPassword(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
  // The service worker may control the whole site; the page never needs to be framed.
  serveStatic(WEB_DIR, url, res, { 'Service-Worker-Allowed': '/', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
});

server.listen(PORT, HOST, () => {
  console.log(`One Take ${APP_VERSION} (runs in the browser) on ${HTTPS ? 'https' : 'http'}://${HOST}:${PORT}${PASSWORD ? ', password required' : ''}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0));
