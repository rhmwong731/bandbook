// Offline app shell. Same-origin GETs: cache-first, refreshed in the background.
const CACHE = 'bandbook-v34';
const SHELL = ['./', 'index.html', 'styles.css', 'road.css', 'fonts/archivo-narrow-500.woff2', 'fonts/archivo-narrow-700.woff2', 'fonts/archivo-500.woff2', 'fonts/archivo-700.woff2', 'fonts/big-shoulders-stencil-800.woff2', 'fonts/permanent-marker-400.woff2', 'manifest.webmanifest', 'icon.svg',
  'js/app.js', 'js/chordpro.js', 'js/ink.js', 'js/store.js', 'js/server.js', 'js/sync.js', 'js/merge.js', 'js/sets.js', 'js/order.js', 'js/dnd.js', 'js/diagram.js', 'js/metronome.js', 'js/docview.js', 'js/backup.js', 'js/offline.js', 'vendor/pdf.min.js', 'vendor/pdf.worker.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// The page asks how much of the shell is saved (for the "Ready for offline" check).
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'status' || !e.ports[0]) return;
  e.waitUntil((async () => {
    const keys = (await (await caches.open(CACHE)).keys()).map((r) => new URL(r.url).pathname);
    const need = SHELL.map((p) => new URL(p, self.registration.scope).pathname);
    e.ports[0].postMessage({ version: CACHE, cached: need.filter((p) => keys.includes(p)).length, total: need.length });
  })());
});
