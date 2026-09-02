/**
 * PRIV SPACA — Library — errors
 *
 * Centralised error taxonomy + the global error interceptor.
 *
 * WHY THIS EXISTS
 * ---------------
 * Handlers used to do `catch (e) { return c.json({ error: e.message }, 500) }`,
 * which forwards whatever the failure was straight to the client — libSQL
 * messages, SQL fragments, internal hostnames. This module gives every route a
 * safe default: a stable machine-readable `code`, a human `message` that was
 * deliberately written for users, and NO internals in production.
 *
 * A note on the runtime: this is Cloudflare Workers, not Node. There is no
 * `process`, so `uncaughtException` / `unhandledRejection` do not exist and a
 * "server crash" is not a thing — each request runs in an isolate and a throw
 * only kills that one request. `app.onError` is the equivalent safety net, and
 * it is registered in register-middleware.js.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { isProductionRequest } from './config.js';

/**
 * Stable error codes. Clients may branch on these; the wording of `message`
 * can change freely, the code cannot.
 */
export const ErrorCodes = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  OVERLOADED: 'OVERLOADED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
};

const STATUS_BY_CODE = {
  [ErrorCodes.VALIDATION_FAILED]: 400,
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.CONFLICT]: 409,
  [ErrorCodes.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCodes.RATE_LIMITED]: 429,
  [ErrorCodes.OVERLOADED]: 503,
  [ErrorCodes.UPSTREAM_UNAVAILABLE]: 503,
  [ErrorCodes.TIMEOUT]: 504,
  [ErrorCodes.INTERNAL]: 500,
};

/** Safe, user-facing wording. Never contains anything internal. */
const SAFE_MESSAGE = {
  [ErrorCodes.VALIDATION_FAILED]: 'Some of the information sent was not valid.',
  [ErrorCodes.UNAUTHORIZED]: 'Please sign in to continue.',
  [ErrorCodes.FORBIDDEN]: "You don't have access to this.",
  [ErrorCodes.NOT_FOUND]: 'Not found.',
  [ErrorCodes.CONFLICT]: 'That conflicts with something that already exists.',
  [ErrorCodes.PAYLOAD_TOO_LARGE]: 'That upload is too large.',
  [ErrorCodes.RATE_LIMITED]: 'Too many requests. Please slow down.',
  [ErrorCodes.OVERLOADED]: 'The server is busy. Please try again in a moment.',
  [ErrorCodes.UPSTREAM_UNAVAILABLE]: 'A service we depend on is unavailable. Please try again.',
  [ErrorCodes.TIMEOUT]: 'That took too long. Please try again.',
  [ErrorCodes.INTERNAL]: 'Something went wrong on our side.',
};

/**
 * An error a route raised on purpose, with a code the client can rely on.
 * Anything that is NOT an AppError is treated as an unexpected fault and is
 * scrubbed before it reaches the client.
 */
export class AppError extends Error {
  constructor(code, message, { status, details, cause, expose = true } = {}) {
    super(message || SAFE_MESSAGE[code] || SAFE_MESSAGE[ErrorCodes.INTERNAL]);
    this.name = 'AppError';
    this.code = code in STATUS_BY_CODE ? code : ErrorCodes.INTERNAL;
    this.status = status || STATUS_BY_CODE[this.code] || 500;
    // `details` is only ever surfaced for validation failures, where it names
    // the offending fields. It must never carry values the user did not send.
    this.details = details;
    this.expose = expose;
    if (cause) this.cause = cause;
  }
}

export const badRequest = (msg, details) => new AppError(ErrorCodes.VALIDATION_FAILED, msg, { details });
export const unauthorized = (msg) => new AppError(ErrorCodes.UNAUTHORIZED, msg);
export const forbidden = (msg) => new AppError(ErrorCodes.FORBIDDEN, msg);
export const notFound = (msg) => new AppError(ErrorCodes.NOT_FOUND, msg);
export const conflict = (msg) => new AppError(ErrorCodes.CONFLICT, msg);
export const overloaded = (msg) => new AppError(ErrorCodes.OVERLOADED, msg);
export const upstreamDown = (msg) => new AppError(ErrorCodes.UPSTREAM_UNAVAILABLE, msg);

/**
 * Normalise anything caught in a route's `catch` block.
 *
 * Routes used to end with `catch (e) { return c.json({error: e.message}, 500) }`,
 * which forwarded raw libSQL/runtime messages to the client. They now end with
 * `catch (e) { throw wrapUnexpected(e); }`:
 *   - an AppError passes through untouched, keeping its intended status/code
 *     (so a 404 thrown deep inside a helper does not become a 500)
 *   - anything else is classified and re-thrown for the global interceptor,
 *     which logs the real detail server-side and returns a safe message
 *
 * @returns an AppError — always throw the result, never return it to a client
 */
export function wrapUnexpected(e, message) {
  if (e instanceof AppError) return e;
  const code = classifyUnknownError(e);
  return new AppError(code, message || SAFE_MESSAGE[code], { cause: e instanceof Error ? e : undefined });
}

/**
 * Classify an unknown thrown value into a safe code.
 *
 * Deliberately conservative: we only special-case failures we can recognise
 * with confidence, and everything else becomes INTERNAL. Guessing wrong here
 * would leak the very details this module exists to hide.
 */
export function classifyUnknownError(e) {
  const raw = String((e && e.message) || e || '');
  if (/\babort(ed)?\b|timed? ?out|deadline/i.test(raw)) return ErrorCodes.TIMEOUT;
  if (/\bfetch failed\b|network|ECONN|ENOTFOUND|socket hang up/i.test(raw)) return ErrorCodes.UPSTREAM_UNAVAILABLE;
  if (/SQLITE_BUSY|database is locked|too many connections/i.test(raw)) return ErrorCodes.OVERLOADED;
  if (/JSON|Unexpected token|Unexpected end of/i.test(raw)) return ErrorCodes.VALIDATION_FAILED;
  return ErrorCodes.INTERNAL;
}

/**
 * The single JSON error shape every client sees.
 *
 * `error` duplicates `message` because the existing frontend reads `error`
 * everywhere (`api()` throws `new Error(data.error)`); removing it would break
 * every error toast in the app. New clients should read `code`.
 */
export function errorBody(code, message, { details, requestId } = {}) {
  const body = {
    success: false,
    code,
    message,
    error: message,
  };
  if (details) body.details = details;
  if (requestId) body.requestId = requestId;
  return body;
}

/**
 * Global error interceptor. Registered via `app.onError`, so it catches
 * anything a handler throws — including async rejections — and guarantees a
 * well-formed JSON response instead of Hono's default text/plain 500.
 */
export function handleError(err, c) {
  const requestId = c.get('requestId');
  const isProd = isProductionRequest(c);

  if (err instanceof AppError) {
    const body = errorBody(err.code, err.message, { details: err.details, requestId });
    // Client faults are noise at error level; log them at debug volume only.
    if (err.status >= 500) {
      console.error(JSON.stringify({
        level: 'error', msg: 'request_failed', requestId,
        path: c.req.path, method: c.req.method,
        code: err.code, detail: err.message,
        cause: err.cause ? String(err.cause.message || err.cause) : undefined,
      }));
    }
    return c.json(body, err.status);
  }

  // Unexpected: log everything we have, tell the client almost nothing.
  const code = classifyUnknownError(err);
  console.error(JSON.stringify({
    level: 'error', msg: 'unhandled_exception', requestId,
    path: c.req.path, method: c.req.method,
    code,
    detail: String((err && err.message) || err || 'unknown'),
    stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined,
  }));

  const status = STATUS_BY_CODE[code] || 500;
  const safe = SAFE_MESSAGE[code] || SAFE_MESSAGE[ErrorCodes.INTERNAL];
  // Outside production, surfacing the real message makes local debugging sane.
  const message = isProd ? safe : `${safe} [dev: ${String((err && err.message) || err)}]`;
  return c.json(errorBody(code, message, { requestId }), status);
}

/** 404 handler, so unmatched routes get the same shape as everything else. */
export function handleNotFound(c) {
  return c.json(
    errorBody(ErrorCodes.NOT_FOUND, 'Route not found.', { requestId: c.get('requestId') }),
    404
  );
}
