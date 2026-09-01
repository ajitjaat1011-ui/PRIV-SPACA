/**
 * PRIV SPACA — Global middleware registration
 *
 * Registered BEFORE any route module is imported — Hono composes handlers in
 * registration order, so middleware added after a route would not wrap it.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from './app.js';
import { applyCors, isAllowedCorsOrigin, isDefaultJwtSecret, isProductionRequest, loadConfig } from './config.js';
import { globalRateLimit } from './ratelimit.js';
import { runWithTursoRequestScope } from './store-turso.js';

// ---------- Middleware: per-request Turso client scope (must run first — see
// the v75-turso-per-request-client-fix comment above tursoClient()) ----------
app.use('*', async (c, next) => {
  await runWithTursoRequestScope(next);
});

// ---------- Middleware: load config + security headers + global rate limit ----------
app.use('*', async (c, next) => {
  loadConfig(c.env);
  applyCors(c);
  if (c.req.method === 'OPTIONS') {
    const origin = c.req.header('origin') || '';
    return isAllowedCorsOrigin(origin) ? c.body(null, 204) : c.text('CORS origin denied', 403);
  }
  const origin = c.req.header('origin') || '';
  if (origin && !isAllowedCorsOrigin(origin)) return c.json({ error: 'CORS origin denied' }, 403);
  if (isProductionRequest(c) && isDefaultJwtSecret() && c.req.path.startsWith('/api/') && !['/api/health', '/api/stream/config', '/api/push/vapid-public'].includes(c.req.path)) {
    return c.json({ error: 'Server auth secret is not configured' }, 503);
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  await next();
});

app.use('/api/*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  const len = Number(c.req.header('content-length') || '0');
  // Keep API-agent friendly JSON access, but reject unexpectedly huge bodies early.
  if (['POST','PUT','PATCH'].includes(method) && len > 16 * 1024 * 1024) {
    return c.json({ error: 'Request body too large' }, 413);
  }
  await next();
});

app.use('/api/*', globalRateLimit);
