import app from './api/cf-worker.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API routes are handled by the Hono backend.
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }

    // Static frontend files are served by Cloudflare Pages Assets.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};
