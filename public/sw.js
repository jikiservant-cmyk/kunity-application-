/*
 * Kunity / SaccoOs service worker.
 *
 * Deliberately conservative so it can never break the app on Netlify:
 *   - GET same-origin only.
 *   - /api/* and /auth* are NEVER touched (no cached authed content, no
 *     offline payment ghosts).
 *   - Only immutable build output (/_next/static/) and /icons/ are cached,
 *     cache-first.
 *   - Everything else goes straight to the network.
 *
 * Its existence (with a fetch handler) plus the manifest satisfies the
 * browser's installability criteria.
 */
const CACHE = 'kunity-shell-v1';
const PRECACHE = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Never interfere with the API or the auth pages.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth')) return;

  const cacheable =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest';
  if (!cacheable) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
    )
  );
});
