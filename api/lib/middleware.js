/**
 * PRIV SPACA — Library — middleware
 *
 * Hono middleware: requireAuth / requireAdmin.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { cfg } from './config.js';
import { _AUTH_CACHE_TTL_MS, _authUserCache, authFromRequest } from './auth.js';
import { fetchPrimaryDatabase } from './db.js';
import { isAdminUser } from './helpers.js';
import { fetchTursoUserById, isTursoConfigured } from './store-turso.js';

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

  // Production revocation checks must cross the isolate boundary. A module Map
  // cannot be authoritative: another isolate may have processed logout or a
  // password reset, and a stale Map would either accept the revoked cookie or
  // reject the freshly issued one for its full TTL. Read the small structured
  // user row on every Turso-backed authenticated request and fail closed when
  // that durable check is unavailable.
  if (isTursoConfigured()) {
    let durableUser;
    try {
      durableUser = await fetchTursoUserById(p.uid);
    } catch (error) {
      console.warn('[requireAuth] durable session check failed:', error && error.message);
      return c.json({ error: 'Authentication temporarily unavailable. Please retry.' }, 503);
    }
    if (!durableUser) return c.json({ error: 'Missing or invalid token' }, 401);
    if (Number(p.sv || 0) !== Number(durableUser.tokenVersion || 0)) {
      // A reset response can reach the client just before a different database
      // replica observes its new tokenVersion. Retry within this request's
      // libSQL session before rejecting; a genuinely revoked token still fails.
      try { durableUser = await fetchTursoUserById(p.uid) || durableUser; }
      catch (_) { return c.json({ error: 'Authentication temporarily unavailable. Please retry.' }, 503); }
      if (Number(p.sv || 0) !== Number(durableUser.tokenVersion || 0)) {
        return c.json({ error: 'Session expired. Please sign in again.' }, 401);
      }
    }
    _authUserCache.set(p.uid, { user: durableUser, fetchedAt: Date.now() });
    c.set('userId', p.uid);
    c.set('username', durableUser.username || p.username);
    c.set('authUser', durableUser);
    await next();
    return;
  }

  // Local in-memory development has only one process, so this fast path is
  // safe after invalidateUserAuthCaches() clears it on every auth mutation.
  const cached = _authUserCache.get(p.uid);
  if (cached && (Date.now() - cached.fetchedAt) < _AUTH_CACHE_TTL_MS
      && Number(p.sv || 0) === Number(cached.user.tokenVersion || 0)) {
    c.set('userId', p.uid);
    c.set('username', cached.user.username || p.username);
    c.set('authUser', cached.user);
    await next();
    return;
  }
  // Slow local path: read the in-memory primary, then warm the cache
  const authDb = await fetchPrimaryDatabase();
  const u = (authDb.users || []).find(x => x.id === p.uid);
  if (!u) return c.json({ error: 'Missing or invalid token' }, 401);
  if (Number(p.sv || 0) !== Number(u.tokenVersion || 0)) {
    return c.json({ error: 'Session expired. Please sign in again.' }, 401);
  }
  _authUserCache.set(p.uid, { user: u, fetchedAt: Date.now() });
  c.set('userId', p.uid);
  c.set('username', u.username || p.username);
  c.set('authUser', u);
  await next();
}
