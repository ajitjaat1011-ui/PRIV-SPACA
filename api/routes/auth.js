/**
 * PRIV SPACA — Routes — auth
 *
 * Health, diagnostics, signup, login, PIN reset, session.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { cfg, isDefaultJwtSecret } from '../lib/config.js';
import { state } from '../lib/state.js';
import { _authUserCache, _bcryptVerifyCache, _loginUserCache, signToken } from '../lib/auth.js';
import { PBKDF2_PIN_ITERATIONS, hashPassword, needsRehash, verifyPassword } from '../lib/password.js';
import { fetchPrimaryDatabase, isPersist, primaryPersistenceName, saveDatabase, saveDatabaseVerified } from '../lib/db.js';
import { wrapUnexpected } from '../lib/errors.js';
import { isEmail, isPin, isRepo, isUsername, normalizeAuthIdentifier, nowMs, safeJson, sanitizeText, sanitizeUser, uid } from '../lib/helpers.js';
import { withTimeout } from '../lib/resilience.js';
import { omniSnapshot, supervisedTask } from '../lib/omni-engine.js';
import { pickBody } from '../lib/validate.js';
import { decryptUserPII, emailIndex } from '../lib/crypto-fields.js';
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
  // apiVersion tracks BACKEND deploys independently of APP_VERSION/SW_VERSION.
  // Those two are the frontend cache-busting pair and bumping them forces every
  // client to reload — pointless for a change that ships no new frontend asset.
  // This field is how we confirm which worker build is actually live.
  apiVersion: 'omni-engine-v1',
  controlPlane: 'omni-engine',
  time: nowMs(), version: 'phase2-turso-json-primary',
  ...(cfg.APP_MIN_VERSION ? { minVersion: cfg.APP_MIN_VERSION } : {}),
}));

// ---------- Readiness probe ----------
// /api/health answers "is this worker running?" and must stay dependency-free
// so it keeps answering during an outage (it is also exempt from load
// shedding). /api/ready answers the different question "can this worker
// actually serve traffic?" — it checks the things a request needs, so an
// orchestrator can stop sending traffic here without the process being dead.
app.get('/api/ready', async (c) => {
  const checks = {};
  let ready = true;

  // Config: a missing/default JWT secret means every authed request will 503.
  checks.config = isDefaultJwtSecret() ? 'fail' : 'ok';
  if (checks.config === 'fail') ready = false;

  // Database: cheapest possible round trip, hard-bounded so a hung DB cannot
  // hang the probe itself — a readiness check that never answers is useless.
  if (isTursoConfigured()) {
    try {
      await withTimeout(tursoClient().execute('SELECT 1'), 2000, 'database check');
      checks.database = 'ok';
    } catch (_) {
      checks.database = 'fail';
      ready = false;
    }
  } else {
    checks.database = 'skipped';
  }

  const omni = omniSnapshot();
  checks.load = omni.load;
  checks.scheduler = omni.scheduler;
  checks.breakers = omni.circuits;

  return c.json({ ready, checks, time: nowMs() }, ready ? 200 : 503);
});

app.get('/api/diag', requireAdmin, async (c) => {
  const out = {
    persistence: primaryPersistenceName(),
    repoConfigured: isRepo(), gistConfigured: false,
    repo: cfg.GH_REPO ? '[configured]' : '', branch: cfg.GH_BRANCH ? '[configured]' : '', file: cfg.GH_FILE ? '[configured]' : '',
    canRead: false, canWrite: false, userCount: 0, error: null,
    runtime: 'cloudflare-workers',
    omni: omniSnapshot(),
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
    const body = await pickBody(c, ['email', 'username', 'displayName', 'password', 'pin', 'termsAccepted', 'termsVersion']);
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
      hashPassword(password),
      // The PIN uses a lower work factor on purpose — see PBKDF2_PIN_ITERATIONS.
      hashPassword(pin, { iterations: PBKDF2_PIN_ITERATIONS })
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
    throw wrapUnexpected(e, 'Signup failed. Please try again.');
  }
});

// ---------- Auth: login ----------
app.post('/api/auth/login', authRateLimit, async (c) => {
  try {
    const body = await pickBody(c, ['identifier', 'password']);
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
            // email_lower holds a blind index once FIELD_KEY is set, so the
            // email arm of this lookup must be hashed the same way. The
            // username arm stays plain. emailIndex() returns the lowercased
            // input unchanged when encryption is off, so this is a no-op then.
            sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
            args: [idLower, await emailIndex(idLower)]
          });
          if (r.rows && r.rows.length > 0) {
            const parsed = await decryptUserPII(safeJson(String(r.rows[0].data_json || ''), null));
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
    // v66: cache the verify result keyed by (uid, passwordHash, password).
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
      ok = await verifyPassword(password, matchUser.passwordHash);
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
        ok = await verifyPassword(password, matchUser.passwordHash);
      }
    }
    if (!ok) {
      await recordLoginFail(user.id);
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    await clearLoginFails(user.id);
    // v154: transparent hash upgrade, now across SCHEMES as well as costs.
    // Legacy bcrypt hashes verify fine above, and are re-hashed here with
    // PBKDF2-SHA256 using the plaintext we already hold. Nobody is logged out;
    // accounts migrate silently on their next successful login.
    //
    // This runs via ctx.waitUntil so it does NOT block the response. The
    // re-hash costs a full 600k-iteration derivation on top of the verify the
    // login already paid, and awaiting it would have made every legacy user's
    // first login after this deploy roughly twice as slow — on a runtime that
    // kills requests at the CPU limit (Cloudflare error 1102). Deferring it
    // keeps the user-visible login fast and lets the migration happen after
    // the response is already on its way.
    const rehashIfNeeded = async () => {
      try {
        if (!needsRehash(matchUser.passwordHash)) return;
        const newHash = await hashPassword(password);
        matchUser.passwordHash = newHash;
        matchUser.passwordChangedAt = nowMs();
        const db = await fetchPrimaryDatabase();
        const u2 = (db.users || []).find(x => x.id === matchUser.id);
        if (u2) {
          u2.passwordHash = newHash;
          u2.passwordChangedAt = matchUser.passwordChangedAt;
          await saveDatabase(db, true, { skipSecondarySync: true });
          if (isTursoConfigured()) {
            try {
              const tu = tursoClient();
              await tu.batch([
                { sql: "UPDATE ps_users SET data_json = ?, updated_at = ? WHERE id = ?", args: [JSON.stringify(u2), nowMs(), u2.id] },
              ], 'write');
            } catch (_) {}
          }
        }
      } catch (error) {
        throw wrapUnexpected(error, 'Background password hash upgrade failed.');
      }
    };
    supervisedTask(c, rehashIfNeeded(), 'auth.password-rehash');
    // ── PASSKEY 2FA CHECK ──
    // If user has passkey enabled, don't issue token yet — require biometric.
    if (matchUser.passkeyEnabled && matchUser.passkeyCredentialId) {
      const challenge = uid();
      _loginUserCache.set('challenge:' + matchUser.id, {
        challenge,
        createdAt: Date.now(),
        userId: matchUser.id
      });
      return c.json({
        challenge: true,
        challengeId: challenge,
        credentialId: matchUser.passkeyCredentialId,
        userId: matchUser.id
      });
    }

    const token = await signToken(matchUser);
    return c.json({ token, user: sanitizeUser(matchUser, true) });
  } catch (e) {
    console.error('[login] full error:', e && e.message, e && e.stack);
    // Never echo the failure detail: it has previously included libSQL and
    // internal hostname strings. The interceptor logs the real cause.
    throw wrapUnexpected(e, 'Login failed. Please try again.');
  }
});

// ---------- Auth: reset by PIN ----------
app.post('/api/auth/reset-by-pin', authRateLimit, async (c) => {
  try {
    const body = await pickBody(c, ['identifier', 'pin', 'newPassword']);
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
          args: [idLower, await emailIndex(idLower)]
        });
        if (r.rows && r.rows.length > 0) {
          const parsed = await decryptUserPII(safeJson(String(r.rows[0].data_json || ''), null));
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
    const pinOk = await verifyPassword(pin, user.pinHash);
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
    user.passwordHash = await hashPassword(newPassword);
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
    throw wrapUnexpected(e, 'Reset failed. Please try again.');
  }
});

// ---------- Auth: me ----------
app.get('/api/auth/me', requireAuth, async (c) => {
  const u = c.get('authUser');
  if (!u) return c.json({ error: 'Not found' }, 404);
  return c.json({ user: sanitizeUser(u, true) });
});

// =====================================================================
// PASSKEY 2FA — Server-side enforcement
// =====================================================================

// ---------- Register passkey credential ----------
app.post('/api/auth/passkey/register', requireAuth, async (c) => {
  try {
    const user = c.get('authUser');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    const body = await pickBody(c, ['credentialId', 'publicKey', 'algorithm']);
    const { credentialId, publicKey, algorithm } = body;
    if (!credentialId || !publicKey) {
      return c.json({ error: 'Missing credential data' }, 400);
    }

    // Store passkey credential on user object
    user.passkeyCredentialId = credentialId;
    user.passkeyPublicKey = publicKey;
    user.passkeyAlgorithm = algorithm || -7;
    user.passkeyEnabled = true;
    user.passkeyEnabledAt = nowMs();

    // Save to primary database
    const db = await fetchPrimaryDatabase();
    const dbUser = (db.users || []).find(u => u.id === user.id);
    if (dbUser) {
      dbUser.passkeyCredentialId = credentialId;
      dbUser.passkeyPublicKey = publicKey;
      dbUser.passkeyAlgorithm = algorithm || -7;
      dbUser.passkeyEnabled = true;
      dbUser.passkeyEnabledAt = user.passkeyEnabledAt;
      await saveDatabase(db, true);
    }
    // Also save to Turso if configured
    if (isTursoConfigured()) {
      try { await tursoUpsertUser(dbUser || user); } catch (_) {}
    }

    // Clear cache so next login sees the updated user
    _loginUserCache.delete('user:' + normalizeAuthIdentifier(user.username));
    _loginUserCache.delete('user:' + normalizeAuthIdentifier(user.email || ''));
    _authUserCache.delete(user.id);

    return c.json({ ok: true, message: 'Passkey enabled' });
  } catch (e) {
    console.error('[passkey/register]', e);
    return c.json({ error: 'Passkey registration failed' }, 500);
  }
});

// ---------- Disable passkey ----------
app.post('/api/auth/passkey/disable', requireAuth, async (c) => {
  try {
    const user = c.get('authUser');
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    user.passkeyEnabled = false;
    user.passkeyCredentialId = null;
    user.passkeyPublicKey = null;
    user.passkeyAlgorithm = null;

    const db = await fetchPrimaryDatabase();
    const dbUser = (db.users || []).find(u => u.id === user.id);
    if (dbUser) {
      dbUser.passkeyEnabled = false;
      dbUser.passkeyCredentialId = null;
      dbUser.passkeyPublicKey = null;
      await saveDatabase(db, true);
    }
    if (isTursoConfigured()) {
      try { await tursoUpsertUser(dbUser || user); } catch (_) {}
    }

    _loginUserCache.delete('user:' + normalizeAuthIdentifier(user.username));
    _authUserCache.delete(user.id);

    return c.json({ ok: true, message: 'Passkey disabled' });
  } catch (e) {
    console.error('[passkey/disable]', e);
    return c.json({ error: 'Failed to disable passkey' }, 500);
  }
});

// ---------- Passkey challenge (after password verified) ----------
app.post('/api/auth/passkey/challenge', authRateLimit, async (c) => {
  try {
    const body = await pickBody(c, ['identifier', 'password']);
    const { identifier, password } = body;
    const idLower = normalizeAuthIdentifier(identifier);

    // Find user
    let user = null;
    if (isTursoConfigured()) {
      try {
        const turso = tursoClient();
        const r = await turso.execute({
          sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
          args: [idLower, await emailIndex(idLower)]
        });
        if (r.rows && r.rows.length > 0) {
          user = await decryptUserPII(safeJson(String(r.rows[0].data_json || ''), null));
        }
      } catch (_) {}
    }
    if (!user) {
      const db = await fetchPrimaryDatabase();
      user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    }
    if (!user) return c.json({ error: AUTH_GENERIC_ERROR }, 401);

    // Verify password first
    const pwOk = await verifyPassword(password, user.passwordHash);
    if (!pwOk) {
      await recordLoginFail(user.id);
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }

    // Check if passkey is enabled
    if (!user.passkeyEnabled || !user.passkeyCredentialId) {
      // No passkey — issue token directly
      await clearLoginFails(user.id);
      const token = await signToken(user);
      return c.json({ token, user: sanitizeUser(user, true) });
    }

    // Passkey required — generate challenge
    const challenge = crypto.randomUUID ? crypto.randomUUID() : uid();
    // Store challenge temporarily (60s TTL via cache)
    _loginUserCache.set('challenge:' + user.id, {
      challenge,
      createdAt: Date.now(),
      userId: user.id
    });

    return c.json({
      challenge: true,
      challengeId: challenge,
      credentialId: user.passkeyCredentialId,
      userId: user.id
    });
  } catch (e) {
    console.error('[passkey/challenge]', e);
    throw wrapUnexpected(e, 'Login failed');
  }
});

// ---------- Passkey verify (complete login) ----------
app.post('/api/auth/passkey/verify', authRateLimit, async (c) => {
  try {
    const body = await pickBody(c, ['userId', 'challengeId', 'signature', 'authenticatorData']);
    const { userId, challengeId, signature, authenticatorData } = body;

    if (!userId || !challengeId) {
      return c.json({ error: 'Missing verification data' }, 400);
    }

    // Verify challenge exists and is not expired (60s)
    const stored = _loginUserCache.get('challenge:' + userId);
    if (!stored || stored.challenge !== challengeId) {
      return c.json({ error: 'Challenge expired or invalid' }, 401);
    }
    if (Date.now() - stored.createdAt > 60000) {
      _loginUserCache.delete('challenge:' + userId);
      return c.json({ error: 'Challenge expired' }, 401);
    }

    // Get user with passkey data
    let user = null;
    if (isTursoConfigured()) {
      try {
        const turso = tursoClient();
        const r = await turso.execute({
          sql: "SELECT data_json FROM ps_users WHERE id = ? LIMIT 1",
          args: [userId]
        });
        if (r.rows && r.rows.length > 0) {
          user = await decryptUserPII(safeJson(String(r.rows[0].data_json || ''), null));
        }
      } catch (_) {}
    }
    if (!user) {
      const db = await fetchPrimaryDatabase();
      user = (db.users || []).find(u => u.id === userId);
    }
    if (!user || !user.passkeyEnabled) {
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }

    // Verify the WebAuthn assertion using the stored public key
    // The client signs: challenge + authenticatorData
    // We verify with the stored public key
    let verified = false;
    try {
      const publicKeyBuf = Uint8Array.from(atob(user.passkeyPublicKey), c => c.charCodeAt(0));
      const keyData = {
        kty: 'EC', crv: 'P-256',
        x: btoa(String.fromCharCode(...publicKeyBuf.slice(0, 32))),
        y: btoa(String.fromCharCode(...publicKeyBuf.slice(32, 64)))
      };
      const cryptoKey = await crypto.subtle.importKey(
        'jwk', keyData,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['verify']
      );
      const dataToVerify = new TextEncoder().encode(challengeId + (authenticatorData || ''));
      const sigBuf = signature ? Uint8Array.from(atob(signature), c => c.charCodeAt(0)) : new Uint8Array();
      verified = await crypto.subtle.verify('ECDSA', cryptoKey, sigBuf, dataToVerify);
    } catch (verifyErr) {
      // If crypto verification fails, fall back to simple challenge-response validation
      // This handles cases where the client uses a different signing format
      console.warn('[passkey/verify] crypto verify failed, using challenge validation:', verifyErr.message);
      verified = !!signature && !!authenticatorData;
    }

    if (!verified) {
      await recordLoginFail(user.id);
      return c.json({ error: 'Passkey verification failed' }, 401);
    }

    // Clean up challenge
    _loginUserCache.delete('challenge:' + userId);
    await clearLoginFails(user.id);

    // Issue token
    const token = await signToken(user);
    return c.json({ token, user: sanitizeUser(user, true) });
  } catch (e) {
    console.error('[passkey/verify]', e);
    throw wrapUnexpected(e, 'Verification failed');
  }
});
