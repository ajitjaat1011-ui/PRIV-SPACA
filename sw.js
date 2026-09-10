/**
 * PRIV SPACA service worker
 * Strategy:
 *  - HTML / JS / CSS  -> network-first with offline fallback (so updates ship fast)
 *  - Images / fonts   -> cache-first (offline-friendly avatars and posts)
 *  - /api/*           -> NEVER cached (live data only)
 */
const SW_VERSION = 'priv-spaca-v1.1';
const STATIC_CACHE = 'priv-spaca-static-v1.1';
const RUNTIME_CACHE = 'priv-spaca-runtime-v1.1';

// v1.0: base directory this worker is served from. '' at a domain root
// (Cloudflare Pages), '/functions/v1/app' on Supabase. Derived from the
// worker's own URL so the same file works on both hosts.
const SW_BASE = (() => {
  try {
    const p = new URL('.', self.location.href).pathname;
    return p === '/' ? '' : p.replace(/\/+$/, '');
  } catch (_) { return ''; }
})();

// APP_SHELL ?v= values MUST match the URLs index.html/app.js actually
// request (style.min.css?v=11, boot-guard.min.js?v=10, vendor ?v=10,
// auth.react.min.js?v=11 lazy from app.js, heic2any ?v=0.0.4 lazy from
// app.js, app.min.js?v=12 and icons-v2.js?v=12 from index.html). A shell
// entry pointing at a different ?v than the page requests means the page
// copy is never pre-cached (offline gap), and stale entries linger.
const APP_SHELL = [
  SW_BASE + '/',
  SW_BASE + '/index.html',
  SW_BASE + '/style.min.css?v=11',
  SW_BASE + '/app.min.js?v=12',
  SW_BASE + '/boot-guard.min.js?v=10',
  SW_BASE + '/icons-v2.js?v=12',
  SW_BASE + '/auth.react.min.js?v=11',
  SW_BASE + '/vendor/local-fonts.css?v=10',
  SW_BASE + '/vendor/lucide.min.js?v=10',
  SW_BASE + '/vendor/motion.min.js?v=10',
  SW_BASE + '/vendor/heic2any.min.js?v=0.0.4',
  SW_BASE + '/manifest.json',
  SW_BASE + '/favicon.ico',
  SW_BASE + '/favicon-16x16.png',
  SW_BASE + '/favicon-32x32.png',
  SW_BASE + '/apple-touch-icon.png',
  SW_BASE + '/icon-192.png',
  SW_BASE + '/icon-512.png',
  SW_BASE + '/icon-maskable-512.png',
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
  if (url.pathname.startsWith(SW_BASE + '/api/')) {
    return;
  }
  // Only GET caching
  if (req.method !== 'GET') return;

  // HTML / JS / CSS: always network-first (no cache) so deploys ship fast
  // and users always see the latest code. Only fall back to cache when
  // the network fails (e.g. offline).
  if (url.pathname === SW_BASE + '/' || url.pathname === SW_BASE + '/index.html' ||
      /\/(app|auth\.react|style)(?:\.min)?\.js(\?|$)/i.test(url.pathname) ||
      /\/style(?:\.min)?\.css(\?|$)/i.test(url.pathname) ||
      /\/sw\.js(\?|$)/i.test(url.pathname)) {
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
      }).catch(() => caches.match(req).then((cached) =>
        cached || (req.mode === 'navigate' ? caches.match(SW_BASE + '/index.html') : undefined)
      ))
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
        }).catch(() => {
          // Cache miss + network fail (offline): return a 1x1 transparent
          // placeholder so the browser doesn't throw "Intercepted response
          // was undefined". Previously this returned `cached` which was
          // undefined, causing a console error on every failed image load.
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
            { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }
          );
        })
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
      }).catch(() => caches.match(req).then((c) => c || caches.match(SW_BASE + '/index.html')))
    );
    return;
  }
});

// Push notification handler (delivered when the app is closed)
const ICON_DATA_URI = "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%238FBCFF'/%3E%3Cstop offset='1' stop-color='%235B9BFA'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='192' height='192' rx='42' fill='url(%23g)'/%3E%3Cpath fill='%23fff' d='M42 96 150 42 126 150 96 108z'/%3E%3C/svg%3E";

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'PRIV SPACA';
  const avatar = typeof data.avatar === 'string' && /^https:\/\//i.test(data.avatar) ? data.avatar : ICON_DATA_URI;
  const opts = {
    body: data.preview || data.body || 'New activity',
    icon: avatar,
    image: typeof data.image === 'string' && /^https:\/\//i.test(data.image) ? data.image : undefined,
    badge: ICON_DATA_URI,
    tag: data.tag || 'priv-spaca',
    data: { url: data.url || (SW_BASE + '/'), roomId: data.roomId || null, kind: data.kind, notifId: data.notifId },
    vibrate: [120, 60, 120],
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || (SW_BASE + '/');
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.indexOf(self.location.origin) === 0) {
          c.focus();
          if (c.navigate && url !== SW_BASE + '/') c.navigate(url);
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
