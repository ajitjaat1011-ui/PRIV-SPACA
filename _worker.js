// PRIV SPACA — Cloudflare Pages advanced-mode worker (Supabase cutover)
//
// Single backend: the Render-hosted Supabase API (RENDER_API_URL below).
// Every /api/* and /media/* request is forwarded there (same-origin proxy,
// so the __Host-ps_session cookie keeps working without CORS). The legacy
// The pre-migration fallback API was removed with the Supabase cutover.
//
// If the backend is unreachable (DNS failure, connection refused, timeout)
// the worker returns a structured 503 so clients show a clean retry state
// instead of a page error. App-level 5xx responses are passed through
// untouched.

// Public Render web-service URL (not a secret).
const RENDER_API_URL = 'https://priv-spaca.onrender.com';

function isBlockedAssetPath(pathname) {
  if (!pathname || pathname === '/') return false;
  const exact = new Set([
    '/README.md',
    '/THIRD_PARTY_API_AUDIT.md',
    '/SECURITY_AUDIT_2026-07-02.md',
    '/package.json',
    '/package-lock.json',
    '/wrangler.toml',
    '/.cloudflareignore',
    '/.gitlab-ci.yml',
    '/app.js',
    '/style.css',
  ]);
  if (exact.has(pathname)) return true;
  return pathname.startsWith('/backups/')
    || pathname.startsWith('/scripts/')
    || pathname.startsWith('/react-auth/')
    || pathname.startsWith('/render/')
    || pathname.startsWith('/supabase/')
    || pathname.startsWith('/api/')
    || pathname.startsWith('/AUDIT_')
    || pathname.startsWith('/SECURITY_AUDIT')
    || pathname.startsWith('/.git')
    || pathname.startsWith('/.github/');
}

function forwardHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('cf-connecting-ip');
  headers.delete('x-forwarded-for');
  headers.delete('x-forwarded-proto');
  headers.delete('cf-ray');
  headers.delete('cf-ipcountry');
  const cf = request.cf || {};
  headers.set('x-forwarded-for', (cf && cf.clientIp) || '0.0.0.0');
  headers.set('x-forwarded-proto', 'https');
  return headers;
}

async function proxyToRender(request) {
  const url = new URL(request.url);
  const target = RENDER_API_URL.replace(/\/+$/, '') + url.pathname + url.search;
  const method = request.method;
  const init = { method, headers: forwardHeaders(request), redirect: 'manual' };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = request.body;
  }
  const upstream = await fetch(target, init);
  // Re-emit Set-Cookie without any Domain attribute so the browser stores
  // the session on THIS origin (priv-spaca.pages.dev).
  const out = new Headers(upstream.headers);
  const rawCookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
  out.delete('set-cookie');
  for (const raw of rawCookies) {
    const cleaned = String(raw)
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !/^domain=/i.test(part))
      .join('; ');
    if (cleaned) out.append('set-cookie', cleaned);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/');

    if (isApi) {
      try {
        return await proxyToRender(request);
      } catch (e) {
        // Network-level failure only (Render down / cold / DNS).
        console.error('[worker] Render backend unreachable:', e && e.message);
        return new Response(JSON.stringify({
          error: 'The service is temporarily unavailable. Please retry shortly.',
          success: false,
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    }

    if (isBlockedAssetPath(url.pathname)) {
      return new Response('Not found', { status: 404 });
    }

    // Static frontend files are served by Cloudflare Pages Assets.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
