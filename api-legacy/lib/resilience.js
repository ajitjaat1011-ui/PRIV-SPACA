/**
 * PRIV SPACA — isolate-local resilience primitives.
 *
 * Cloudflare Workers do not expose an immortal master process, a shared
 * process-wide queue, or a worker restart API. Everything in this module is
 * deliberately isolate-local; durable abuse limits remain in ratelimit.js.
 */

import { AppError, ErrorCodes, wrapUnexpected } from './errors.js';

const startedAt = Date.now();
const breakerState = new Map();
const WINDOW_MS = 10_000;
const DEFAULT_MIN_SAMPLES = 5;

function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isValidCorrelationId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/.test(value);
}

/** Generate/accept the end-to-end correlation id at API entry. */
export function requestId(c) {
  // EventSource cannot set custom headers, so the SSE client may use the same
  // validated query parameter. It contains no credential or user data.
  const incoming = c.req.header('x-correlation-id') || c.req.query('correlationId');
  return isValidCorrelationId(incoming) ? incoming : uuid();
}

function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/token|secret|password|authorization|cookie|pin/i.test(key)) continue;
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return out;
}

export function logEvent(level, event, fields = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    service: 'priv-spaca-api',
    ...safeMeta(fields),
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'fatal') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function statusClass(status) {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/**
 * Access log middleware. Sampling keeps healthy hot paths inexpensive while
 * retaining every slow/error/degraded request.
 */
export function accessLog({ successSampleRate = 0.04, slowMs = 1000 } = {}) {
  return async (c, next) => {
    const start = Date.now();
    let thrown = null;
    try {
      await next();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      const durationMs = Date.now() - start;
      const status = thrown ? 500 : (c.res?.status || 200);
      const important = thrown || status >= 400 || durationMs >= slowMs || c.get('omniDegraded');
      if (important || Math.random() < successSampleRate) {
        logEvent(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request.complete', {
          correlationId: c.get('correlationId') || c.get('requestId'),
          requestId: c.get('requestId'),
          path: c.req.path,
          method: c.req.method,
          status,
          statusClass: statusClass(status),
          durationMs,
          tier: c.get('omniTier'),
          loadStep: c.get('omniLoadStep'),
          colo: c.req.raw.cf?.colo,
          country: c.req.raw.cf?.country,
        });
      }
    }
  };
}

/** Promise timeout that does not rely on Node-only APIs. */
export async function withTimeout(promise, ms, label = 'operation') {
  if (!ms || ms <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError(
          ErrorCodes.UPSTREAM_TIMEOUT,
          `${label} timed out.`,
          { safeMessage: 'A dependency took too long to respond.', status: 504, meta: { label } },
        )), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stateFor(name) {
  if (!breakerState.has(name)) {
    breakerState.set(name, {
      state: 'closed',
      events: [],
      openedAt: 0,
      probeInFlight: false,
      openCount: 0,
      lastFailureAt: 0,
      lastSuccessAt: 0,
    });
  }
  return breakerState.get(name);
}

function pruneEvents(state, now, windowMs = WINDOW_MS) {
  const cutoff = now - windowMs;
  while (state.events.length && state.events[0].at < cutoff) state.events.shift();
}

function windowStats(state, now, windowMs) {
  pruneEvents(state, now, windowMs);
  const samples = state.events.length;
  const failures = state.events.reduce((n, event) => n + (event.ok ? 0 : 1), 0);
  return { samples, failures, failureRate: samples ? failures / samples : 0 };
}

function fallbackOrThrow(fallback, error, info) {
  if (fallback === undefined) throw error;
  return typeof fallback === 'function' ? fallback(error, info) : fallback;
}

/**
 * Three-state rolling-window circuit breaker.
 * Opens when failures exceed 30% over the previous 10 seconds after a small
 * minimum sample size, then permits exactly one half-open probe.
 */
export async function withBreaker(name, fn, {
  fallback,
  failureThreshold,
  minSamples = failureThreshold || DEFAULT_MIN_SAMPLES,
  failureRate = 0.30,
  windowMs = WINDOW_MS,
  resetMs = 10_000,
  timeoutMs,
} = {}) {
  const state = stateFor(name);
  const now = Date.now();
  pruneEvents(state, now, windowMs);

  if (state.state === 'open') {
    if (now - state.openedAt < resetMs) {
      return fallbackOrThrow(fallback, new AppError(
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        `${name} circuit is open.`,
        { safeMessage: 'A dependency is temporarily unavailable.', status: 503, meta: { breaker: name } },
      ), { breaker: name, state: 'open' });
    }
    state.state = 'half_open';
    state.probeInFlight = false;
  }

  if (state.state === 'half_open' && state.probeInFlight) {
    return fallbackOrThrow(fallback, new AppError(
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      `${name} half-open probe is already running.`,
      { safeMessage: 'A dependency is recovering. Please retry shortly.', status: 503, meta: { breaker: name } },
    ), { breaker: name, state: 'half_open' });
  }

  const isProbe = state.state === 'half_open';
  if (isProbe) state.probeInFlight = true;
  try {
    const result = await withTimeout(Promise.resolve().then(fn), timeoutMs, name);
    const doneAt = Date.now();
    state.lastSuccessAt = doneAt;
    if (isProbe) {
      state.state = 'closed';
      state.events = [];
      state.openedAt = 0;
      logEvent('info', 'circuit.closed', { breaker: name });
    } else {
      state.events.push({ at: doneAt, ok: true });
      pruneEvents(state, doneAt, windowMs);
    }
    return result;
  } catch (error) {
    const failedAt = Date.now();
    state.lastFailureAt = failedAt;
    state.events.push({ at: failedAt, ok: false });
    const stats = windowStats(state, failedAt, windowMs);
    if (isProbe || (stats.samples >= minSamples && stats.failureRate > failureRate)) {
      state.state = 'open';
      state.openedAt = failedAt;
      state.openCount++;
      logEvent('error', 'circuit.opened', {
        breaker: name,
        samples: stats.samples,
        failures: stats.failures,
        failureRate: Number(stats.failureRate.toFixed(3)),
      });
    }
    return fallbackOrThrow(fallback, error, { breaker: name, state: state.state, ...stats });
  } finally {
    if (isProbe) state.probeInFlight = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientError(error) {
  const wrapped = wrapUnexpected(error);
  if ([
    ErrorCodes.UPSTREAM_TIMEOUT,
    ErrorCodes.UPSTREAM_UNAVAILABLE,
    ErrorCodes.OVERLOADED,
    ErrorCodes.RATE_LIMITED,
  ].includes(wrapped.code)) return true;
  if ([408, 425, 429, 502, 503, 504].includes(Number(wrapped.status))) return true;
  return /timeout|temporar|network|fetch failed|connection|econn|reset/i.test(String(error?.message || ''));
}

/**
 * Retry only callers that explicitly opt into idempotent work. Delays use
 * full jitter around the requested 200ms, 800ms and 2000ms retry stages.
 */
export async function retryWithJitter(fn, {
  idempotent = false,
  delays = [200, 800, 2000],
  retryable = isTransientError,
  onRetry,
} = {}) {
  if (!idempotent) return fn(0);
  let last;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      last = error;
      if (attempt >= delays.length || !retryable(error)) throw error;
      const cap = delays[attempt];
      const delayMs = Math.max(1, Math.floor(Math.random() * cap));
      if (onRetry) onRetry({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw last;
}

/** Compatibility wrapper retained for older call sites. */
export async function retry(fn, { attempts = 3, baseMs = 200, maxMs = 2000, retryable = isTransientError } = {}) {
  const delays = [];
  for (let i = 0; i < Math.max(0, attempts - 1); i++) delays.push(Math.min(maxMs, baseMs * (4 ** i)));
  return retryWithJitter(fn, { idempotent: true, delays, retryable });
}

export function circuitSnapshot() {
  const now = Date.now();
  const circuits = {};
  for (const [name, state] of breakerState) {
    const stats = windowStats(state, now, WINDOW_MS);
    circuits[name] = {
      state: state.state,
      windowMs: WINDOW_MS,
      samples: stats.samples,
      failures: stats.failures,
      failureRate: Number(stats.failureRate.toFixed(3)),
      openedAt: state.openedAt || null,
      openCount: state.openCount,
      lastFailureAt: state.lastFailureAt || null,
      lastSuccessAt: state.lastSuccessAt || null,
      probeInFlight: state.probeInFlight,
    };
  }
  return { isolateUptimeMs: now - startedAt, circuits };
}

export function resetCircuitBreakers() {
  breakerState.clear();
}
