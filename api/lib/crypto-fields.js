/**
 * PRIV SPACA — Library — crypto-fields
 *
 * AES-256-GCM field-level encryption for PII at rest.
 *
 * THREAT MODEL — what this does and does not buy us.
 *
 * This protects against someone who obtains the DATABASE but not the Worker's
 * secrets: a leaked Turso token, a stolen backup, a support person browsing
 * rows, a misconfigured replica. That is the realistic breach for this app,
 * because the Turso token is a long-lived bearer credential that has already
 * been copy-pasted into handoff notes.
 *
 * It does NOT protect against an attacker who has the Worker's environment,
 * because the Worker must be able to decrypt to function. Anyone claiming
 * otherwise is selling something. Field encryption raises the cost of a
 * database-only compromise; it is not a substitute for guarding FIELD_KEY.
 *
 * DESIGN
 *
 * - AES-256-GCM, 96-bit random IV per value, authenticated. GCM's tag means a
 *   tampered ciphertext fails to decrypt rather than silently returning
 *   garbage.
 * - Envelope format: enc:v1:<base64url(iv|ciphertext+tag)>. The version tag is
 *   there so a future key rotation or algorithm change can be detected per
 *   value instead of requiring a flag day.
 * - The key is derived once per isolate from FIELD_KEY via HKDF-SHA256 with a
 *   fixed info string, so the raw secret is never used directly as a key and a
 *   second purpose can be derived later from the same secret.
 *
 * DUAL-READ, ALWAYS
 *
 * decryptField() returns plaintext unchanged if it is not in envelope format.
 * That is what makes this deployable without a migration window: existing
 * plaintext rows keep working, and each row becomes ciphertext the next time
 * it is written. If FIELD_KEY is absent the module degrades to a no-op and
 * logs once — the app must not hard-fail because an env var is missing.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { cfg } from './config.js';

const ENVELOPE_PREFIX = 'enc:v1:';
const IV_BYTES = 12;              // 96-bit, the GCM-recommended size
const HKDF_INFO = 'priv-spaca/field-encryption/v1';

/** Per-isolate cache. Key derivation is ~1ms but happens on every request otherwise. */
let _keyPromise = null;
let _warnedMissing = false;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when a FIELD_KEY is configured. */
export function isFieldEncryptionEnabled() {
  return !!(cfg.FIELD_KEY && String(cfg.FIELD_KEY).length >= 16);
}

async function getKey() {
  if (!isFieldEncryptionEnabled()) return null;
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(String(cfg.FIELD_KEY)), 'HKDF', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(HKDF_INFO) },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  })();
  return _keyPromise;
}

/** True if a value is already an encrypted envelope. */
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt a string. Returns the input unchanged when encryption is disabled,
 * when the value is empty, or when it is already encrypted (idempotent, so
 * re-saving a record does not double-wrap).
 */
export async function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (typeof plaintext !== 'string') return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const key = await getKey();
  if (!key) {
    if (!_warnedMissing) {
      _warnedMissing = true;
      console.warn(JSON.stringify({
        level: 'warn', msg: 'field_encryption_disabled',
        detail: 'FIELD_KEY is not set; PII is being stored in plaintext',
      }));
    }
    return plaintext;
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const packed = new Uint8Array(IV_BYTES + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), IV_BYTES);
  return ENVELOPE_PREFIX + b64urlEncode(packed);
}

/**
 * Decrypt a value. Anything that is not an envelope is returned unchanged —
 * this is the dual-read path that lets encrypted and plaintext rows coexist.
 *
 * A value that IS an envelope but fails to decrypt returns null rather than
 * throwing: a wrong or rotated key must not turn every profile read into a
 * 500. The failure is logged so it is visible.
 */
export async function decryptField(value) {
  if (!isEncrypted(value)) return value;
  const key = await getKey();
  if (!key) return null;
  try {
    const packed = b64urlDecode(value.slice(ENVELOPE_PREFIX.length));
    const iv = packed.slice(0, IV_BYTES);
    const ct = packed.slice(IV_BYTES);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return dec.decode(pt);
  } catch (e) {
    console.warn(JSON.stringify({
      level: 'warn', msg: 'field_decrypt_failed', detail: String((e && e.message) || e),
    }));
    return null;
  }
}

/**
 * Fields encrypted on a user record.
 *
 * `email` and `dateOfBirth` are the directly identifying values. Note that
 * `username`, `displayName` and `bio` are deliberately NOT here: they are
 * shown publicly in the app, so encrypting them would cost CPU on every feed
 * render while protecting data an attacker can read by signing up.
 */
export const USER_PII_FIELDS = ['email', 'dateOfBirth'];

/**
 * Encrypt PII on a user object. Returns a copy; the input is not mutated,
 * because callers frequently hold the same object in an in-memory cache and
 * mutating it would leave ciphertext in the live cache.
 */
export async function encryptUserPII(user) {
  if (!user || typeof user !== 'object') return user;
  if (!isFieldEncryptionEnabled()) return user;
  const out = { ...user };
  for (const f of USER_PII_FIELDS) {
    if (typeof out[f] === 'string' && out[f] !== '') out[f] = await encryptField(out[f]);
  }
  // Push subscriptions carry endpoint URLs and auth secrets that let anyone
  // holding them send notifications to that device.
  if (Array.isArray(out.pushSubs) && out.pushSubs.length) {
    out.pushSubs = await Promise.all(out.pushSubs.map(async (s) => {
      if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string') return s;
      return { ...s, endpoint: await encryptField(s.endpoint) };
    }));
  }
  return out;
}

/** Reverse of encryptUserPII. Safe on rows that were never encrypted. */
export async function decryptUserPII(user) {
  if (!user || typeof user !== 'object') return user;
  let touched = false;
  const out = { ...user };
  for (const f of USER_PII_FIELDS) {
    if (isEncrypted(out[f])) {
      const v = await decryptField(out[f]);
      out[f] = v === null ? '' : v;
      touched = true;
    }
  }
  if (Array.isArray(out.pushSubs) && out.pushSubs.some((s) => s && isEncrypted(s.endpoint))) {
    out.pushSubs = await Promise.all(out.pushSubs.map(async (s) => {
      if (!s || !isEncrypted(s.endpoint)) return s;
      const ep = await decryptField(s.endpoint);
      return ep === null ? null : { ...s, endpoint: ep };
    }));
    out.pushSubs = out.pushSubs.filter(Boolean);
    touched = true;
  }
  return touched ? out : user;
}

/**
 * Blind index for email lookup.
 *
 * ps_users.email_lower is an INDEXED PLAINTEXT column that login queries with
 * `WHERE username_lower = ? OR email_lower = ?`. Encrypting data_json.email
 * while leaving that column readable would be theater — the attacker reads
 * the index instead. But we cannot query a randomised ciphertext either, since
 * AES-GCM produces a different value every time.
 *
 * So the column stores an HMAC-SHA256 of the lowercased email under a key
 * derived from FIELD_KEY: deterministic, so equality lookup still works and
 * the index is still useful, but not reversible without the key. It leaks
 * equality (two identical emails hash alike), which is exactly what a unique
 * lookup column has to leak anyway.
 */
let _indexKeyPromise = null;

async function getIndexKey() {
  if (!isFieldEncryptionEnabled()) return null;
  if (_indexKeyPromise) return _indexKeyPromise;
  _indexKeyPromise = (async () => {
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(String(cfg.FIELD_KEY)), 'HKDF', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('priv-spaca/email-blind-index/v1') },
      material,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  })();
  return _indexKeyPromise;
}

/**
 * Deterministic lookup token for an email.
 *
 * Returns the plain lowercased email when encryption is disabled, so the
 * existing queries keep working untouched in that configuration.
 */
export async function emailIndex(email) {
  const lower = String(email || '').trim().toLowerCase();
  if (!lower) return '';
  const key = await getIndexKey();
  if (!key) return lower;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(lower));
  return 'bi1:' + b64urlEncode(sig).slice(0, 43);
}
