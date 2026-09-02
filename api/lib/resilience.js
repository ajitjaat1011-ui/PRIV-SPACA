/**
 * PRIV SPACA — Library — resilience
 *
 * Load shedding, request correlation ids, structured logging, timeouts and a
 * circuit breaker for third-party calls.
 *
 * RUNTIME REALITY CHECK
 * ---------------------
 * On Cloudflare Workers there is no shared process holding a global concurrency
 * counter: each isolate handles its own requests and isolates come and go. So
 * "adaptive concurrency shedding" here means PER-ISOLATE in-flight accounting.
 * That is genuinely useful — the failure mode we actually hit in production is
 * CPU exhaustion inside one isolate (Cloudflare `error code: 1102`), which is
 * exactly what a per-isolate limit protects against — but it is not a global
 * cluster-wide limit, and it is not pretending to be one. Cross-isolate limits
 * are already handled by the Turso-backed rate limiters in ratelimit.js.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { AppError, ErrorCodes } from './errors.js';

/* --------------------------------------------------------- correlation ids */

/**
 * Per-request id. Prefers Cloudflare's ray id so a log line can be matched
 * against the Cloudflare dashboard, falling back to a random id locally.
 */
export function requestId(c) {
  const ray = c.req.header('cf-ray');
  if (ray) return ray;
  const existing = c.req.header('x-request-id');
  if (existing && /^[A-Za-z0-9_.:-]{1,128}$/.test(existing)) return existing;
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/* -------------------------------------------------------------- structured logging */

/**
 * One JSON object per line — the Workers equivalent of Winston/Pino.
 * `console.log` output is what `wrangler tail` and Logpush ingest, so emitting
 * JSON here is what makes those searchable by requestId.
 */
export function log(level, msg, fields = {}) {
  const line = { level, msg, t: new Date().toISOString(), ...fields };
  for (const k of Object.keys(line)) if (line[k] === undefined) delete line[k];
  const s = JSON.stringify(line);
  if (level === 'error') console.error(s);
  else if (level === 'warn') console.warn(s);
  else console.log(s);
}

/* ------------------------------------------------------------- load shedding */

/**
 * In-flight request accounting for THIS isolate.
 *
 * Thresholds are deliberately generous. The goal is to shed traffic only when
 * an isolate is genuinely saturated, because shedding too eagerly turns a slow
 * request into a failed one for no benefit.
 */
const loadState = {
  inFlight: 0,
  // Reads are cheap and are the bulk of traffic; writes are the ones that can
  // pile up behind Turso latency.
  maxInFlight: 120,
  maxInFlightWrites: 40,
  inFlightWrites: 0,
  shedCount: 0,
  peakInFlight: 0,
};

/** Endpoints that must never be shed — they are how we detect the outage. */
const NEVER_SHED = new Set(['/api/health', '/api/ready', '/api/version']);

export function loadSnapshot() {
  return {
    inFlight: loadState.inFlight,
    inFlightWrites: loadState.inFlightWrites,
    maxInFlight: loadState.maxInFlight,
    maxInFlightWrites: loadState.maxInFlightWrites,
    peakInFlight: loadState.peakInFlight,
    shedCount: loadState.shedCount,
  };
}

/**
 * Decide whether to shed, and if not, register the request as in-flight.
 * @returns a release function the caller MUST invoke in a finally block
 */
export function admit(c) {
  const path = c.req.path;
  const method = c.req.method;
  const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  if (NEVER_SHED.has(path)) {
    return () => {};
  }

  if (loadState.inFlight >= loadState.maxInFlight ||
      (isWrite && loadState.inFlightWrites >= loadState.maxInFlightWrites)) {
    loadState.shedCount++;
    log('warn', 'load_shed', {
      requestId: c.get('requestId'), path, method,
      inFlight: loadState.inFlight, inFlightWrites: loadState.inFlightWrites,
    });
    throw new AppError(
      ErrorCodes.OVERLOADED,
      'The server is busy right now. Please try again in a moment.',
      { status: 503 }
    );
  }

  loadState.inFlight++;
  if (isWrite) loadState.inFlightWrites++;
  if (loadState.inFlight > loadState.peakInFlight) loadState.peakInFlight = loadState.inFlight;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    loadState.inFlight--;
    if (isWrite) loadState.inFlightWrites--;
  };
}

/* ------------------------------------------------------------------ timeouts */

/**
 * Race a promise against a deadline.
 *
 * The Turso client speaks HTTP, so there is no TCP pool to size and no
 * pool-level query timeout to configure — the equivalent control is bounding
 * how long we are willing to wait, which is what this does.
 */
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError(ErrorCodes.TIMEOUT, `The ${label} took too long.`, { status: 504 })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** An AbortSignal that trips after `ms`, for fetch calls to third parties. */
export function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

/* ----------------------------------------------------------- circuit breaker */

/**
 * Per-isolate circuit breaker around an outbound dependency.
 *
 * States: closed (normal) -> open (failing fast) -> half-open (one trial) ->
 * closed or back to open. Same caveat as load shedding: the state is
 * per-isolate, so this bounds the damage one isolate can do to a sick upstream
 * rather than coordinating a global trip.
 */
const breakers = new Map();

export function getBreaker(name, { failureThreshold = 5, resetMs = 30000 } = {}) {
  let b = breakers.get(name);
  if (!b) {
    b = { name, failures: 0, state: 'closed', openedAt: 0, failureThreshold, resetMs, trips: 0 };
    breakers.set(name, b);
  }
  return b;
}

export function breakerSnapshot() {
  const out = {};
  for (const [name, b] of breakers) out[name] = { state: b.state, failures: b.failures, trips: b.trips };
  return out;
}

/**
 * Run `fn` under the named breaker.
 * @param fallback optional value returned instead of throwing when open
 */
export async function withBreaker(name, fn, { fallback, failureThreshold, resetMs, timeoutMs } = {}) {
  const b = getBreaker(name, { failureThreshold, resetMs });
  const now = Date.now();

  if (b.state === 'open') {
    if (now - b.openedAt >= b.resetMs) {
      b.state = 'half-open';
    } else {
      log('warn', 'breaker_open', { breaker: name });
      if (fallback !== undefined) return fallback;
      throw new AppError(
        ErrorCodes.UPSTREAM_UNAVAILABLE,
        'A service we depend on is temporarily unavailable.',
        { status: 503 }
      );
    }
  }

  try {
    const result = timeoutMs ? await withTimeout(Promise.resolve(fn()), timeoutMs, name) : await fn();
    if (b.state === 'half-open' || b.failures) {
      b.state = 'closed';
      b.failures = 0;
      log('info', 'breaker_closed', { breaker: name });
    }
    return result;
  } catch (e) {
    b.failures++;
    if (b.state === 'half-open' || b.failures >= b.failureThreshold) {
      b.state = 'open';
      b.openedAt = Date.now();
      b.trips++;
      log('error', 'breaker_tripped', { breaker: name, failures: b.failures });
    }
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

/* ---------------------------------------------------------------- retries */

/**
 * Retry with exponential backoff and jitter.
 *
 * Only for idempotent work. Jitter matters: without it, everything that failed
 * during a blip retries in lockstep and re-creates the blip.
 */
export async function retry(fn, { attempts = 3, baseMs = 100, maxMs = 2000, retryable } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (retryable && !retryable(e)) throw e;
      if (i === attempts - 1) break;
      const backoff = Math.min(maxMs, baseMs * Math.pow(2, i));
      const jittered = backoff * (0.5 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, jittered));
    }
  }
  throw lastErr;
}
