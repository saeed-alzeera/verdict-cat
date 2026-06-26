const CACHE = 'verdict-cat-v1';

const PRECACHE = [
  '/',
  '/index.html',
  '/numbers.html',
  '/library.html',
  '/reader.html',
  '/text-transport.html',
  '/gist.js',
  '/favicon.svg',
  '/favicon-32.png',
  '/favicon-180.png',
  '/favicon.ico',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  // Same-origin assets: cache-first
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        const network = fetch(e.request).then((res) => {
          if (res.ok) {
            caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          }
          return res;
        });
        return cached || network;
      })
    );
    return;
  }

  // CDN assets (jszip etc.): cache-first, network fallback
  if (url.hostname.includes('jsdelivr.net') || url.hostname.includes('cdn.')) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((res) => {
          if (res.ok) {
            caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          }
          return res;
        });
      })
    );
  }
});
