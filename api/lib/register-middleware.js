/**
 * PRIV SPACA — Global middleware registration
 *
 * Registered BEFORE any route module is imported — Hono composes handlers in
 * registration order, so middleware added after a route would not wrap it.
 *
 * CHAIN ORDER (outermost first) — each layer depends on the one above it:
 *   1. Turso request scope   per-request DB client (must be first)
 *   2. Correlation id        every later log line and error carries requestId
 *   3. Error interceptor     wraps everything below, so any throw becomes JSON
 *   4. Config + CORS + headers
 *   5. Body size cap
 *   6. Load shedding         rejects early when this isolate is saturated
 *   7. Global rate limit
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from './app.js';
import { applyCors, isAllowedCorsOrigin, isDefaultJwtSecret, isProductionRequest, loadConfig } from './config.js';
import { AppError, ErrorCodes, errorBody, handleError, handleNotFound } from './errors.js';
import { globalRateLimit } from './ratelimit.js';
import { admit, log, requestId } from './resilience.js';
import { applySecurityHeaders } from './security-headers.js';
import { runWithTursoRequestScope } from './store-turso.js';

// ---------- Global error interceptor ----------
// Hono's onError catches anything thrown by a handler or middleware, sync or
// async. This is the Workers equivalent of Node's uncaughtException /
// unhandledRejection: there is no `process` here, and because each request runs
// in an isolate a throw can only ever kill that one request, never "the
// server". What this guarantees is that the client always gets a well-formed
// JSON body with no stack trace instead of Hono's default text/plain 500.
app.onError(handleError);
app.notFound(handleNotFound);

// ---------- Middleware: per-request Turso client scope (must run first — see
// the v75-turso-per-request-client-fix comment above tursoClient()) ----------
app.use('*', async (c, next) => {
  await runWithTursoRequestScope(next);
});

// ---------- Middleware: correlation id + request logging ----------
app.use('*', async (c, next) => {
  const rid = requestId(c);
  c.set('requestId', rid);
  c.set('startedAt', Date.now());
  // Echo it back so a user reporting a problem can quote an id we can grep.
  c.header('X-Request-Id', rid);
  await next();
});

// ---------- Middleware: load config + CORS + security headers ----------
app.use('*', async (c, next) => {
  loadConfig(c.env);
  applyCors(c);

  const url = new URL(c.req.url);
  const isSecure = url.protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
  const isApi = c.req.path.startsWith('/api/');

  // Headers are applied BEFORE the early returns below so that CORS denials,
  // 503s and OPTIONS replies are protected too — a header you only set on the
  // happy path is a header an attacker can dodge by provoking an error.
  applySecurityHeaders(c, { isApi, isSecure });

  if (c.req.method === 'OPTIONS') {
    const origin = c.req.header('origin') || '';
    return isAllowedCorsOrigin(origin) ? c.body(null, 204) : c.text('CORS origin denied', 403);
  }

  const origin = c.req.header('origin') || '';
  if (origin && !isAllowedCorsOrigin(origin)) {
    return c.json(errorBody(ErrorCodes.FORBIDDEN, 'CORS origin denied.', { requestId: c.get('requestId') }), 403);
  }

  if (isProductionRequest(c) && isDefaultJwtSecret() && isApi &&
      !['/api/health', '/api/ready', '/api/stream/config', '/api/push/vapid-public'].includes(c.req.path)) {
    return c.json(
      errorBody(ErrorCodes.INTERNAL, 'Server auth secret is not configured.', { requestId: c.get('requestId') }),
      503
    );
  }

  await next();
});

// ---------- Middleware: request body size cap ----------
app.use('/api/*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  const len = Number(c.req.header('content-length') || '0');
  // Keep API-agent friendly JSON access, but reject unexpectedly huge bodies early.
  if (['POST', 'PUT', 'PATCH'].includes(method) && len > 16 * 1024 * 1024) {
    throw new AppError(ErrorCodes.PAYLOAD_TOO_LARGE, 'Request body too large.');
  }
  await next();
});

// ---------- Middleware: adaptive load shedding ----------
// Sheds with 503 when this isolate already has too much in flight. Health and
// readiness probes are exempt (see NEVER_SHED) so monitoring still works while
// we are shedding — otherwise the outage would hide itself.
app.use('/api/*', async (c, next) => {
  const release = admit(c);
  try {
    await next();
  } finally {
    release();
  }
});

// ---------- Middleware: access log ----------
// Emitted after the response so it can carry status and duration. Health checks
// are skipped to keep the log signal-to-noise reasonable.
app.use('/api/*', async (c, next) => {
  await next();
  const path = c.req.path;
  if (path === '/api/health' || path === '/api/ready') return;
  const startedAt = c.get('startedAt');
  const status = c.res ? c.res.status : 0;
  // Only log slow or failed requests; successful fast ones are just volume.
  const ms = startedAt ? Date.now() - startedAt : undefined;
  if (status >= 400 || (ms !== undefined && ms > 1500)) {
    log(status >= 500 ? 'error' : 'warn', 'request', {
      requestId: c.get('requestId'),
      method: c.req.method,
      path,
      status,
      ms,
    });
  }
});

app.use('/api/*', globalRateLimit);
