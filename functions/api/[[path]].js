/**
 * Cloudflare Pages Function — catch-all /api/* handler.
 * Delegates to the Hono app exported from api/cf-worker.js.
 */
import app from '../../api/cf-worker.js';

export const onRequest = async (context) => {
  return app.fetch(context.request, context.env, context);
};
