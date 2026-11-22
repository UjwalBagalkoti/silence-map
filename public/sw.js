/* Silence Map service worker.
 * - App files: network first (so updates show up immediately), cache as an offline fallback.
 * - Leaflet from unpkg: cached after first load.
 * - /api/*: never cached; gives a friendly message when offline.
 * - Map tiles and fonts: left to the browser. */
const SHELL_CACHE = 'silence-map-shell-v4';
const LIB_CACHE = 'silence-map-lib-v1';
const SHELL = ['/', '/style.css', '/app.js', '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/markercluster/leaflet.markercluster.js', '/vendor/markercluster/MarkerCluster.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => ![SHELL_CACHE, LIB_CACHE].includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => new Response(
        JSON.stringify({ error: 'You are offline. Reconnect to search for places.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  if (url.origin === location.origin) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then(c => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error())))
    );
    return;
  }

  if (url.hostname === 'unpkg.com') {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(LIB_CACHE).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
