/**
 * PRIV SPACA — Library — validate
 *
 * Schema validation for every request body, built on `zod/mini`.
 *
 * WHY zod/mini AND NOT zod
 * ------------------------
 * Identical validation semantics, but the functional API tree-shakes: bundled
 * into this worker, classic `zod` costs ~423KB raw / 85KB gzip, `zod/mini`
 * costs ~14KB raw / 4KB gzip. On Workers the whole script is parsed on every
 * cold start, so that difference is startup latency on every isolate.
 *
 * WHAT VALIDATION IS AND IS NOT DOING HERE
 * ----------------------------------------
 * Schemas reject structurally wrong input (missing fields, wrong types,
 * over-long strings, unknown keys). They are NOT the XSS defence — this app
 * stores text and renders it through `textContent` / escaped templates on the
 * client, so the real protection is at render time plus the CSP. What schemas
 * DO give us is a hard whitelist: `strictObject` drops unknown keys, which is
 * what stops mass assignment.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import {
  any, array, boolean, custom, gte, int, literal, lte, maxLength, minLength,
  nullable, null as zNull, number, object, optional, pipe, refine, regex,
  strictObject, string, transform, union,
} from 'zod/mini';
import { AppError, ErrorCodes } from './errors.js';
import { sanitizeText } from './helpers.js';

// BUNDLE SIZE — import and re-export NAMED bindings only.
//
// Two things break tree-shaking here, and both cost the same 390KB:
//   1. `export { z }` after `import * as z` — re-exporting the namespace means
//      the bundler must assume any member could be used.
//   2. `export const { object, string } = z` — destructuring the namespace is a
//      RUNTIME property read on the namespace object, which also retains it.
//
// Retaining the namespace drags in zod's 63 locale files (~248KB of translated
// error strings) and its JSON-Schema generator (~19KB), none of which this app
// uses. Measured on this bundle: namespace form 604KB minified, the named form
// below 214KB. On Workers the whole script is parsed on every cold start, so
// that is startup latency on every isolate.
//
// Add a name to the import list above and to this export when a new schema
// needs a builder we do not yet list.
export {
  any, array, boolean, custom, gte, int, literal, lte, maxLength, minLength,
  nullable, zNull as null, number, object, optional, pipe, refine, regex,
  strictObject, string, transform, union,
};

/* ---------------------------------------------------------------- primitives */

/** Trimmed, control-character-stripped text with a hard max length. */
export const text = (max, { min = 0 } = {}) =>
  pipe(
    string().check(maxLength(max * 2)),   // cheap pre-guard before we sanitise
    transform((s) => sanitizeText(s, max).trim())
  ).check(refine((s) => s.length >= min, { message: `must be at least ${min} character(s)` }));

/** Optional text: absent, null and '' all collapse to undefined. */
export const optionalText = (max) =>
  optional(pipe(
    union([string(), zNull()]),
    transform((s) => (s == null ? undefined : sanitizeText(s, max).trim() || undefined))
  ));

export const username = string().check(regex(/^[a-zA-Z0-9_]{3,24}$/, 'must be 3-24 letters, numbers or underscores'));
export const email = string().check(maxLength(254), regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be a valid email'));
export const pin = string().check(regex(/^\d{4}$/, 'must be 4 digits'));
export const password = string().check(minLength(6), maxLength(200));

/**
 * An opaque id we generated (`usr_...`, `post_...`, `cmt_...`) or a room id.
 * Restricting the character set here is what keeps ids out of path traversal
 * and injection positions downstream.
 */
export const id = string().check(minLength(1), maxLength(128), regex(/^[A-Za-z0-9_:.-]+$/, 'invalid id'));

export const roomId = string().check(minLength(1), maxLength(256), regex(/^[A-Za-z0-9_:.-]+$/, 'invalid room id'));

export const bool = union([
  boolean(),
  pipe(literal(['true', 'false', '1', '0']), transform((v) => v === 'true' || v === '1')),
]);

export const ts = number().check(int(), gte(0), lte(4102444800000)); // <= year 2100

/** A URL we are willing to fetch or render. Blocks javascript:, file:, etc. */
export const httpsUrl = (maxLen = 2048) =>
  string().check(
    maxLength(maxLen),
    refine((s) => {
      try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch (_) { return false; }
    }, { message: 'must be an http(s) URL' })
  );

/** Media URLs additionally allow inline data: payloads (uploads in progress). */
export const mediaUrl = (maxLen = 8 * 1024 * 1024) =>
  string().check(
    maxLength(maxLen),
    refine((s) => {
      if (/^data:(image|video|audio)\//i.test(s)) return true;
      try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch (_) { return false; }
    }, { message: 'must be an http(s) or data: media URL' })
  );

/**
 * Strict object: unknown keys are an ERROR, not silently dropped.
 *
 * This is the mass-assignment guard. If a client posts `{displayName, isAdmin}`
 * the request fails outright rather than quietly ignoring `isAdmin` — we would
 * rather find out that a client is sending fields we do not expect.
 */
export const strict = (shape) => strictObject(shape);

/** Same, but tolerant of extra keys — for endpoints older clients still post to. */
export const loose = (shape) => object(shape);

/* ------------------------------------------------------------------- runner */

/** Turn a Zod error into `{ field: message }` naming ONLY the fields at fault. */
function formatIssues(err) {
  const out = {};
  const issues = (err && err.issues) || [];
  for (const issue of issues.slice(0, 12)) {
    // Unknown keys are the mass-assignment signal — name them explicitly so
    // the log and the client both say WHICH field was rejected.
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      for (const k of issue.keys.slice(0, 8)) out[k] = 'unexpected field';
      continue;
    }
    const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : '_';
    // Deliberately never echo issue.input — that could reflect an attacker's
    // payload straight back into the response.
    if (!out[path]) out[path] = issue.message || 'invalid';
  }
  return out;
}

/**
 * Parse a value, throwing an AppError(VALIDATION_FAILED) with per-field detail.
 * @returns the parsed (and transformed) value
 */
export function parseOrThrow(schema, value, what = 'request') {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new AppError(
    ErrorCodes.VALIDATION_FAILED,
    `Invalid ${what}.`,
    { details: formatIssues(r.error) }
  );
}

/**
 * Read and validate a JSON body.
 *
 * Malformed JSON becomes a clean 400 instead of an unhandled SyntaxError, which
 * is one of the ways the process used to produce a raw 500 with an internal
 * message attached.
 */
export async function body(c, schema) {
  let raw;
  try {
    raw = await c.req.json();
  } catch (_) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Request body must be valid JSON.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Request body must be a JSON object.');
  }
  return parseOrThrow(schema, raw, 'request body');
}

/**
 * Read a body and keep ONLY the listed keys. Never throws, never rejects.
 *
 * For the auth endpoints. Those already validate every field themselves and
 * deliberately answer with a single generic message ("Invalid credentials")
 * so an attacker cannot tell a wrong password from a non-existent account.
 * Running a schema in front of them would replace that generic answer with a
 * field-level one and hand back an account-enumeration oracle.
 *
 * So here we take the half of validation that is purely defensive — dropping
 * undeclared keys, which is the mass-assignment guard — and leave the
 * endpoint's own checks, and its careful error wording, exactly as they were.
 */
export async function pickBody(c, allowedKeys) {
  let raw;
  try {
    raw = await c.req.json();
  } catch (_) {
    return {};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const k of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
  }
  return out;
}

/** Read and validate the query string. */
export function query(c, schema) {
  return parseOrThrow(schema, c.req.query(), 'query parameters');
}

/**
 * Validate a path parameter.
 *
 * Path traversal defence: ids are matched against a strict character class, so
 * `../`, encoded separators and NUL bytes never reach a storage key or URL.
 */
export function param(c, name, schema = id) {
  const raw = c.req.param(name);
  return parseOrThrow(schema, raw, `path parameter "${name}"`);
}

/* -------------------------------------------------- injection-shaped guards */

/**
 * Reject values that are objects/arrays where a scalar is expected.
 *
 * This is the NoSQL-operator-injection shape (`{"password": {"$ne": null}}`).
 * Our storage is SQLite via parameterised libSQL calls, so operator injection
 * is not directly exploitable, but a nested object arriving where a string is
 * expected still means the caller is probing — treat it as invalid input.
 */
export const scalarOnly = custom(
  (v) => v === null || v === undefined || (typeof v !== 'object' && typeof v !== 'function'),
  { message: 'must be a scalar value' }
);

/** Assert an entire body contains no `$`-prefixed or `__proto__` keys. */
export function assertNoOperatorKeys(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) assertNoOperatorKeys(v, depth + 1);
    return;
  }
  for (const k of Object.keys(value)) {
    if (k.startsWith('$') || k === '__proto__' || k === 'constructor' || k === 'prototype') {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'Request contains a disallowed field name.');
    }
    assertNoOperatorKeys(value[k], depth + 1);
  }
}
