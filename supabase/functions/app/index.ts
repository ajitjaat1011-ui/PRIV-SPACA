// @ts-nocheck
// PRIV SPACA — Supabase edge function entry (v182)
//
// Serves the whole app from ONE function:
//   /              → embedded static site (gzip'd base64 in assets-b64.ts)
//   /api/*         → the Hono API (bundled from api/cf-worker.js)
//
// The runtime hands us the path WITH the function prefix (/app/...), so we
// strip it for both static lookup and the Hono request URL (Hono routes are
// registered as /api/...).

import apiApp from './worker-bundle.js';
import { ASSETS } from './assets-b64.ts';

// ---------- static asset serving ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const _gunzipCache = new Map<string, Uint8Array>();

function mimeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME[path.slice(dot).toLowerCase()] || 'application/octet-stream';
}

async function serveAsset(path: string): Promise<Response | null> {
  let key = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  if (!key || key.includes('..')) return null;
  // never serve internals
  if (key === 'index.ts' || key === 'worker-bundle.js' || key === 'assets-b64.ts' || key === 'config.toml') return null;
  const b64 = ASSETS.get(key);
  if (b64 === undefined) return null;
  let raw = _gunzipCache.get(key);
  if (!raw) {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([bin]).stream().pipeThrough(ds);
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
    _gunzipCache.set(key, raw);
  }
  const isIndex = key === 'index.html';
  return new Response(raw, {
    status: 200,
    headers: {
      'Content-Type': mimeFor(key),
      'Content-Length': String(raw.length),
      // index.html must never be cached stale (it carries the ?v= keys);
      // versioned assets are immutable.
      'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
    },
  });
}

// ---------- env for the Hono app ----------

function envForRequest(req: Request): Record<string, string> {
  // The public base this function is reached at: <SUPABASE_URL>/functions/v1/app
  const publicBase = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '') + '/functions/v1/app';
  return {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') || '',
    SUPABASE_SERVICE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    SUPABASE_DB_URL: Deno.env.get('SUPABASE_DB_URL') || '',
    FIELD_KEY: Deno.env.get('FIELD_KEY') || '',
    JWT_SECRET: Deno.env.get('JWT_SECRET') || '',
    APP_MIN_VERSION: Deno.env.get('APP_MIN_VERSION') || '',
    PS_BASE_PATH: '/functions/v1/app',
    PS_PUBLIC_BASE: publicBase,
    // legacy GitHub fields left empty (optional media fallback only).
    GITHUB_PAT: '',
    GH_REPO: '',
    GH_BRANCH: '',
    MEDIA_PUBLIC_BASE_URL: '',
    SECRET: '',
  };
}

// ---------- main ----------

Deno.serve(async (req: Request) => {
  try {
    let p = new URL(req.url).pathname;
    // strip the function mount prefix: /app/api/feed → /api/feed
    if (p === '/app') p = '/';
    else if (p.startsWith('/app/')) p = p.slice('/app'.length);

    const env = envForRequest(req);

    // API first (any method)
    if (p.startsWith('/api/')) {
      const u = new URL(req.url);
      u.pathname = p;
      const apiReq = new Request(u.toString(), req);
      return apiApp.fetch(apiReq, env, { waitUntil: (fn: Promise<unknown>) => (req as any).context?.waitUntil?.(fn) } as any);
    }

    // Static site (GET/HEAD only; POST /api handled above)
    if (req.method === 'GET' || req.method === 'HEAD') {
      const res = await serveAsset(p);
      if (res) return res;
    }

    // SPA fallback: unknown non-API GET → index.html (deep links)
    if (req.method === 'GET' && !p.includes('.')) {
      const res = await serveAsset('/');
      if (res) return res;
    }

    const err = new Response(JSON.stringify({ error: 'Not found', path: p }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
    return err;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Internal error', detail: String(e && e.message || e).slice(0, 200) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
});
