/**
 * PRIV SPACA — Library — ratelimit
 *
 * Rate limiting and login lockout.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { sleepMs } from './helpers.js';
import { isTursoPrimary, tursoClient, tursoEnsure } from './store-turso.js';

// ---------- Rate limiting ----------
// v77-bugfix: In-memory rate limiter is ONLY used as fallback when Turso is unreachable.
// For cross-isolate consistency, use sharedRateLimit() which persists to Turso.
export const _rateBuckets = new Map();

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let b = _rateBuckets.get(key);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + windowMs }; _rateBuckets.set(key, b); }
  b.count++;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}

export async function sharedRateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const nextResetAt = now + windowMs;
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      const tc = tursoClient();
      await tc.execute({
        sql: `INSERT INTO ps_rate_limits (key, count, reset_at, updated_at) VALUES (?, 1, ?, ?)
              ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
                reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END,
                updated_at = ?`,
        args: [key, nextResetAt, now, now, now, nextResetAt, now],
      });
      if (Math.random() < 0.01) {
        tc.execute({ sql: 'DELETE FROM ps_rate_limits WHERE reset_at < ?', args: [now - (24 * 60 * 60 * 1000)] }).catch(() => {});
      }
      const rs = await tc.execute({ sql: 'SELECT count, reset_at FROM ps_rate_limits WHERE key = ? LIMIT 1', args: [key] });
      const row = rs.rows && rs.rows[0] ? rs.rows[0] : { count: 1, reset_at: nextResetAt };
      const count = Number(row.count || 0);
      const resetAt = Number(row.reset_at || nextResetAt);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
    } catch (e) {
      console.warn('[sharedRateLimit:turso] falling back to in-memory limiter:', e && e.message);
      return rateLimit({ key, limit, windowMs });
    }
  }
  // Neon rate-limit path removed. If we reach here, Turso primary is not set,
  // so we fall back to the in-memory limiter.
  return rateLimit({ key, limit, windowMs });
}

export function clientIp(c) {
  return c.req.header('cf-connecting-ip')
      || (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
      || c.req.header('x-real-ip') || '0.0.0.0';
}

export async function authRateLimit(c, next) {
  const ip = clientIp(c);
  const r = await sharedRateLimit({ key: 'auth:' + ip + ':' + c.req.path, limit: 40, windowMs: 15 * 60_000 });
  if (!r.allowed) {
    c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
    return c.json({ error: 'Too many auth attempts. Try again in 15 minutes.' }, 429);
  }
  await next();
}

export async function globalRateLimit(c, next) {
  // v77-bugfix: Use a hybrid approach for global rate limiting:
  // 1. Fast in-memory check first (400 req/min per IP) for quick rejection of obvious abuse
  // 2. For paths that don't need DB checks (/api/health, /api/push/vapid-public), skip shared check
  // 3. For all other paths, the auth rate limiting is handled by authRateLimit + authSubjectRateLimit
  //
  // This balances performance (no DB round-trip for every request) with security
  // (auth endpoints are still protected by sharedRateLimit via authRateLimit middleware).
  const ip = clientIp(c);
  const path = c.req.path;
  
  // Fast paths that don't need shared rate limiting
  const fastPaths = ['/api/health', '/api/push/vapid-public', '/api/stream'];
  const isFastPath = fastPaths.some(p => path === p || path.startsWith(p));
  
  if (isFastPath) {
    // In-memory only for fast paths
    const r = rateLimit({ key: 'global:' + ip, limit: 400, windowMs: 60_000 });
    c.header('X-RateLimit-Limit', '400');
    c.header('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many requests. Please slow down.' }, 429);
    }
  } else {
    // Use shared rate limiting for other paths (writes are batched/async in sharedRateLimit)
    const r = await sharedRateLimit({ key: 'global:' + ip, limit: 400, windowMs: 60_000 });
    c.header('X-RateLimit-Limit', '400');
    c.header('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many requests. Please slow down.' }, 429);
    }
  }
  await next();
}

// Brute-force lockout - v77-bugfix: Now persisted to Turso for cross-isolate consistency
// In-memory cache is used as a fast local check + fallback when Turso is unavailable
export const _loginFails = new Map();

export async function checkAccountLock(userId) {
  const now = Date.now();
  
  // Try Turso first for cross-isolate consistency
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      const rs = await tursoClient().execute({
        sql: 'SELECT count, first_at, locked_until FROM ps_rate_limits WHERE key = ? LIMIT 1',
        args: ['lockout:' + userId],
      });
      if (rs.rows && rs.rows.length > 0) {
        const row = rs.rows[0];
        const lockedUntil = Number(row.locked_until || 0);
        if (lockedUntil > now) {
          return { locked: true, remaining: lockedUntil - now };
        }
      }
      return { locked: false };
    } catch (e) {
      console.warn('[checkAccountLock:turso] falling back to in-memory:', e && e.message);
    }
  }
  
  // Fallback to in-memory
  const rec = _loginFails.get(userId);
  if (!rec) return { locked: false };
  if (rec.lockedUntil && rec.lockedUntil > now) return { locked: true, remaining: rec.lockedUntil - now };
  return { locked: false };
}

export async function recordLoginFail(userId) {
  const now = Date.now();
  const fiveMinutesAgo = now - 5 * 60_000;
  
  // Update in-memory for this isolate
  let rec = _loginFails.get(userId);
  if (!rec || (now - rec.firstAt) > 5 * 60_000) { 
    rec = { count: 0, firstAt: now }; 
    _loginFails.set(userId, rec); 
  }
  rec.count++;
  if (rec.count >= 5) rec.lockedUntil = now + 15 * 60_000;
  
  // Persist to Turso for cross-isolate consistency
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      const key = 'lockout:' + userId;
      const lockoutDuration = 15 * 60_000;
      const windowDuration = 5 * 60_000;
      
      // Atomic upsert: insert new or update existing
      // If first_at is older than 5 minutes, reset the counter
      await tursoClient().execute({
        sql: `INSERT INTO ps_rate_limits (key, count, first_at, reset_at, locked_until, updated_at) 
              VALUES (?, 1, ?, ?, 0, ?)
              ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN first_at < ? THEN 1 ELSE count + 1 END,
                first_at = CASE WHEN first_at < ? THEN ? ELSE first_at END,
                locked_until = CASE 
                  WHEN first_at < ? THEN 0
                  WHEN count + 1 >= 5 THEN ?
                  ELSE locked_until 
                END,
                updated_at = ?`,
        args: [
          key, now, now + windowDuration, now,  // INSERT values
          fiveMinutesAgo,                        // reset if first_at < 5min ago
          fiveMinutesAgo, now,                   // update first_at if needed
          fiveMinutesAgo, now + lockoutDuration, // set locked_until if count >= 5
          now
        ],
      });
    } catch (e) {
      console.warn('[recordLoginFail:turso] error:', e && e.message);
    }
  }
}

export async function clearLoginFails(userId) {
  _loginFails.delete(userId);
  
  // Clear from Turso too
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      await tursoClient().execute({
        sql: 'DELETE FROM ps_rate_limits WHERE key = ?',
        args: ['lockout:' + userId],
      });
    } catch (e) {
      console.warn('[clearLoginFails:turso] error:', e && e.message);
    }
  }
}

export const AUTH_GENERIC_ERROR = 'Invalid username/email or password.';

export async function authFailureDelay() {
  await sleepMs(250 + Math.floor(Math.random() * 250));
}

export async function authSubjectRateLimit(c, subject, limit = 10) {
  const ip = clientIp(c);
  const key = 'credential:' + ip + ':' + (subject || 'unknown');
  return sharedRateLimit({ key, limit, windowMs: 15 * 60_000 });
}
