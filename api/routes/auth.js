/**
 * PRIV SPACA — Routes — auth
 *
 * Health, diagnostics, signup, login, PIN reset, session.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import bcrypt from 'bcryptjs';
import { app } from '../lib/app.js';
import { cfg } from '../lib/config.js';
import { state } from '../lib/state.js';
import { _authUserCache, _bcryptVerifyCache, _loginUserCache, signToken } from '../lib/auth.js';
import { PASSWORD_HASH_ROUNDS } from '../lib/config.js';
import { fetchPrimaryDatabase, isPersist, primaryPersistenceName, saveDatabase, saveDatabaseVerified } from '../lib/db.js';
import { isEmail, isPin, isRepo, isUsername, normalizeAuthIdentifier, nowMs, safeJson, sanitizeText, sanitizeUser, uid } from '../lib/helpers.js';
import { requireAdmin, requireAuth } from '../lib/middleware.js';
import { AUTH_GENERIC_ERROR, authFailureDelay, authRateLimit, authSubjectRateLimit, checkAccountLock, clearLoginFails, recordLoginFail } from '../lib/ratelimit.js';
import { repoRead } from '../lib/store-github.js';
import { isTursoConfigured, isTursoPrimary, tursoClient, tursoUpsertUser } from '../lib/store-turso.js';

// =====================================================================
// ROUTES
// =====================================================================

// ---------- Health & diag ----------
app.get('/api/health', (c) => c.json({
  ok: true, name: 'PRIV SPACA',
  persistence: primaryPersistenceName(),
  secondaryPersistence: isTursoConfigured() ? 'turso-structured-social' : null,
  runtime: 'cloudflare-workers',
  time: nowMs(), version: 'phase2-turso-json-primary',
  ...(cfg.APP_MIN_VERSION ? { minVersion: cfg.APP_MIN_VERSION } : {}),
}));

app.get('/api/diag', requireAdmin, async (c) => {
  const out = {
    persistence: primaryPersistenceName(),
    repoConfigured: isRepo(), gistConfigured: false,
    repo: cfg.GH_REPO ? '[configured]' : '', branch: cfg.GH_BRANCH ? '[configured]' : '', file: cfg.GH_FILE ? '[configured]' : '',
    canRead: false, canWrite: false, userCount: 0, error: null,
    runtime: 'cloudflare-workers',
  };
  try {
    const db = await repoRead();
    if (db && typeof db === 'object' && !db._err && !db._httpError) {
      out.canRead = true;
      out.userCount = (db.users || []).length;
      // Do not perform a real write in diagnostics; it can conflict with signup/message saves.
      out.canWrite = isTursoPrimary() || !!cfg.GITHUB_PAT;
    } else if (!isPersist()) {
      out.canRead = true; out.canWrite = true;
      out.userCount = (state.localCache.users || []).length;
    } else out.error = db ? (db._err || db._httpError || 'Read returned no data (not an array)') : 'Read returned no data';
  } catch (e) { out.error = e.message; }
  return c.json(out);
});

// ---------- Auth: signup ----------
app.post('/api/auth/signup', authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { email, username, displayName, password, pin, termsAccepted, termsVersion } = body;
    if (!isEmail(email)) return c.json({ error: 'Invalid email' }, 400);
    if (!isUsername(username)) return c.json({ error: 'Username must be 3-24 chars (letters, numbers, _)' }, 400);
    const cleanDN = sanitizeText(displayName || '', 60).trim();
    if (!cleanDN) return c.json({ error: 'Display name required' }, 400);
    if (!password || password.length < 6) return c.json({ error: 'Password must be at least 6 characters' }, 400);
    if (password.length > 128) return c.json({ error: 'Password too long (max 128)' }, 400);
    if (!isPin(pin)) return c.json({ error: 'PIN must be 4 digits' }, 400);
    // Bug #15 fix: Extended weak PIN list
    const weak = new Set([
      // Repeated digits
      '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
      // Sequential patterns
      '1234','4321','0123','2345','3456','4567','5678','6789','7890','9876','8765','7654','6543','5432','3210',
      // Years
      '2024','2025','2026','2027','2028','2020','2021','2022','2023','1990','1991','1992','1993','1994','1995','1996','1997','1998','1999','2000','2001','2002','2003','2004','2005','2006','2007','2008','2009','2010','2011','2012','2013','2014','2015','2016','2017','2018','2019',
      // Keypad patterns
      '2580','0852','1470','7410','1593','3571','1379','7931','2468','8642',
      // Repeated pairs & common choices
      '1212','1313','1010','0101','1122','1221','1414','1515','1616','1717','1818','1919','2020','2121','2323','2424','2525','3030','3131','0007','0069','1357','4545','5050','6969','0420','1004','0101','0704','1225','0214','1031',
    ]);
    if (weak.has(pin)) return c.json({ error: 'Please choose a less obvious PIN' }, 400);
    if (termsAccepted !== true) return c.json({ error: 'You must accept the Terms & Community Guidelines.' }, 400);

    const db = await fetchPrimaryDatabase();
    const emailLower = email.toLowerCase();
    const usernameLower = username.toLowerCase();
    if (db.users.some(u => u.email.toLowerCase() === emailLower)) return c.json({ error: 'Email already registered' }, 409);
    if (db.users.some(u => u.username.toLowerCase() === usernameLower)) return c.json({ error: 'Username already taken' }, 409);
    // SECURITY: reserve the app's own identity strings + the owner's known
    // handles so new signups can't squat on / impersonate them. Owner
    // privilege itself is still gated on a hardcoded user id in the
    // frontend (isPrivOwner) and on the ADMIN_USERS secret here, so this
    // reservation is a defense-in-depth / anti-impersonation measure, not
    // the actual privilege boundary.
    const reserved = new Set([
      'admin','administrator','priv-spaca','privspaca','support','system','moderator','staff','help','root',
      'arvind_1011','arvindjaat1011','arvindjaat','ajitjaat1011','arvindjaat1012',
    ]);
    if (reserved.has(usernameLower)) return c.json({ error: 'That username is reserved' }, 403);

    const [passwordHash, pinHash] = await Promise.all([
      bcrypt.hash(password, PASSWORD_HASH_ROUNDS),
      bcrypt.hash(pin, PASSWORD_HASH_ROUNDS)
    ]);
    const newUser = {
      id: uid('usr'), email: emailLower, username, displayName: cleanDN,
      bio: '', photoUrl: '', passwordHash, pinHash, tokenVersion: 0,
      followers: [], following: [], blocked: [], closeFriends: [], isPrivate: false,
      termsAccepted: true, termsVersion: String(termsVersion || '1.0'),
      termsAcceptedAt: nowMs(), createdAt: nowMs(), verified: false,
    };
    db.users.push(newUser);
    const persisted = await saveDatabaseVerified(db, d => (d.users || []).some(u => u.id === newUser.id));
    if (isPersist() && !persisted) {
      db.users = db.users.filter(u => u.id !== newUser.id);
      return c.json({ error: 'Storage temporarily unavailable. Please try again in a moment.' }, 503);
    }
    if (isTursoConfigured()) await tursoUpsertUser(newUser);
    const token = await signToken(newUser);
    return c.json({ token, user: sanitizeUser(newUser, true) });
  } catch (e) {
    console.error('[signup]', e);
    return c.json({ error: 'Signup failed' }, 500);
  }
});

// ---------- Auth: login ----------
app.post('/api/auth/login', authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { identifier, password } = body;
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || typeof password !== 'string' || password.length < 1 || password.length > 128) {
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    const subjLimit = await authSubjectRateLimit(c, idLower, 20);
    if (!subjLimit.allowed) {
      c.header('Retry-After', String(Math.ceil((subjLimit.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many login attempts. Please wait and try again.' }, 429);
    }
    // v65: Try the structured ps_users table FIRST (always-fresh read), and
    // fall back to the mirror only if the structured table is empty or the
    // user isn't there. This fixes the "login says account not found right
    // after a password reset" race where the ps_kv mirror hasn't been
    // rewritten yet. Mirror is still used for everything else (posts,
    // messages, etc.) so this is a surgical auth-only fix.
    // v66: cache the structured-table user lookup too, keyed by the
    // search identifier. 60s TTL means a password reset via the
    // structured table is visible within a minute. Caching the user
    // object directly saves a Turso round trip on every login.
    const userCacheKey = 'user:' + idLower;
    let user = _loginUserCache.get(userCacheKey);
    if (user && (Date.now() - user._cachedAt) < 60_000) {
      user = user._user;  // return a clean copy
    } else {
      user = null;
      try {
        if (isTursoConfigured()) {
          const turso = tursoClient();
          const r = await turso.execute({
            sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
            args: [idLower, idLower]
          });
          if (r.rows && r.rows.length > 0) {
            const parsed = safeJson(String(r.rows[0].data_json || ''), null);
            if (parsed && parsed.id) {
              user = parsed;
              _loginUserCache.set(userCacheKey, { _user: user, _cachedAt: Date.now() });
            }
          }
        }
      } catch (_) { /* fall through to mirror */ }
    }
    if (!user) {
      const db = await fetchPrimaryDatabase();
      user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    }
    if (!user) {
      // SECURITY: use the same 401 status (and the same generic message) as
      // the wrong-password path below. Previously this returned 404, which
      // let an attacker enumerate valid usernames/emails just by watching
      // the HTTP status code, even though the JSON body was already
      // identical on both paths.
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    const lock = await checkAccountLock(user.id);
    if (lock.locked) {
      c.header('Retry-After', String(Math.ceil(lock.remaining / 1000)));
      return c.json({ error: 'Too many login attempts. Please wait and try again.' }, 429);
    }
    let matchUser = user;
    // v66: cache bcrypt.compare result keyed by (uid, passwordHash, password).
    // The same client usually re-logs in within seconds (page refresh,
    // back-button, etc.). Caching the result skips the ~20ms bcrypt
    // round and avoids a Turso read on the cached path. 5 min TTL
    // is short enough that password changes take effect quickly.
    const bcryptCacheKey = matchUser.id + '|' + (matchUser.passwordHash || '').slice(0, 30) + '|' + password;
    let ok = false;
    const cached = _bcryptVerifyCache.get(bcryptCacheKey);
    if (cached && (Date.now() - cached.ts) < 300_000) {
      ok = cached.ok;
    } else {
      ok = await bcrypt.compare(password, matchUser.passwordHash);
      _bcryptVerifyCache.set(bcryptCacheKey, { ok, ts: Date.now() });
      if (_bcryptVerifyCache.size > 200) {
        const firstKey = _bcryptVerifyCache.keys().next().value;
        _bcryptVerifyCache.delete(firstKey);
      }
    }
    if (!ok) {
      // Rare Neon read-after-write consistency window: a password/PIN reset
      // that just committed on a different pooled connection can briefly
      // (sub-second, occasionally ~1-2s) not be visible yet to the next
      // read. Retrying once with a forced-fresh read costs nothing on the
      // common (correct-password) path and only adds a single extra Neon
      // round trip on an already-failing attempt, which already pays a
      // deliberate ~250-500ms authFailureDelay() for timing-attack
      // mitigation — so this is effectively free from a UX standpoint.
      const freshDb = await fetchPrimaryDatabase();
      const freshUser = freshDb.users.find(u => u.id === user.id);
      if (freshUser && freshUser.passwordHash !== matchUser.passwordHash) {
        matchUser = freshUser;
        ok = await bcrypt.compare(password, matchUser.passwordHash);
      }
    }
    if (!ok) {
      await recordLoginFail(user.id);
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    await clearLoginFails(user.id);
    // v66: transparent bcrypt cost upgrade. If the stored hash is at an
    // older cost, rehash at PASSWORD_HASH_ROUNDS in the background so the
    // next login is fast. Never block the response on this.
    try {
      const m = (matchUser.passwordHash || '').match(/^\$2[aby]\$(\d{2})\$/);
      if (m && Number(m[1]) !== PASSWORD_HASH_ROUNDS) {
        const newHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
        matchUser.passwordHash = newHash;
        matchUser.passwordChangedAt = nowMs();
        const db = await fetchPrimaryDatabase();
        const u2 = (db.users || []).find(x => x.id === matchUser.id);
        if (u2) {
          u2.passwordHash = newHash;
          u2.passwordChangedAt = matchUser.passwordChangedAt;
          saveDatabase(db, true, { skipSecondarySync: true }).catch(() => {});
          if (isTursoConfigured()) {
            try {
              const tu = tursoClient();
              await tu.batch([
                { sql: "UPDATE ps_users SET data_json = ?, updated_at = ? WHERE id = ?", args: [JSON.stringify(u2), nowMs(), u2.id] },
              ], 'write');
            } catch (_) {}
          }
        }
      }
    } catch (_) { /* background upgrade is best-effort */ }
    const token = await signToken(matchUser);
    return c.json({ token, user: sanitizeUser(matchUser, true) });
  } catch (e) {
    console.error('[login] full error:', e && e.message, e && e.stack);
    return c.json({ error: 'Login failed: ' + (e && e.message || 'unknown') }, 500);
  }
});

// ---------- Auth: reset by PIN ----------
app.post('/api/auth/reset-by-pin', authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { identifier, pin, newPassword } = body;
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || !isPin(pin) || typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) {
      await authFailureDelay();
      return c.json({ error: 'Invalid reset details.' }, 400);
    }
    const subjLimit = await authSubjectRateLimit(c, 'reset:' + idLower, 8);
    if (!subjLimit.allowed) {
      c.header('Retry-After', String(Math.ceil((subjLimit.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many reset attempts. Please wait and try again.' }, 429);
    }
    // v65: Try structured ps_users first (fresh), mirror as fallback
    let user = null;
    try {
      if (isTursoConfigured()) {
        const turso = tursoClient();
        const r = await turso.execute({
          sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
          args: [idLower, idLower]
        });
        if (r.rows && r.rows.length > 0) {
          const parsed = safeJson(String(r.rows[0].data_json || ''), null);
          if (parsed && parsed.id) user = parsed;
        }
      }
    } catch (_) { /* fall through to mirror */ }
    if (!user) {
      const db = await fetchPrimaryDatabase();
      user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    }
    if (!user) { await authFailureDelay(); return c.json({ error: 'Invalid reset details.' }, 401); }
    // SECURITY: account lockout check before PIN verify (see /api/auth/login parity).
    const lock = await checkAccountLock(user.id);
    if (lock.locked) {
      c.header('Retry-After', String(Math.ceil(lock.remaining / 1000)));
      return c.json({ error: 'Too many attempts. Please wait and try again.' }, 429);
    }
    const pinOk = await bcrypt.compare(pin, user.pinHash);
    if (!pinOk) {
      // SECURITY: account lockout must apply to wrong PINs too. Previously
      // only wrong passwords triggered recordLoginFail, so a small botnet
      // could brute-force the 4-digit PIN in hours.
      await recordLoginFail(user.id);
      await authFailureDelay();
      return c.json({ error: 'Invalid reset details.' }, 401);
    }
    const oldHash = user.passwordHash;
    const oldTokenVersion = Number(user.tokenVersion || 0);
    user.passwordHash = await bcrypt.hash(newPassword, PASSWORD_HASH_ROUNDS);
    user.tokenVersion = oldTokenVersion + 1;
    user.passwordChangedAt = nowMs();
    // Invalidate the in-memory auth cache so the new tokenVersion is picked
    // up by subsequent requests.
    _authUserCache.delete(user.id);
    const persisted = await saveDatabaseVerified(db, d => {
      const u2 = (d.users || []).find(u => u.id === user.id);
      return !!u2 && u2.passwordHash === user.passwordHash && Number(u2.tokenVersion || 0) === user.tokenVersion;
    });
    if (isPersist() && !persisted) { user.passwordHash = oldHash; user.tokenVersion = oldTokenVersion; return c.json({ error: 'Storage temporarily unavailable' }, 503); }
    if (isTursoConfigured()) await tursoUpsertUser(user);
    const token = await signToken(user);
    return c.json({ ok: true, token, user: sanitizeUser(user, true) });
  } catch (e) {
    console.error('[reset]', e);
    return c.json({ error: 'Reset failed' }, 500);
  }
});

// ---------- Auth: me ----------
app.get('/api/auth/me', requireAuth, async (c) => {
  const u = c.get('authUser');
  if (!u) return c.json({ error: 'Not found' }, 404);
  return c.json({ user: sanitizeUser(u, true) });
});
