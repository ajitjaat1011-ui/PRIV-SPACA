// PRIV SPACA — Cloudflare Pages advanced-mode worker (Supabase cutover, perf-tuned)
//
// Every /api/* and /media/* request is proxied to Render.
// Uses keepalive-friendly fetch dispatcher (Cloudflare reuses connections automatically),
// sets aggressive no-transform headers for static assets, adds keepalive to upstream,
// and exposes a /api/health endpoint that returns quickly even when Render is cold.
//
// A `scheduled()` cron pings Render every 10 minutes to prevent free-tier cold starts.

const RENDER_API_URL = 'https://priv-spaca.onrender.com';
const UPSTREAM_TIMEOUT_MS = 25000;

function isBlockedAssetPath(pathname) {
  if (!pathname || pathname === '/') return false;
  const exact = new Set([
    '/README.md', '/THIRD_PARTY_API_AUDIT.md', '/SECURITY_AUDIT_2026-07-02.md',
    '/package.json', '/package-lock.json', '/wrangler.toml',
    '/.cloudflareignore', '/.gitlab-ci.yml',
    '/app.js', '/style.css', '/app.js.map', '/style.css.map',
  ]);
  if (exact.has(pathname)) return true;
  return pathname.startsWith('/backups/')
    || pathname.startsWith('/scripts/')
    || pathname.startsWith('/react-auth/')
    || pathname.startsWith('/render/')
    || pathname.startsWith('/supabase/')
    || pathname.startsWith('/api/')  // api is handled separately, blocks ASSETS fetch for /api/
    || pathname.startsWith('/AUDIT_')
    || pathname.startsWith('/SECURITY_AUDIT')
    || pathname.startsWith('/.git')
    || pathname.startsWith('/.github/');
}

function forwardHeaders(request) {
  const headers = new Headers(request.headers);
  for (const h of ['host','connection','cf-connecting-ip','x-forwarded-for','x-forwarded-proto','cf-ray','cf-ipcountry','accept-encoding']) {
    headers.delete(h);
  }
  const cf = request.cf || {};
  headers.set('x-forwarded-for', (cf && cf.clientIp) || '0.0.0.0');
  headers.set('x-forwarded-proto', 'https');
  headers.set('accept-encoding', 'gzip, br');
  return headers;
}

async function proxyToRender(request) {
  const url = new URL(request.url);
  const target = RENDER_API_URL.replace(/\/+$/, '') + url.pathname + url.search;
  const method = request.method;
  const init = {
    method,
    headers: forwardHeaders(request),
    redirect: 'manual',
    cf: { cacheTtl: 0, cacheEverything: false, timeout: UPSTREAM_TIMEOUT_MS },
  };
  if (method !== 'GET' && method !== 'HEAD') init.body = request.body;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  init.signal = ctrl.signal;

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    clearTimeout(timer);
    return new Response(JSON.stringify({
      error: 'The service is temporarily unavailable. Please retry shortly.',
      success: false,
    }), { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  clearTimeout(timer);

  const out = new Headers(upstream.headers);
  const rawCookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
  out.delete('set-cookie');
  for (const raw of rawCookies) {
    const cleaned = String(raw).split(';').map(p => p.trim())
      .filter(p => p && !/^domain=/i.test(p)).join('; ');
    if (cleaned) out.append('set-cookie', cleaned);
  }
  // Don't let Render's cookies/session be overridden by upstream cache headers
  out.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

// Local fast health endpoint — doesn't wait for Render (used by monitors & keepalive-friendly)
async function healthz(request) {
  return new Response(JSON.stringify({
    ok: true, name: 'PRIV SPACA',
    persistence: 'supabase-postgres-primary-proxied',
    runtime: 'cloudflare-workers',
    edge: 'ap-south-1',
    version: 'perf-tuned-v2',
    upstream: RENDER_API_URL,
    time: Date.now(),
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function pingRender() {
  // Warm-up ping to prevent Render free-tier cold starts.
  try {
    await fetch(RENDER_API_URL + '/api/health', {
      method: 'GET',
      cf: { cacheTtl: 0, timeout: 10000 },
    });
  } catch (e) { /* ignore */ }
}

function assetHeaders(pathname, res) {
  const out = new Headers(res.headers);
  // Immutable assets: cache for 1 year
  if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|ico)(\?|$)/i.test(pathname)) {
    out.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (pathname === '/' || pathname.endsWith('.html') || pathname === '') {
    out.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }
  out.set('X-Content-Type-Options', 'nosniff');
  out.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Only apply frame-ancestors that allow the main studio showcase
  out.set('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'self' https://asvtr-web-designers.pages.dev https://*.asvtr-web-designers.pages.dev; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:; connect-src 'self' https: wss:; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests");
  out.delete('X-Frame-Options');
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Local fast health (no upstream wait)
    if (url.pathname === '/api/health' && request.method === 'GET') {
      // Fire-and-forget warmup in the background so Render stays hot
      ctx.waitUntil(pingRender());
      return healthz(request);
    }

    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/');
    if (isApi) {
      return proxyToRender(request);
    }

    if (isBlockedAssetPath(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res && res.status === 200) {
        return new Response(res.body, { headers: assetHeaders(url.pathname, res), status: res.status });
      }
      return res;
    }
    return new Response('Not found', { status: 404 });
  },

  // Cron-triggered warmup to keep Render from sleeping.
  // Add in wrangler.toml or via Pages Dashboard → Settings → Cron Triggers: every 10 minutes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pingRender());
  },
};
