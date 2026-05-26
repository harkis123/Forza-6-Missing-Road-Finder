const VERSION = 'v2';
const CACHE = `forza-mf-${VERSION}`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for code & markup (HTML, JS, CSS, JSON) so a fresh deploy
// reaches users on the next page load instead of being shadowed by the
// previous cache. Cache-first for static binary assets (icons, preview image,
// favicons, fonts) that rarely change.
const CODE_PATTERN = /\.(?:html|js|mjs|css|json|webmanifest)$|\/$/i;

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const path = new URL(event.request.url).pathname;
  const isCode = CODE_PATTERN.test(path);

  if (isCode) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fromNetwork = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fromNetwork;
    }),
  );
});
