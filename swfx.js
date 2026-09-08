/* ============================================================
   sw.js — minimal service worker so the browser will offer to
   install this as a desktop app, and so the app shell (everything
   except the CDN-hosted Excel library / Google Fonts) keeps working
   without an internet connection once it's been opened once.
   Bump CACHE_NAME whenever any core file changes so old, cached
   copies get replaced instead of silently reused.
   ============================================================ */

const CACHE_NAME = 'mvs-fx-terminal-v1';
const CORE_FILES = [
  './',
  './index.html',
  './calendar.js',
  './calculator.js',
  './storage.js',
  './excel.js',
  './script.js',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only manage same-origin requests (the app's own files). Cross-origin
  // requests — the SheetJS CDN script, Google Fonts — are left to the
  // network as normal; Excel import/export already tells the user
  // directly if that library didn't load, so no special offline
  // handling is needed there.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached yet -> nothing we can do for a brand-new file
      return cached || network;
    })
  );
});
