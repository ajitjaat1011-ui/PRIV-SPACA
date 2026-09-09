/**
 * PRIV SPACA — Library — ratelimit
 *
 * Rate limiting and login lockout.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { sleepMs } from './helpers.js';
import { isDbPrimary, dbClient, dbEnsure } from './store.js';
import { supervisedTask } from './omni-engine.js';

// ---------- Rate limiting ----------
// v77-bugfix: In-memory rate limiter is ONLY used as fallback when the store is unreachable.
// For cross-isolate consistency, use sharedRateLimit() which persists to the store.
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
  if (isDbPrimary()) {
    try {
      await dbEnsure();
      const tc = dbClient();
      await tc.execute({
        sql: `INSERT INTO ps_rate_limits (key, count, reset_at, updated_at) VALUES (?, 1, ?, ?)
              ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN ps_rate_limits.reset_at <= ? THEN 1 ELSE ps_rate_limits.count + 1 END,
                reset_at = CASE WHEN ps_rate_limits.reset_at <= ? THEN ? ELSE ps_rate_limits.reset_at END,
                updated_at = ?`,
        // v183 (Supabase): bare column references on the DO UPDATE right-hand
        // side are ambiguous in Postgres (table column vs. the excluded row);
        // table qualification is valid in both SQLite and Postgres.
        args: [key, nextResetAt, now, now, now, nextResetAt, now],
      });
      if (Math.random() < 0.01) {
        supervisedTask(null, tc.execute({
          sql: 'DELETE FROM ps_rate_limits WHERE reset_at < ?',
          args: [now - (24 * 60 * 60 * 1000)],
        }), 'ratelimit.cleanup');
      }
      const rs = await tc.execute({ sql: 'SELECT count, reset_at FROM ps_rate_limits WHERE key = ? LIMIT 1', args: [key] });
      const row = rs.rows && rs.rows[0] ? rs.rows[0] : { count: 1, reset_at: nextResetAt };
      const count = Number(row.count || 0);
      const resetAt = Number(row.reset_at || nextResetAt);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
    } catch (e) {
      console.warn('[sharedRateLimit:db] falling back to in-memory limiter:', e && e.message);
      return rateLimit({ key, limit, windowMs });
    }
  }
  // Neon rate-limit path removed. If we reach here, no store primary is set,
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
  // Omni already applies tighter per-user and per-IP token buckets before this
  // guard. Keep this broad 400/minute abuse ceiling isolate-local so a normal
  // Tier 1 read does not pay two remote store operations merely to increment a
  // counter. Authentication has its own durable sharedRateLimit + account
  // lockout below and is intentionally not weakened by this fast path.
  const ip = clientIp(c);
  const r = rateLimit({ key: 'global:' + ip, limit: 400, windowMs: 60_000 });
  c.header('X-RateLimit-Limit', '400');
  c.header('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000))));
    return c.json({ error: 'Too many requests. Please slow down.' }, 429);
  }
  await next();
}

// Brute-force lockout - v77-bugfix: Now persisted to the store for cross-isolate consistency
// In-memory cache is used as a fast local check + fallback when the store is unavailable
export const _loginFails = new Map();

export async function checkAccountLock(userId) {
  const now = Date.now();
  
  // Try the store first for cross-isolate consistency
  if (isDbPrimary()) {
    try {
      await dbEnsure();
      const rs = await dbClient().execute({
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
      console.warn('[checkAccountLock:db] falling back to in-memory:', e && e.message);
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
  
  // Persist to the store for cross-isolate consistency
  if (isDbPrimary()) {
    try {
      await dbEnsure();
      const key = 'lockout:' + userId;
      const lockoutDuration = 15 * 60_000;
      const windowDuration = 5 * 60_000;
      
      // Atomic upsert: insert new or update existing
      // If first_at is older than 5 minutes, reset the counter
      await dbClient().execute({
        sql: `INSERT INTO ps_rate_limits (key, count, first_at, reset_at, locked_until, updated_at) 
              VALUES (?, 1, ?, ?, 0, ?)
              ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN ps_rate_limits.first_at < ? THEN 1 ELSE ps_rate_limits.count + 1 END,
                first_at = CASE WHEN ps_rate_limits.first_at < ? THEN ? ELSE ps_rate_limits.first_at END,
                locked_until = CASE 
                  WHEN ps_rate_limits.first_at < ? THEN 0
                  WHEN ps_rate_limits.count + 1 >= 5 THEN ?
                  ELSE ps_rate_limits.locked_until 
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
      console.warn('[recordLoginFail:db] error:', e && e.message);
    }
  }
}

export async function clearLoginFails(userId) {
  _loginFails.delete(userId);
  
  // Clear from the store too
  if (isDbPrimary()) {
    try {
      await dbEnsure();
      await dbClient().execute({
        sql: 'DELETE FROM ps_rate_limits WHERE key = ?',
        args: ['lockout:' + userId],
      });
    } catch (e) {
      console.warn('[clearLoginFails:db] error:', e && e.message);
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
