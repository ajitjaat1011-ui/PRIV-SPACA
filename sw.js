/**
 * PRIV SPACA service worker
 * Strategy:
 *  - HTML / JS / CSS  -> network-first with offline fallback (so updates ship fast)
 *  - Images / fonts   -> cache-first (offline-friendly avatars and posts)
 *  - /api/*           -> NEVER cached (live data only)
 */
const SW_VERSION = 'priv-spaca-v39-ig-post-card-exact-layout';
const STATIC_CACHE = 'priv-spaca-static-' + SW_VERSION;
const RUNTIME_CACHE = 'priv-spaca-runtime-' + SW_VERSION;

const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js?v=18-close-friends-story-manage',
  '/manifest.json',
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

  // Images / fonts — cache-first
  if (req.destination === 'image' || req.destination === 'font' ||
      /\.(png|jpe?g|webp|gif|svg|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          if (res && res.ok && res.type !== 'opaque') {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
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
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
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
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
