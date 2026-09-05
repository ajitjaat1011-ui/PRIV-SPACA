/**
 * PRIV SPACA — Omni-Engine request control plane.
 *
 * This is a Cloudflare-compatible traffic slicer, admission controller,
 * degradation ladder, fault-domain supervisor and correlation context. It is
 * intentionally isolate-local: Workers provide no master process, no shared
 * in-memory scheduler and no supported force-restart primitive.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError, ErrorCodes, errorBody, registerFatalFlusher, wrapUnexpected } from './errors.js';
import {
  circuitSnapshot,
  isTransientError,
  logEvent,
  resetCircuitBreakers,
  retryWithJitter,
  withBreaker,
  withTimeout,
} from './resilience.js';

export const OMNI_TIERS = Object.freeze({ CRITICAL: 0, STANDARD: 1, BACKGROUND: 2 });
const TIER_NAMES = Object.freeze(['critical', 'standard', 'background']);
const engineStartedAt = Date.now();
const contextStore = new AsyncLocalStorage();

const scheduler = {
  inFlight: [0, 0, 0],
  queues: [[], [], []],
  domainRunning: new Map(),
  userRunning: new Map(),
  ipRunning: new Map(),
  observations: [],
  eventLoopDelayMs: 0,
  memoryRatio: null,
  sampleCounter: 0,
  admitted: [0, 0, 0],
  rejected: [0, 0, 0],
  staleServed: 0,
  backgroundDropped: 0,
};

const userBuckets = new Map();
const ipBuckets = new Map();
const staleResponses = new Map();
const externalBulkheads = new Map();

const BASE_LIMITS = Object.freeze({
  nonCritical: 24,
  standard: 22,
  background: 4,
  media: 2,
  database: 12,
  user: 6,
  ip: 12,
});

const DOMAIN_LIMITS = Object.freeze({
  'database.turso': 12,
  'database.github': 2,
  'database.fallback': 2,
  'media.cloudinary': 2,
  'media.github': 2,
  'scraping.preview': 2,
  'push.gateway': 4,
  'stream.poller': 4,
});

const STANDARD_MUTATION = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const STALE_MAX_AGE_MS = 2 * 60_000;
const STALE_MAX_ENTRIES = 200;

function count(map, key) {
  return map.get(key) || 0;
}

function increment(map, key) {
  map.set(key, count(map, key) + 1);
}

function decrement(map, key) {
  const next = count(map, key) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function safePath(path) {
  const value = String(path || '/');
  return value.startsWith('/api/') ? value.slice(4) : value;
}

/** Deterministic route-to-service-class mapping. */
export function classifyRequest(path, method = 'GET') {
  const p = safePath(path).split('?')[0];
  const m = String(method || 'GET').toUpperCase();

  if (p === '/health' || p === '/ready' || p === '/diag') return { tier: 0, name: 'critical', domain: 'operations' };
  if (p.startsWith('/auth/')) return { tier: 0, name: 'critical', domain: 'auth', securityLimited: true };
  if (p.startsWith('/rtc/')) return { tier: 0, name: 'critical', domain: 'webrtc' };
  if (p === '/stream' || p === '/stream/token') return { tier: 0, name: 'critical', domain: 'realtime-stream' };
  if (p === '/messages' || p === '/messages/send') return { tier: 0, name: 'critical', domain: 'chat' };
  if (p === '/user/typing' || p === '/user/heartbeat') return { tier: 0, name: 'critical', domain: 'presence' };

  if (p === '/messages/read' || p === '/messages/read-batch') return { tier: 2, name: 'background', domain: 'read-receipts' };
  if (/^\/stories\/[^/]+\/view$/.test(p) && m === 'POST') return { tier: 2, name: 'background', domain: 'story-analytics' };
  if (p === '/notifications/seen' || p.startsWith('/push/') || p.startsWith('/omni/')) {
    return { tier: 2, name: 'background', domain: p.startsWith('/push/') ? 'push' : 'telemetry' };
  }
  if (p === '/upload-media' || p === '/upload-photo') return { tier: 1, name: 'standard', domain: 'media' };
  if (p.startsWith('/feed') || p.startsWith('/posts') || p.startsWith('/stories') || p.startsWith('/user') || p === '/users' || p.startsWith('/notifications')) {
    return { tier: 1, name: 'standard', domain: 'standard-ui' };
  }
  return { tier: 1, name: 'standard', domain: 'standard-ui' };
}

function decodeSubject(c) {
  const auth = c.req.header('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const payload = token.split('.')[1];
  if (payload) {
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
      const parsed = JSON.parse(globalThis.atob(normalized));
      if (typeof parsed.uid === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(parsed.uid)) return `u:${parsed.uid}`;
    } catch (_) {}
  }
  return auth ? `t:${hashString(auth)}` : 'anonymous';
}

function requestIp(c) {
  return String(
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-real-ip') ||
    c.req.header('x-forwarded-for') ||
    'unknown',
  ).split(',')[0].trim().slice(0, 96);
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function bucketFor(map, key, rate, burst, now) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { tokens: burst, updatedAt: now, lastSeenAt: now, rate, burst };
    map.set(key, bucket);
  }
  const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + elapsed * bucket.rate);
  bucket.updatedAt = now;
  bucket.lastSeenAt = now;
  return bucket;
}

async function consumeTokenBuckets(meta) {
  const now = Date.now();
  const rate = meta.tier === 2 ? 4 : 12;
  const burst = meta.tier === 2 ? 8 : 24;
  const ipRate = meta.tier === 2 ? 8 : 30;
  const ipBurst = meta.tier === 2 ? 16 : 60;
  const userBucket = bucketFor(userBuckets, meta.subject, rate, burst, now);
  const ipBucket = bucketFor(ipBuckets, meta.ip, ipRate, ipBurst, now);

  if (userBucket.tokens >= 1 && ipBucket.tokens >= 1) {
    userBucket.tokens--;
    ipBucket.tokens--;
    return;
  }

  const userWait = userBucket.tokens >= 1 ? 0 : ((1 - userBucket.tokens) / userBucket.rate) * 1000;
  const ipWait = ipBucket.tokens >= 1 ? 0 : ((1 - ipBucket.tokens) / ipBucket.rate) * 1000;
  const waitMs = Math.ceil(Math.max(userWait, ipWait));
  // Background/speculative work is dropped instead of creating a retry herd.
  if (meta.tier === 2 || waitMs > 250) {
    throw new AppError(ErrorCodes.RATE_LIMITED, 'Omni token bucket exhausted.', {
      safeMessage: 'Too many requests. Please retry shortly.',
      status: 429,
      meta: { retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)), scope: 'omni-token-bucket' },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, waitMs)));
  const later = Date.now();
  const refreshedUser = bucketFor(userBuckets, meta.subject, rate, burst, later);
  const refreshedIp = bucketFor(ipBuckets, meta.ip, ipRate, ipBurst, later);
  if (refreshedUser.tokens < 1 || refreshedIp.tokens < 1) {
    throw new AppError(ErrorCodes.RATE_LIMITED, 'Omni token bucket exhausted after defer.', {
      safeMessage: 'Too many requests. Please retry shortly.', status: 429,
    });
  }
  refreshedUser.tokens--;
  refreshedIp.tokens--;
}

function pruneLocalState(now = Date.now()) {
  for (const [key, bucket] of userBuckets) if (now - bucket.lastSeenAt > 60_000) userBuckets.delete(key);
  for (const [key, bucket] of ipBuckets) if (now - bucket.lastSeenAt > 60_000) ipBuckets.delete(key);
  for (const [key, entry] of staleResponses) if (now - entry.storedAt > STALE_MAX_AGE_MS) staleResponses.delete(key);
  while (staleResponses.size > STALE_MAX_ENTRIES) staleResponses.delete(staleResponses.keys().next().value);
}

function sampleRuntimeSignals() {
  scheduler.sampleCounter++;
  if ((scheduler.sampleCounter & 31) !== 0) return;
  const started = performance.now();
  setTimeout(() => {
    const rawDelay = Math.max(0, performance.now() - started);
    // Isolate suspension/cold resume is not sustained event-loop pressure.
    const delay = rawDelay > 5000 ? 0 : Math.min(rawDelay, 1000);
    scheduler.eventLoopDelayMs = scheduler.eventLoopDelayMs
      ? (scheduler.eventLoopDelayMs * 0.75) + (delay * 0.25)
      : delay;
    const memory = globalThis.performance?.memory;
    scheduler.memoryRatio = memory?.jsHeapSizeLimit
      ? memory.usedJSHeapSize / memory.jsHeapSizeLimit
      : null;
  }, 0);
  if ((scheduler.sampleCounter & 127) === 0) pruneLocalState();
}

function recentStats(now = Date.now()) {
  const cutoff = now - 10_000;
  while (scheduler.observations.length && scheduler.observations[0].at < cutoff) scheduler.observations.shift();
  const durations = scheduler.observations.map((o) => o.durationMs).sort((a, b) => a - b);
  const failures = scheduler.observations.reduce((n, o) => n + (o.failed ? 1 : 0), 0);
  return {
    samples: durations.length,
    p95Ms: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0,
    failureRate: durations.length ? failures / durations.length : 0,
  };
}

function currentLoad() {
  const nonCritical = scheduler.inFlight[1] + scheduler.inFlight[2];
  const queued = scheduler.queues[1].length + scheduler.queues[2].length;
  const concurrencyRatio = (nonCritical + queued) / BASE_LIMITS.nonCritical;
  const eventLoopRatio = scheduler.eventLoopDelayMs / 50;
  const memoryRatio = scheduler.memoryRatio || 0;
  const recent = recentStats();
  const latencyRatio = recent.p95Ms / 2000;
  const ratio = Math.max(concurrencyRatio, eventLoopRatio * 0.75, memoryRatio, latencyRatio * 0.6);

  let step = 0;
  if (concurrencyRatio >= 0.75 || scheduler.eventLoopDelayMs > 50 || memoryRatio > 0.85 || latencyRatio > 1) step = 1;
  if (concurrencyRatio >= 0.85 || scheduler.eventLoopDelayMs > 100 || memoryRatio > 0.90 || latencyRatio > 2) step = 2;
  if (concurrencyRatio >= 0.95 || scheduler.eventLoopDelayMs > 200 || memoryRatio > 0.95 || latencyRatio > 4) step = 3;
  return { ratio, step, concurrencyRatio, eventLoopDelayMs: scheduler.eventLoopDelayMs, memoryRatio: scheduler.memoryRatio, recent };
}

function dynamicLimits(load) {
  if (load.step >= 3) return { standard: 6, background: 0, nonCritical: 6 };
  if (load.step === 2) return { standard: 10, background: 1, nonCritical: 11 };
  if (load.step === 1) return { standard: 17, background: 2, nonCritical: 18 };
  return { standard: BASE_LIMITS.standard, background: BASE_LIMITS.background, nonCritical: BASE_LIMITS.nonCritical };
}

function domainLimit(meta, load) {
  if (meta.domain === 'media') return Math.min(BASE_LIMITS.media, dynamicLimits(load).standard);
  if (meta.tier === 2) return dynamicLimits(load).background;
  return dynamicLimits(load).standard;
}

function canRun(meta) {
  const load = currentLoad();
  const limits = dynamicLimits(load);
  const nonCritical = scheduler.inFlight[1] + scheduler.inFlight[2];
  const userLimit = Math.min(BASE_LIMITS.user, Math.max(2, Math.ceil(limits.nonCritical / 4)));
  const ipLimit = Math.min(BASE_LIMITS.ip, Math.max(3, Math.ceil(limits.nonCritical / 2)));
  return nonCritical < limits.nonCritical &&
    scheduler.inFlight[meta.tier] < (meta.tier === 1 ? limits.standard : limits.background) &&
    count(scheduler.domainRunning, meta.domain) < domainLimit(meta, load) &&
    count(scheduler.userRunning, meta.subject) < userLimit &&
    count(scheduler.ipRunning, meta.ip) < ipLimit;
}

function startSlot(meta) {
  scheduler.inFlight[meta.tier]++;
  scheduler.admitted[meta.tier]++;
  increment(scheduler.domainRunning, meta.domain);
  increment(scheduler.userRunning, meta.subject);
  increment(scheduler.ipRunning, meta.ip);
}

function releaseSlot(meta) {
  scheduler.inFlight[meta.tier] = Math.max(0, scheduler.inFlight[meta.tier] - 1);
  decrement(scheduler.domainRunning, meta.domain);
  decrement(scheduler.userRunning, meta.subject);
  decrement(scheduler.ipRunning, meta.ip);
  drainQueues();
}

function drainTier(tier) {
  const queue = scheduler.queues[tier];
  let progressed = true;
  while (progressed && queue.length) {
    progressed = false;
    const now = Date.now();
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      if (entry.deadline <= now) {
        queue.splice(i--, 1);
        clearTimeout(entry.timer);
        scheduler.rejected[tier]++;
        entry.reject(new AppError(ErrorCodes.OVERLOADED, 'Omni queue deadline exceeded.', {
          safeMessage: 'The service is busy. Please retry shortly.', status: 503,
        }));
        progressed = true;
        continue;
      }
      if (!canRun(entry.meta)) continue;
      queue.splice(i, 1);
      clearTimeout(entry.timer);
      startSlot(entry.meta);
      entry.resolve(() => releaseSlot(entry.meta));
      progressed = true;
      break;
    }
  }
}

function drainQueues() {
  // Absolute queued priority: standard work is always considered before
  // background/speculative work. Tier 0 never enters either queue.
  drainTier(1);
  drainTier(2);
}

function queueSlot(meta) {
  if (canRun(meta)) {
    startSlot(meta);
    return Promise.resolve(() => releaseSlot(meta));
  }
  const queue = scheduler.queues[meta.tier];
  const maxQueue = meta.tier === 1 ? 256 : 64;
  if (queue.length >= maxQueue) {
    scheduler.rejected[meta.tier]++;
    throw new AppError(ErrorCodes.OVERLOADED, 'Omni queue is full.', {
      safeMessage: 'The service is busy. Please retry shortly.', status: 503,
    });
  }
  const timeoutMs = meta.tier === 1 ? 4000 : 1000;
  return new Promise((resolve, reject) => {
    const entry = { meta, resolve, reject, deadline: Date.now() + timeoutMs, timer: null };
    entry.timer = setTimeout(() => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      scheduler.rejected[meta.tier]++;
      reject(new AppError(ErrorCodes.OVERLOADED, 'Omni queue timed out.', {
        safeMessage: 'The service is busy. Please retry shortly.', status: 503,
      }));
    }, timeoutMs);
    queue.push(entry);
  });
}

function cacheKey(c, meta) {
  // Never key stale authenticated data only by the unverified JWT uid used for
  // fair scheduling; bind it to the full bearer token fingerprint instead.
  const authorization = c.req.header('authorization') || '';
  const principal = authorization ? `token:${hashString(authorization)}` : meta.subject;
  return `${c.req.method}:${c.req.url}:${principal}`;
}

function staleResponseFor(c, meta) {
  if (c.req.method !== 'GET' || meta.tier !== 1) return null;
  const entry = staleResponses.get(cacheKey(c, meta));
  if (!entry || Date.now() - entry.storedAt > STALE_MAX_AGE_MS) return null;
  const headers = new Headers(entry.headers);
  headers.set('Warning', '110 - "Response is stale"');
  headers.set('X-Omni-Degraded', 'stale-tier-1');
  headers.set('X-Omni-Stale-Age', String(Math.floor((Date.now() - entry.storedAt) / 1000)));
  return new Response(entry.body, { status: entry.status, headers });
}

async function storeStaleResponse(c, meta) {
  if (c.req.method !== 'GET' || meta.tier !== 1 || !c.res || c.res.status !== 200) return;
  const type = c.res.headers.get('content-type') || '';
  if (!type.includes('application/json')) return;
  const clone = c.res.clone();
  const body = await clone.text();
  if (body.length > 1_000_000) return;
  const headers = [...clone.headers.entries()].filter(([key]) => !['set-cookie', 'content-length'].includes(key.toLowerCase()));
  staleResponses.delete(cacheKey(c, meta));
  staleResponses.set(cacheKey(c, meta), { body, headers, status: clone.status, storedAt: Date.now() });
  pruneLocalState();
}

function errorCodeForStatus(status) {
  if (status === 400) return ErrorCodes.VALIDATION;
  if (status === 401) return ErrorCodes.AUTH_REQUIRED;
  if (status === 403) return ErrorCodes.FORBIDDEN;
  if (status === 404) return ErrorCodes.NOT_FOUND;
  if (status === 409) return ErrorCodes.CONFLICT;
  if (status === 413) return ErrorCodes.PAYLOAD_TOO_LARGE;
  if (status === 426) return ErrorCodes.UPGRADE_REQUIRED;
  if (status === 501) return ErrorCodes.NOT_CONFIGURED;
  if (status === 429) return ErrorCodes.RATE_LIMITED;
  if ([502, 503, 504].includes(status)) return status === 504 ? ErrorCodes.UPSTREAM_TIMEOUT : ErrorCodes.UPSTREAM_UNAVAILABLE;
  return status >= 500 ? ErrorCodes.INTERNAL : ErrorCodes.VALIDATION;
}

async function normalizeErrorResponse(c) {
  if (!c.res || c.res.status < 400) return;
  const original = c.res;
  const type = original.headers.get('content-type') || '';
  if (!type.includes('json')) return;
  let data;
  try { data = await original.clone().json(); } catch (_) { return; }
  if (data && data.error_domain && data.safe_user_msg && typeof data.retryable === 'boolean') return;
  const message = String(data?.safe_user_msg || data?.error || data?.message || 'Request failed.').slice(0, 500);
  const diagnostic = errorBody(errorCodeForStatus(original.status), message, {
    requestId: c.get('requestId'),
    correlationId: c.get('correlationId'),
    meta: data,
  });
  const headers = new Headers(original.headers);
  headers.set('Content-Type', 'application/json; charset=UTF-8');
  c.res = new Response(JSON.stringify({ ...(data || {}), ...diagnostic }), { status: original.status, headers });
}

function backgroundDropResponse(c, meta, load) {
  scheduler.backgroundDropped++;
  scheduler.rejected[2]++;
  c.set('omniDegraded', true);
  return c.json({
    ok: true,
    deferred: true,
    dropped: true,
    tier: meta.name,
    reason: 'load_shed',
    retryable: false,
    correlation_id: c.get('correlationId'),
  }, 202);
}

async function dispatch(c, next) {
  sampleRuntimeSignals();
  const baseClass = classifyRequest(c.req.path, c.req.method);
  const speculative = c.req.header('x-omni-intent') === 'speculative'
    && (baseClass.tier !== 0 || c.req.path === '/api/auth/me');
  const classified = speculative
    ? { tier: 2, name: 'background', domain: 'predictive-prerender' }
    : baseClass;
  const meta = { ...classified, subject: decodeSubject(c), ip: requestIp(c) };
  c.set('omniTier', meta.name);
  c.set('omniDomain', meta.domain);

  // Tier 0 has no scheduler/token-bucket await and is never load-shed. Auth's
  // durable brute-force/login limits still run in the route middleware.
  if (meta.tier === 0) {
    scheduler.inFlight[0]++;
    scheduler.admitted[0]++;
    const started = Date.now();
    try {
      await next();
      await normalizeErrorResponse(c);
    } finally {
      scheduler.inFlight[0] = Math.max(0, scheduler.inFlight[0] - 1);
      scheduler.observations.push({ at: Date.now(), durationMs: Date.now() - started, failed: (c.res?.status || 500) >= 500, tier: 0 });
    }
    const load = currentLoad();
    c.set('omniLoadStep', load.step);
    applyResponseHeaders(c, meta, load);
    return;
  }

  const initialLoad = currentLoad();
  c.set('omniLoadStep', initialLoad.step);
  if (meta.tier === 2 && initialLoad.step >= 1) {
    c.res = backgroundDropResponse(c, meta, initialLoad);
    applyResponseHeaders(c, meta, initialLoad);
    return;
  }

  if (meta.tier === 1 && STANDARD_MUTATION.has(c.req.method) && initialLoad.step >= 3) {
    scheduler.rejected[1]++;
    throw new AppError(ErrorCodes.OVERLOADED, 'Tier 1 mutation shed by Omni.', {
      safeMessage: 'The service is under heavy load. Please retry shortly.', status: 503,
      meta: { retryAfterSeconds: 2 },
    });
  }

  await consumeTokenBuckets(meta);
  const release = await queueSlot(meta);
  const started = Date.now();
  try {
    await next();
    await normalizeErrorResponse(c);
    let servedStale = false;
    // Stale personalized reads are only used after the route/auth chain ran;
    // serving before token validation could leak data from a revoked session.
    if (meta.tier === 1 && c.req.method === 'GET' && initialLoad.step >= 2 && (c.res?.status || 500) >= 500) {
      const stale = staleResponseFor(c, meta);
      if (stale) {
        scheduler.staleServed++;
        c.set('omniDegraded', true);
        c.res = stale;
        servedStale = true;
      }
    }
    if (!servedStale) await storeStaleResponse(c, meta);
  } finally {
    const status = c.res?.status || 500;
    scheduler.observations.push({ at: Date.now(), durationMs: Date.now() - started, failed: status >= 500, tier: meta.tier });
    release();
  }
  const finalLoad = currentLoad();
  c.set('omniLoadStep', finalLoad.step);
  applyResponseHeaders(c, meta, finalLoad);
}

function applyResponseHeaders(c, meta, load) {
  if (!c.res) return;
  c.header('X-Correlation-ID', c.get('correlationId') || c.get('requestId'));
  c.header('X-Request-Id', c.get('requestId'));
  c.header('X-Omni-Tier', `${meta.tier}:${meta.name}`);
  c.header('X-Omni-Domain', meta.domain);
  c.header('X-Omni-Load-Step', String(load.step));
}

export function runWithOmniContext(value, fn) {
  return contextStore.run(value, fn);
}

export function getOmniContext() {
  return contextStore.getStore() || null;
}

/** Primary Hono request-control middleware. */
export function omniMiddleware() {
  return async (c, next) => {
    let executionCtx = null;
    try { executionCtx = c.executionCtx; } catch (_) {}
    const value = {
      correlationId: c.get('correlationId') || c.get('requestId'),
      requestId: c.get('requestId'),
      path: c.req.path,
      method: c.req.method,
      executionCtx,
    };
    return runWithOmniContext(value, () => dispatch(c, next));
  };
}

function bulkheadLimit(name) {
  if (DOMAIN_LIMITS[name]) return DOMAIN_LIMITS[name];
  if (name.startsWith('database.')) return BASE_LIMITS.database;
  if (name.startsWith('media.')) return 2;
  if (name.startsWith('push.')) return 4;
  if (name.startsWith('scraping.')) return 2;
  return 4;
}

async function withBulkhead(name, fn, fallback) {
  let state = externalBulkheads.get(name);
  if (!state) {
    state = { running: 0, rejected: 0, completed: 0, failed: 0, max: bulkheadLimit(name) };
    externalBulkheads.set(name, state);
  }
  if (state.running >= state.max) {
    state.rejected++;
    const error = new AppError(ErrorCodes.OVERLOADED, `${name} bulkhead is full.`, {
      safeMessage: 'A dependency is busy. Please retry shortly.', status: 503, meta: { bulkhead: name },
    });
    if (fallback !== undefined) return typeof fallback === 'function' ? fallback(error) : fallback;
    throw error;
  }
  state.running++;
  try {
    const result = await fn();
    state.completed++;
    return result;
  } catch (error) {
    state.failed++;
    throw error;
  } finally {
    state.running--;
  }
}

/** Named bulkhead + rolling breaker + safe transient retry supervisor. */
export async function withFaultDomain(name, fn, {
  idempotent = false,
  timeoutMs = 6000,
  fallback,
  delays = [200, 800, 2000],
} = {}) {
  const parent = getOmniContext() || {};
  const run = () => runWithOmniContext({ ...parent, faultDomain: name }, () => withBreaker(name, () =>
    retryWithJitter(
      () => withTimeout(Promise.resolve().then(fn), timeoutMs, name),
      {
        idempotent,
        delays,
        retryable: isTransientError,
        onRetry: ({ attempt, delayMs, error }) => logEvent('warn', 'fault.retry', {
          correlationId: parent.correlationId,
          domain: name,
          attempt,
          delayMs,
          code: wrapUnexpected(error).code,
        }),
      },
    ), { fallback }),
  );
  try {
    return await withBulkhead(name, run, fallback);
  } catch (error) {
    const wrapped = wrapUnexpected(error);
    logEvent(wrapped.status >= 500 ? 'error' : 'warn', 'fault.failed', {
      correlationId: parent.correlationId,
      domain: name,
      code: wrapped.code,
      category: wrapped.category,
      retryable: isTransientError(wrapped),
    });
    throw error;
  }
}

/** Correlation-propagating outbound fetch boundary. */
export async function omniFetch(name, input, init = {}, options = {}) {
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  const context = getOmniContext();
  if (context?.correlationId) headers.set('X-Correlation-ID', context.correlationId);
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const idempotent = options.idempotent ?? ['GET', 'HEAD', 'OPTIONS'].includes(method);
  return withFaultDomain(name, async () => {
    const response = await fetch(input, { ...init, headers });
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      throw new AppError(ErrorCodes.UPSTREAM_UNAVAILABLE, `${name} returned HTTP ${response.status}.`, {
        safeMessage: 'A dependency is temporarily unavailable.', status: response.status === 504 ? 504 : 503,
        meta: { upstreamStatus: response.status, domain: name },
      });
    }
    return response;
  }, { ...options, idempotent });
}

/** Supervise waitUntil/background promises without unhandled rejections. */
export function supervisedTask(c, promise, label = 'background-task') {
  const context = getOmniContext() || { correlationId: c?.get?.('correlationId') };
  const guarded = Promise.resolve(promise).catch((error) => {
    const wrapped = wrapUnexpected(error);
    logEvent(wrapped.status >= 500 ? 'error' : 'warn', 'task.failed', {
      correlationId: context.correlationId,
      task: label,
      code: wrapped.code,
      category: wrapped.category,
    });
  });
  let executionCtx = context.executionCtx || null;
  if (!executionCtx && c) {
    try { executionCtx = c.executionCtx; } catch (_) {}
  }
  if (executionCtx && typeof executionCtx.waitUntil === 'function') executionCtx.waitUntil(guarded);
  return guarded;
}

export function omniSnapshot() {
  const load = currentLoad();
  const bulkheads = {};
  for (const [name, value] of externalBulkheads) bulkheads[name] = { ...value };
  return {
    engine: 'omni-engine',
    runtimeScope: 'cloudflare-isolate-local',
    timestamp: new Date().toISOString(),
    isolateUptimeMs: Date.now() - engineStartedAt,
    classification: {
      tiers: { 0: 'critical-realtime', 1: 'standard-ui', 2: 'background-speculative' },
      tier0Queue: false,
      tier0LoadShedding: false,
      authSecurityLimitsPreserved: true,
    },
    load: {
      ratio: Number(load.ratio.toFixed(3)),
      step: load.step,
      concurrencyRatio: Number(load.concurrencyRatio.toFixed(3)),
      eventLoopDelayMs: Number(load.eventLoopDelayMs.toFixed(2)),
      memoryRatio: load.memoryRatio == null ? null : Number(load.memoryRatio.toFixed(3)),
      memorySignalAvailable: load.memoryRatio != null,
      recent10s: { ...load.recent, failureRate: Number(load.recent.failureRate.toFixed(3)) },
    },
    scheduler: {
      inFlight: { critical: scheduler.inFlight[0], standard: scheduler.inFlight[1], background: scheduler.inFlight[2] },
      queued: { standard: scheduler.queues[1].length, background: scheduler.queues[2].length },
      admitted: { critical: scheduler.admitted[0], standard: scheduler.admitted[1], background: scheduler.admitted[2] },
      rejected: { critical: scheduler.rejected[0], standard: scheduler.rejected[1], background: scheduler.rejected[2] },
      activeUserPartitions: scheduler.userRunning.size,
      activeIpPartitions: scheduler.ipRunning.size,
      tokenBuckets: { users: userBuckets.size, ips: ipBuckets.size },
      staleEntries: staleResponses.size,
      staleServed: scheduler.staleServed,
      backgroundDropped: scheduler.backgroundDropped,
    },
    bulkheads,
    ...circuitSnapshot(),
    platformLimits: {
      masterProcess: false,
      forceWorkerRestartApi: false,
      sharedInMemoryQueueAcrossIsolates: false,
      generallyAvailableHeapTelemetry: false,
      note: 'Supervision, queues, breakers and caches are isolate-local; Cloudflare replaces failed isolates.',
    },
  };
}

/** Fatal equivalent on Workers: reject local queues and reset isolate state. */
export function resetOmniIsolateState(reason = 'fatal-reset') {
  for (const tier of [1, 2]) {
    const queue = scheduler.queues[tier].splice(0);
    for (const entry of queue) {
      clearTimeout(entry.timer);
      entry.reject(new AppError(ErrorCodes.OVERLOADED, 'Omni isolate state reset.', {
        safeMessage: 'The request could not be completed. Please retry shortly.', status: 503, meta: { reason },
      }));
    }
  }
  scheduler.domainRunning.clear();
  scheduler.userRunning.clear();
  scheduler.ipRunning.clear();
  scheduler.observations = [];
  scheduler.eventLoopDelayMs = 0;
  scheduler.memoryRatio = null;
  userBuckets.clear();
  ipBuckets.clear();
  staleResponses.clear();
  externalBulkheads.clear();
  resetCircuitBreakers();
  logEvent('fatal', 'omni.isolate_state_reset', { reason });
}

registerFatalFlusher(resetOmniIsolateState);
