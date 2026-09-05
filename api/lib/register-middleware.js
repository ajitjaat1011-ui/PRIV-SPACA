/**
 * PRIV SPACA — global middleware registration.
 * Imported before every route module; registration order is intentional.
 */

import { app } from './app.js';
import { applyCors, isAllowedCorsOrigin, isDefaultJwtSecret, isProductionRequest, loadConfig } from './config.js';
import { AppError, ErrorCodes, errorBody, handleError, handleNotFound } from './errors.js';
import { omniMiddleware } from './omni-engine.js';
import { globalRateLimit } from './ratelimit.js';
import { accessLog, requestId } from './resilience.js';
import { applySecurityHeaders } from './security-headers.js';
import { runWithTursoRequestScope } from './store-turso.js';

app.onError(handleError);
app.notFound(handleNotFound);

// Must be outermost: every request gets a request-scoped libSQL client.
app.use('*', (c, next) => runWithTursoRequestScope(next));

// Unique cryptographic trace at API entry. A valid client-generated id is
// preserved end-to-end; otherwise the Worker creates one.
app.use('/api/*', async (c, next) => {
  const correlationId = requestId(c);
  c.set('requestId', correlationId); // legacy alias
  c.set('correlationId', correlationId);
  c.set('startedAt', Date.now());
  await next();
  c.header('X-Correlation-ID', correlationId);
  c.header('X-Request-Id', correlationId);
});

// Config, CORS and defence headers execute before every early return.
app.use('*', async (c, next) => {
  loadConfig(c.env);
  applyCors(c);
  const url = new URL(c.req.url);
  const isSecure = url.protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
  const isApi = c.req.path.startsWith('/api/');
  applySecurityHeaders(c, { isApi, isSecure });

  if (c.req.method === 'OPTIONS') {
    const origin = c.req.header('origin') || '';
    return isAllowedCorsOrigin(origin) ? c.body(null, 204) : c.text('CORS origin denied', 403);
  }
  const origin = c.req.header('origin') || '';
  if (origin && !isAllowedCorsOrigin(origin)) {
    return c.json(errorBody(ErrorCodes.FORBIDDEN, 'CORS origin denied.', {
      requestId: c.get('requestId'), correlationId: c.get('correlationId'),
    }), 403);
  }
  if (isProductionRequest(c) && isDefaultJwtSecret() && isApi &&
      !['/api/health', '/api/ready', '/api/stream/config', '/api/push/vapid-public'].includes(c.req.path)) {
    return c.json(errorBody(ErrorCodes.INTERNAL, 'Server auth secret is not configured.', {
      requestId: c.get('requestId'), correlationId: c.get('correlationId'),
    }), 503);
  }
  await next();
});

app.use('/api/*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  const len = Number(c.req.header('content-length') || '0');
  if (['POST', 'PUT', 'PATCH'].includes(method) && len > 16 * 1024 * 1024) {
    throw new AppError(ErrorCodes.PAYLOAD_TOO_LARGE, 'Request body too large.');
  }
  await next();
});

app.use('/api/*', accessLog({ successSampleRate: 0.04, slowMs: 1000 }));

// Primary request-control plane: deterministic tiering, token buckets,
// partitioned pools, stale serving and progressive shedding.
app.use('/api/*', omniMiddleware());

// Tier 0 bypasses the ordinary global load limiter, but auth endpoints retain
// authRateLimit/authSubjectRateLimit and account lockout in their route chain.
app.use('/api/*', async (c, next) => {
  if (c.get('omniTier') === 'critical') return next();
  return globalRateLimit(c, next);
});
