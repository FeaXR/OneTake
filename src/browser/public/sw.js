// Keeps One Take's own files, so the page opens again without a connection to its server.
// The page is asked for fresh each time (a new version shows on the next visit); the built
// assets have their content hash in their names and never change, so they are kept as they are.
const CACHE = 'one-take';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const urls = Array.isArray(e.data?.keep) ? e.data.keep : [];
  e.waitUntil(caches.open(CACHE).then((cache) =>
    Promise.all(urls.map((url) => cache.match(url).then((hit) => hit || cache.add(url)).catch(() => {}))),
  ));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (url.pathname.includes('/assets/')) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res.clone());
      return res;
    }
    try {
      const res = await fetch(req);
      if (res.ok) await cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
