/**
 * PRIV SPACA service worker
 * Strategy:
 *  - HTML / JS / CSS  -> network-first with offline fallback (so updates ship fast)
 *  - Images / fonts   -> cache-first (offline-friendly avatars and posts)
 *  - /api/*           -> NEVER cached (live data only)
 */
const SW_VERSION = 'priv-spaca-v6';
const STATIC_CACHE = 'priv-spaca-static-' + SW_VERSION;
const RUNTIME_CACHE = 'priv-spaca-runtime-' + SW_VERSION;

const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
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

// Future: push notifications hook (will be wired in Part 2)
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'PRIV SPACA';
  const opts = {
    body: data.body || 'New activity',
    icon: '/manifest.json',
    badge: '/manifest.json',
    tag: data.tag || 'priv-spaca',
    data: data.url || '/',
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) { c.focus(); c.navigate(url); return; }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
