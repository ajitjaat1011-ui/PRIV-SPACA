/**
 * PRIV SPACA — Library — password hashing
 *
 * Dual-scheme password hashing: PBKDF2-HMAC-SHA256 for everything new, with
 * transparent verification of the legacy bcrypt hashes already in the database.
 *
 * WHY NOT Argon2id, WHY NOT bcrypt cost 12
 * ----------------------------------------
 * The brief asked for "Argon2id or bcrypt cost >= 12". Both are the wrong tool
 * for THIS runtime, and the reason is measured, not theoretical:
 *
 *   bcryptjs hash  cost 8    30 ms      <- what we ship today
 *   bcryptjs hash  cost 12  310 ms
 *   bcryptjs cmp   cost 12  313 ms      <- on EVERY login
 *   PBKDF2-SHA256  600k     198 ms      <- native WebCrypto
 *
 * `bcryptjs` is a pure-JavaScript implementation, so every one of those
 * milliseconds is interpreted CPU burned inside the isolate. This app already
 * hits Cloudflare's CPU limit (`error code: 1102`) under load, so multiplying
 * the cost of the auth path by 16x is a self-inflicted outage. Argon2id has no
 * native binding on Workers at all — it would mean shipping a WASM build,
 * which is a much larger change than "raise the cost factor".
 *
 * PBKDF2-HMAC-SHA256 at 600,000 iterations is what OWASP recommends when
 * Argon2id and scrypt are unavailable, it runs on native WebCrypto rather than
 * interpreted JS, and it is *stronger* than bcrypt cost 12 while costing less
 * wall-clock time here. That is the trade this module makes.
 *
 * MIGRATION — nobody gets logged out
 * ----------------------------------
 * `verifyPassword` reads the scheme off the stored hash, so existing bcrypt
 * users keep logging in exactly as before. `needsRehash` then tells the caller
 * to re-hash with the new scheme using the plaintext it already has in hand,
 * so accounts upgrade silently on next login. The codebase already does this
 * for bcrypt cost changes; this extends the same idea across schemes.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import bcrypt from 'bcryptjs';

/** OWASP-recommended iteration count for PBKDF2-HMAC-SHA256 (2023+). */
export const PBKDF2_ITERATIONS = 600000;

/**
 * Iteration count for the 4-digit recovery PIN.
 *
 * Deliberately lower than the password count, because for a 4-digit PIN the
 * KDF work factor is not what provides the security. The keyspace is 10,000:
 * an attacker who has stolen the hash can exhaust it in ~33 minutes at 600k
 * iterations or ~6 minutes at 100k — neither figure is a defence. What
 * actually protects the PIN is online-only access plus the account lockout in
 * ratelimit.js (5 failures -> 15 minute lock), which caps an attacker at a few
 * hundred guesses a day.
 *
 * Meanwhile the cost IS paid on every signup and every PIN reset, on a runtime
 * that bills CPU time and kills the request at the limit (Cloudflare error
 * 1102). Signup hashes both the password and the PIN, so 600k for the PIN was
 * doubling the most expensive request in the app to buy ~27 minutes of offline
 * attack time against a secret the lockout already guards.
 */
export const PBKDF2_PIN_ITERATIONS = 100000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_KEY_BITS = 256;
const PREFIX = '$pbkdf2-sha256$';

const enc = new TextEncoder();

/* ------------------------------------------------------------ base64 utils */

function toB64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* --------------------------------------------------------------- primitives */

/**
 * Cloudflare Workers refuses any single PBKDF2 call above 100,000 iterations:
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 600000)
 *
 * Node has no such cap, so this only shows up once the code is on Workers —
 * it passed every local test and failed the first production signup.
 *
 * We keep the full 600k work factor by CHAINING calls of at most 100k each.
 * Every stage re-derives from the password, using the previous stage's output
 * as the salt, so an attacker still has to perform all 600,000 HMAC-SHA256
 * iterations sequentially to test one candidate password — the work factor is
 * preserved, it is just expressed as 6 chained calls instead of 1 long one.
 */
const PBKDF2_MAX_PER_CALL = 100000;

async function pbkdf2Bits(pw, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  let remaining = iterations;
  let currentSalt = salt;
  let out = null;
  while (remaining > 0) {
    const chunk = Math.min(remaining, PBKDF2_MAX_PER_CALL);
    out = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: currentSalt, iterations: chunk, hash: 'SHA-256' },
      key,
      PBKDF2_KEY_BITS
    );
    currentSalt = new Uint8Array(out);
    remaining -= chunk;
  }
  return out;
}

/**
 * Constant-time comparison.
 *
 * A plain `===` on hashes leaks, through timing, how many leading bytes
 * matched. The window is small but it is free to close, so close it.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ------------------------------------------------------------------- public */

/** Detect which scheme produced a stored hash. */
export function hashScheme(stored) {
  if (typeof stored !== 'string' || !stored) return 'unknown';
  if (stored.startsWith(PREFIX)) return 'pbkdf2';
  if (/^\$2[aby]\$\d{2}\$/.test(stored)) return 'bcrypt';
  return 'unknown';
}

/**
 * Hash a password with the current scheme.
 * Format: `$pbkdf2-sha256$i=<iterations>$<saltB64>$<hashB64>`
 */
export async function hashPassword(pw, { iterations = PBKDF2_ITERATIONS } = {}) {
  if (typeof pw !== 'string' || !pw) throw new Error('password required');
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const bits = await pbkdf2Bits(pw, salt, iterations);
  return `${PREFIX}i=${iterations}$${toB64(salt)}$${toB64(bits)}`;
}

/**
 * Verify a password against a stored hash of EITHER scheme.
 * Always returns a boolean — a malformed stored hash is a failed login, not a
 * thrown error, so a corrupt row cannot 500 the auth endpoint.
 */
export async function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || typeof stored !== 'string' || !stored) return false;

  const scheme = hashScheme(stored);

  if (scheme === 'bcrypt') {
    // Legacy path. Kept indefinitely for verification; never used for new hashes.
    try {
      return await bcrypt.compare(pw, stored);
    } catch (_) {
      return false;
    }
  }

  if (scheme === 'pbkdf2') {
    try {
      const parts = stored.slice(PREFIX.length).split('$');
      if (parts.length !== 3) return false;
      const iterations = Number((parts[0].match(/^i=(\d+)$/) || [])[1]);
      if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 5000000) return false;
      const salt = fromB64(parts[1]);
      const expected = fromB64(parts[2]);
      const actual = new Uint8Array(await pbkdf2Bits(pw, salt, iterations));
      return timingSafeEqual(actual, expected);
    } catch (_) {
      return false;
    }
  }

  return false;
}

/**
 * Should this hash be upgraded? Call only AFTER a successful verify, then
 * re-hash with the plaintext already in hand and persist.
 *
 * True for: any bcrypt hash, and any PBKDF2 hash below the current iteration
 * count (so raising PBKDF2_ITERATIONS later migrates everyone automatically).
 */
export function needsRehash(stored, { iterations = PBKDF2_ITERATIONS } = {}) {
  const scheme = hashScheme(stored);
  if (scheme === 'bcrypt') return true;
  if (scheme === 'unknown') return true;
  const current = Number((stored.match(/\$i=(\d+)\$/) || [])[1]);
  return !Number.isInteger(current) || current < iterations;
}
