/**
 * PRIV SPACA — Library — middleware
 *
 * Hono middleware: requireAuth / requireAdmin.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { cfg } from './config.js';
import { state } from './state.js';
import { _AUTH_CACHE_TTL_MS, _authUserCache, authFromRequest } from './auth.js';
import { fetchPrimaryDatabase } from './db.js';
import { isAdminUser } from './helpers.js';

export async function requireAdmin(c, next) {
  const auth = await requireAuth(c, async () => {});
  if (auth instanceof Response) return auth;
  const db = await fetchPrimaryDatabase();
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!isAdminUser(u)) return c.json({ error: 'Admin only' }, 403);
  c.set('adminUser', u);
  c.set('adminDb', db);
  await next();
}

   // 30s is plenty for auth validation

// Hono middleware
export async function requireAuth(c, next) {
  // v90: Force version gate — reject ALL authed requests from stale clients.
  // The client sends its APP_VERSION in the X-App-Version header. If the
  // server has APP_MIN_VERSION set and the client version is older, we
  // return 426 so the client knows to reload. We also check the /sw.js
  // probe response which already carries SW_VERSION.
  if (cfg.APP_MIN_VERSION) {
    const clientVer = c.req.header('x-app-version') || '';
    // v93.3.1 FIX: parseV regex was /v(\d+)$/ which requires the string to
    // END with v<number>. For versions like 'priv-spaca-v93.3' the '.3'
    // suffix broke the match and returned 0, causing the server to 426-
    // reject v93.3 clients as "stale" and force a logout loop.
    // New regex extracts the full numeric version (supports decimals).
    const parseV = (v) => {
      const m = String(v).match(/v(\d+(?:\.\d+)*)/);
      if (!m) return 0;
      const parts = m[1].split('.').map(n => parseInt(n, 10) || 0);
      return parts.reduce((acc, n, i) => acc + n * Math.pow(1000, 3 - i), 0);
    };
    if (parseV(clientVer) < parseV(cfg.APP_MIN_VERSION)) {
      return c.json({
        error: 'App update required',
        minVersion: cfg.APP_MIN_VERSION,
        upgradeUrl: '/?v=' + Date.now(),
      }, 426);
    }
  }
  const p = await authFromRequest(c);
  if (!p || !p.uid) return c.json({ error: 'Missing or invalid token' }, 401);
  // Fast path: in-memory cache hit
  const cached = _authUserCache.get(p.uid);
  if (cached && (Date.now() - cached.fetchedAt) < _AUTH_CACHE_TTL_MS) {
    if (Number(p.sv || 0) !== Number(cached.user.tokenVersion || 0)) {
      return c.json({ error: 'Session expired. Please sign in again.' }, 401);
    }
    c.set('userId', p.uid);
    c.set('username', cached.user.username || p.username);
    c.set('authUser', cached.user);
    await next();
    return;
  }
  // Slow path: read from Turso, then warm the cache
  let authDb = await fetchPrimaryDatabase();
  let u = (authDb.users || []).find(x => x.id === p.uid);
  if (!u) return c.json({ error: 'Missing or invalid token' }, 401);
  const tokenVersion = Number(p.sv || 0);
  let userVersion = Number(u.tokenVersion || 0);
  if (tokenVersion !== userVersion) {
    // Same rare Neon read-after-write consistency window as login (see the
    // matching comment in /api/auth/login): a password/PIN reset that just
    // bumped tokenVersion on one connection can briefly not be visible yet
    // on the next read. Without this retry, the very token that reset-by-pin
    // just handed back to the client could get rejected on its first use a
    // moment later. One forced-fresh re-read fixes it without weakening the
    // real security property (a token whose version genuinely doesn't match
    // — e.g. because of an actual later password change — still gets
    // rejected after the retry).
    state.cacheTimestamp = 0;
    authDb = await fetchPrimaryDatabase();
    u = (authDb.users || []).find(x => x.id === p.uid) || u;
    userVersion = Number(u.tokenVersion || 0);
    if (tokenVersion !== userVersion) return c.json({ error: 'Session expired. Please sign in again.' }, 401);
  }
  _authUserCache.set(p.uid, { user: u, fetchedAt: Date.now() });
  c.set('userId', p.uid);
  c.set('username', u.username || p.username);
  c.set('authUser', u);
  await next();
}
