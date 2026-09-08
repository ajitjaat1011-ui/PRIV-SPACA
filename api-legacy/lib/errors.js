/**
 * PRIV SPACA — central error taxonomy and request-level fault supervisor.
 *
 * Cloudflare Workers have no process-level uncaughtException hook or supported
 * force-restart API. app.onError supervises request failures; Omni supervises
 * waitUntil work and performs an isolate-local state flush after fatal faults.
 */

import { isProductionRequest } from './config.js';

export const ErrorCodes = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  VALIDATION: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  AUTH_REQUIRED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UPGRADE_REQUIRED: 'UPGRADE_REQUIRED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  RATE_LIMITED: 'RATE_LIMITED',
  OVERLOADED: 'OVERLOADED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  UPSTREAM_TIMEOUT: 'TIMEOUT',
  INTERNAL: 'INTERNAL',
});

const STATUS_BY_CODE = Object.freeze({
  [ErrorCodes.VALIDATION_FAILED]: 400,
  [ErrorCodes.UNAUTHORIZED]: 401,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.NOT_FOUND]: 404,
  [ErrorCodes.CONFLICT]: 409,
  [ErrorCodes.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCodes.UPGRADE_REQUIRED]: 426,
  [ErrorCodes.NOT_CONFIGURED]: 501,
  [ErrorCodes.RATE_LIMITED]: 429,
  [ErrorCodes.OVERLOADED]: 503,
  [ErrorCodes.UPSTREAM_UNAVAILABLE]: 503,
  [ErrorCodes.TIMEOUT]: 504,
  [ErrorCodes.INTERNAL]: 500,
});

const SAFE_MESSAGE = Object.freeze({
  [ErrorCodes.VALIDATION_FAILED]: 'Some of the information sent was not valid.',
  [ErrorCodes.UNAUTHORIZED]: 'Please sign in to continue.',
  [ErrorCodes.FORBIDDEN]: "You don't have access to this.",
  [ErrorCodes.NOT_FOUND]: 'Not found.',
  [ErrorCodes.CONFLICT]: 'That conflicts with something that already exists.',
  [ErrorCodes.PAYLOAD_TOO_LARGE]: 'That upload is too large.',
  [ErrorCodes.UPGRADE_REQUIRED]: 'Please update the app to continue.',
  [ErrorCodes.NOT_CONFIGURED]: 'This feature is not configured.',
  [ErrorCodes.RATE_LIMITED]: 'Too many requests. Please slow down.',
  [ErrorCodes.OVERLOADED]: 'The server is busy. Please try again in a moment.',
  [ErrorCodes.UPSTREAM_UNAVAILABLE]: 'A service we depend on is unavailable. Please try again.',
  [ErrorCodes.TIMEOUT]: 'That took too long. Please try again.',
  [ErrorCodes.INTERNAL]: 'Something went wrong on our side.',
});

const fatalFlushers = new Set();

export function registerFatalFlusher(fn) {
  if (typeof fn === 'function') fatalFlushers.add(fn);
  return () => fatalFlushers.delete(fn);
}

function flushFatalResources(reason) {
  for (const flusher of fatalFlushers) {
    try { flusher(reason); } catch (error) {
      console.error(JSON.stringify({ level: 'fatal', event: 'fatal_flush_failed', detail: String(error?.message || error) }));
    }
  }
}

export function errorCategory(code) {
  if ([ErrorCodes.UPSTREAM_UNAVAILABLE, ErrorCodes.TIMEOUT, ErrorCodes.OVERLOADED, ErrorCodes.RATE_LIMITED].includes(code)) return 'transient';
  if (code === ErrorCodes.INTERNAL) return 'fatal';
  return 'structural';
}

export function errorDomain(code) {
  if (code === ErrorCodes.VALIDATION_FAILED) return 'validation';
  if (code === ErrorCodes.UNAUTHORIZED) return 'authentication';
  if (code === ErrorCodes.FORBIDDEN) return 'authorization';
  if (code === ErrorCodes.NOT_FOUND) return 'resource';
  if (code === ErrorCodes.CONFLICT) return 'conflict';
  if (code === ErrorCodes.PAYLOAD_TOO_LARGE) return 'request';
  if (code === ErrorCodes.UPGRADE_REQUIRED) return 'client_version';
  if (code === ErrorCodes.NOT_CONFIGURED) return 'configuration';
  if ([ErrorCodes.RATE_LIMITED, ErrorCodes.OVERLOADED].includes(code)) return 'capacity';
  if ([ErrorCodes.UPSTREAM_UNAVAILABLE, ErrorCodes.TIMEOUT].includes(code)) return 'dependency';
  return 'internal';
}

export function isRetryableCode(code) {
  return errorCategory(code) === 'transient';
}

/** A deliberate, safe route/domain error. */
export class AppError extends Error {
  constructor(code, message, { status, details, cause, expose = true, safeMessage, meta } = {}) {
    const normalizedCode = Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code) ? code : ErrorCodes.INTERNAL;
    super(message || safeMessage || SAFE_MESSAGE[normalizedCode] || SAFE_MESSAGE[ErrorCodes.INTERNAL]);
    this.name = 'AppError';
    this.code = normalizedCode;
    this.status = status || STATUS_BY_CODE[this.code] || 500;
    this.safeMessage = safeMessage || (expose ? this.message : SAFE_MESSAGE[this.code]) || SAFE_MESSAGE[ErrorCodes.INTERNAL];
    this.details = details;
    this.meta = meta;
    this.expose = expose;
    this.category = errorCategory(this.code);
    this.retryable = isRetryableCode(this.code);
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

export function wrapUnexpected(error, message) {
  if (error instanceof AppError) return error;
  const code = classifyUnknownError(error);
  return new AppError(code, message || SAFE_MESSAGE[code], {
    cause: error instanceof Error ? error : undefined,
    expose: false,
  });
}

export function classifyUnknownError(error) {
  const raw = String((error && error.message) || error || '');
  if (/\babort(ed)?\b|timed? ?out|deadline/i.test(raw)) return ErrorCodes.TIMEOUT;
  if (/\bfetch failed\b|network|ECONN|ENOTFOUND|socket hang up|connection reset/i.test(raw)) return ErrorCodes.UPSTREAM_UNAVAILABLE;
  if (/SQLITE_BUSY|database is locked|too many connections|queue is full/i.test(raw)) return ErrorCodes.OVERLOADED;
  if (/JSON|Unexpected token|Unexpected end of/i.test(raw)) return ErrorCodes.VALIDATION_FAILED;
  return ErrorCodes.INTERNAL;
}

/**
 * Stable diagnostics envelope. Legacy `error`, `message` and `requestId`
 * fields remain for the current frontend.
 */
export function errorBody(code, message, { details, requestId, correlationId, meta } = {}) {
  const category = errorCategory(code);
  const body = {
    success: false,
    error_domain: errorDomain(code),
    code,
    safe_user_msg: message,
    retryable: category === 'transient',
    category,
    message,
    error: message,
  };
  if (details) body.details = details;
  if (requestId) body.requestId = requestId;
  if (correlationId || requestId) body.correlation_id = correlationId || requestId;
  if (meta?.retryAfterSeconds) body.retry_after_seconds = Number(meta.retryAfterSeconds);
  return body;
}

/** Request-level synchronous/asynchronous route error supervisor. */
export function handleError(error, c) {
  const requestId = c.get('requestId');
  const correlationId = c.get('correlationId') || requestId;
  const isProd = isProductionRequest(c);
  const wrapped = error instanceof AppError ? error : wrapUnexpected(error);
  const category = wrapped.category || errorCategory(wrapped.code);

  const record = {
    level: category === 'fatal' ? 'fatal' : wrapped.status >= 500 ? 'error' : 'warn',
    event: category === 'fatal' ? 'fatal_request_fault' : 'request_failed',
    correlationId,
    requestId,
    path: c.req.path,
    method: c.req.method,
    error_domain: errorDomain(wrapped.code),
    code: wrapped.code,
    category,
    retryable: wrapped.retryable,
    detail: String(wrapped.message || 'unknown').slice(0, 1000),
    cause: wrapped.cause ? String(wrapped.cause.message || wrapped.cause).slice(0, 1000) : undefined,
  };
  if (!(wrapped.status < 500 && error instanceof AppError)) console.error(JSON.stringify(record));

  if (category === 'fatal') flushFatalResources(`request:${correlationId}`);

  const safe = wrapped.safeMessage || SAFE_MESSAGE[wrapped.code] || SAFE_MESSAGE[ErrorCodes.INTERNAL];
  const message = isProd || error instanceof AppError
    ? safe
    : `${safe} [dev: ${String((error && error.message) || error)}]`;
  const body = errorBody(wrapped.code, message, {
    details: wrapped.details,
    requestId,
    correlationId,
    meta: wrapped.meta,
  });
  const response = c.json(body, wrapped.status || STATUS_BY_CODE[wrapped.code] || 500);
  if (wrapped.meta?.retryAfterSeconds) response.headers.set('Retry-After', String(Math.ceil(wrapped.meta.retryAfterSeconds)));
  return response;
}

export function handleNotFound(c) {
  return c.json(errorBody(ErrorCodes.NOT_FOUND, 'Route not found.', {
    requestId: c.get('requestId'),
    correlationId: c.get('correlationId'),
  }), 404);
}
