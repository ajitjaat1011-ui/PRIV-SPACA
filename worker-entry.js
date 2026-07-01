/**
 * PRIV SPACA — Cloudflare Worker entry point
 * Serves static frontend files + delegates /api/* to the Hono backend
 */

import app from './api/cf-worker.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes → Hono backend (Neon DB, GitHub sync, JWT auth, SSE, RTC, etc.)
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }

    // Static frontend → Cloudflare Pages Assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    // Fallback
    return new Response('Not found', { status: 404 });
  }
};
