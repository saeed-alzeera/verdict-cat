const CACHE = 'verdict-cat-v3';

// HTML documents are self-modifying (the library/reader pages get patched
// in place on GitHub whenever a book is uploaded or deleted), so they must
// never be served cache-first: a copy cached before/during a GitHub Pages
// deploy would otherwise get pinned and keep being served forever, which is
// what caused freshly uploaded books to permanently 404 as "Unknown book"
// even after the real deploy finished. Only truly static assets get
// precached and served cache-first.
const PRECACHE = [
  '/favicon.svg',
  '/favicon-32.png',
  '/favicon-180.png',
  '/favicon.ico',
];

const HTML_RE = /\.html$|\/$/;

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

  if (url.origin === self.location.origin) {
    // HTML documents: network-first, cache only as an offline fallback, so
    // navigating to a page always gets the latest deployed content.
    if (e.request.mode === 'navigate' || HTML_RE.test(url.pathname)) {
      e.respondWith(
        fetch(e.request)
          .then((res) => {
            if (res.ok) {
              caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
            }
            return res;
          })
          .catch(() => caches.match(e.request))
      );
      return;
    }

    // Other same-origin assets (icons, scripts, etc.): cache-first.
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
