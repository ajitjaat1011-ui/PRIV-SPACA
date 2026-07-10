/**
 * PRIV SPACA service worker
 * Strategy:
 *  - HTML / JS / CSS  -> network-first with offline fallback (so updates ship fast)
 *  - Images / fonts   -> cache-first (offline-friendly avatars and posts)
 *  - /api/*           -> NEVER cached (live data only)
 */
const SW_VERSION = 'priv-spaca-v95';
const STATIC_CACHE = 'priv-spaca-static-v94';
const RUNTIME_CACHE = 'priv-spaca-runtime-v94';

const APP_SHELL = [
  '/',
  '/index.html',
  '/style.min.css?v=122',
  '/app.min.js?v=122',
  '/manifest.json',
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => {
        if (k !== STATIC_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
      }))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache API calls — always live
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/functions/')) {
    return;
  }
  // Only GET caching
  if (req.method !== 'GET') return;

  // HTML / JS / CSS: always network-first (no cache) so deploys ship fast
  // and users always see the latest code. Only fall back to cache when
  // the network fails (e.g. offline).
  if (url.pathname === '/' || url.pathname === '/index.html' ||
      /\/(app|style)\.js(\?|$)/i.test(url.pathname) ||
      /\/style\.css(\?|$)/i.test(url.pathname) ||
      url.pathname === '/sw.js' || /\/sw\.js(\?|$)/i.test(url.pathname)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(async (c) => {
            await c.put(req, copy);
            await trimCache(STATIC_CACHE, 200);
          });
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  // Images / fonts — cache-first
  if (req.destination === 'image' || req.destination === 'font' ||
      /\.(png|jpe?g|webp|gif|svg|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          if (res && res.ok && res.type !== 'opaque') {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then(async (c) => {
              await c.put(req, copy);
              await trimCache(RUNTIME_CACHE, 300);
            });
          }
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // App shell — network-first, fallback to cache (so updates are immediate when online,
  // but the app still loads offline)
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then(async (c) => {
            await c.put(req, copy);
            await trimCache(STATIC_CACHE, 200);
          });
        }
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match('/index.html')))
    );
    return;
  }
});

// Push notification handler (delivered when the app is closed)
const ICON_DATA_URI = "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%2300c6ff'/%3E%3Cstop offset='1' stop-color='%230072ff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='192' height='192' rx='42' fill='url(%23g)'/%3E%3Cpath fill='%23fff' d='M42 96 150 42 126 150 96 108z'/%3E%3C/svg%3E";

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'PRIV SPACA';
  const opts = {
    body: data.body || 'New activity',
    icon: ICON_DATA_URI,
    badge: ICON_DATA_URI,
    tag: data.tag || 'priv-spaca',
    data: { url: data.url || '/', kind: data.kind, notifId: data.notifId },
    vibrate: [120, 60, 120],
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.indexOf(self.location.origin) === 0) {
          c.focus();
          if (c.navigate && url !== '/') c.navigate(url);
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});


self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data.type === 'CLEAR_CACHES') {
    // v90: Also clear the STATIC_CACHE on demand (used by 426/version probe)
    event.waitUntil(
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => event.source && event.source.postMessage({ type: 'CACHES_CLEARED' }))
    );
  }
  if (event.data.type === 'GET_VERSION') {
    if (event.source && event.source.postMessage) {
      event.source.postMessage({ type: 'VERSION', version: SW_VERSION });
    }
  }
});

// Limit runtime cache bloat: evict oldest entries when a cache grows too large.
async function trimCache(cacheName, maxEntries = 300) {
  const cache = await caches.open(cacheName).catch(() => null);
  if (!cache) return;
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(toDelete.map(req => cache.delete(req)));
}

// Periodic background cleanup of stale runtime cache entries.
self.addEventListener('sync', (event) => {
  if (event.tag === 'trim-caches') {
    event.waitUntil(Promise.all([trimCache(RUNTIME_CACHE, 300), trimCache(STATIC_CACHE, 200)]));
  }
});
