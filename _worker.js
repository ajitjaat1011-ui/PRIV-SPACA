import app, { runAndStoreDiagnostics } from './api/cf-worker.js';

function isBlockedAssetPath(pathname) {
  if (!pathname || pathname === '/') return false;
  const exact = new Set([
    '/README.md',
    '/THIRD_PARTY_API_AUDIT.md',
    '/SECURITY_AUDIT_2026-07-02.md',
    '/package.json',
    '/package-lock.json',
    '/wrangler.toml',
    '/dev-server.js',
    '/.cloudflareignore',
    '/.vercelignore',
  ]);
  if (exact.has(pathname)) return true;
  return pathname.startsWith('/backups/')
    || pathname.startsWith('/scripts/')
    || pathname.startsWith('/SECURITY_AUDIT')
    || pathname.startsWith('/.git')
    || pathname.startsWith('/.github/');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes are handled by the Hono backend.
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
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

  async scheduled(event, env, ctx) {
    // Periodic health / diagnostics run. Stores detected problems in Turso
    // so the agent (or an admin) can inspect them without needing a live server.
    try {
      await runAndStoreDiagnostics();
      console.log('[scheduled] diagnostics run completed');
    } catch (e) {
      console.error('[scheduled] diagnostics run failed:', e && e.message);
    }
  }
};
