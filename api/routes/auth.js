/**
 * PRIV SPACA — Routes — auth
 *
 * Health, diagnostics, signup, login, PIN reset, session.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { cfg, isDefaultJwtSecret, isMissingFieldKey } from '../lib/config.js';
import { state } from '../lib/state.js';
import { _bcryptVerifyCache, _loginUserCache, b64url, clearSessionCookie, invalidateUserAuthCaches, setSessionCookie, signToken, tokenFromRequest } from '../lib/auth.js';
import { PBKDF2_PIN_ITERATIONS, hashPassword, needsRehash, verifyPassword } from '../lib/password.js';
import { fetchPrimaryDatabase, isPersist, primaryPersistenceName, saveDatabase, saveDatabaseVerified } from '../lib/db.js';
import { wrapUnexpected } from '../lib/errors.js';
import { isEmail, isPin, isUsername, normalizeAuthIdentifier, nowMs, safeJson, sanitizeText, sanitizeUser, uid } from '../lib/helpers.js';
import { withTimeout } from '../lib/resilience.js';
import { omniSnapshot, supervisedTask } from '../lib/omni-engine.js';
import { pickBody } from '../lib/validate.js';
import { decryptUserPII, emailIndex } from '../lib/crypto-fields.js';
import { requireAdmin, requireAuth } from '../lib/middleware.js';
import { AUTH_GENERIC_ERROR, authFailureDelay, authRateLimit, authSubjectRateLimit, checkAccountLock, clearLoginFails, recordLoginFail } from '../lib/ratelimit.js';
import { fetchUserById, isDbConfigured, isDbPrimary, dbClient, dbEnsure, upsertUser } from '../lib/store.js';
import { isSupabaseConfigured } from '../lib/store.js';
import { gotrueAdminSetPassword, gotrueAdminSignup, gotrueDeleteUser, gotrueLogin, gotrueLogout, gotrueRefresh } from '../lib/auth-supabase.js';
import { consumeWebAuthnChallenge, putWebAuthnChallenge } from '../lib/realtime-store.js';
import { randomChallenge, verifyAuthenticationResponse, verifyRegistrationResponse } from '../lib/webauthn.js';

async function issueSession(c, user, extra = {}) {
  // v181 (Supabase): the session cookie carries the GoTrue access token;
  // the refresh token travels in the body so the client can auto-renew.
  if (isSupabaseConfigured() && extra._gotrueSession) {
    const s2 = extra._gotrueSession;
    delete extra._gotrueSession;
    if (!s2 || !s2.access_token) throw new Error('goTrue session missing');
    setSessionCookie(c, s2.access_token);
    return c.json({ ...extra, user: sanitizeUser(user, true), refreshToken: s2.refresh_token || null });
  }
  const token = await signToken(user);
  setSessionCookie(c, token);
  return c.json({ ...extra, user: sanitizeUser(user, true) });
}

function webAuthnContext(c) {
  const url = new URL(c.req.url);
  return { origin: url.origin, rpId: url.hostname };
}

async function recoveryCodeHash(code) {
  const normalized = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length < 10 || normalized.length > 32) return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized)));
  return b64url(digest);
}

async function createRecoveryCodes(count = 8) {
  const codes = Array.from({ length: count }, () => {
    const raw = b64url(crypto.getRandomValues(new Uint8Array(9))).toUpperCase();
    return raw.slice(0, 6) + '-' + raw.slice(6, 12);
  });
  return { codes, hashes: await Promise.all(codes.map(recoveryCodeHash)) };
}

async function issueWebAuthnChallenge(c, user, purpose) {
  const { origin, rpId } = webAuthnContext(c);
  const id = uid('wch');
  const challenge = randomChallenge();
  await putWebAuthnChallenge({ id, userId: user.id, purpose, challenge, rpId, origin, expiresAt: Date.now() + 120000 });
  return { challengeId: id, challenge, rpId, credentialId: user.passkeyCredentialId || null, userId: user.id, timeout: 120000 };
}

// =====================================================================
// ROUTES
// =====================================================================

// ---------- Health & diag ----------
app.get('/api/health', (c) => c.json({
  ok: true, name: 'PRIV SPACA',
  persistence: primaryPersistenceName(),
  secondaryPersistence: isDbConfigured() ? 'structured-social' : null,
  runtime: 'cloudflare-workers',
  // apiVersion tracks BACKEND deploys independently of APP_VERSION/SW_VERSION.
  // Those two are the frontend cache-busting pair and bumping them forces every
  // client to reload — pointless for a change that ships no new frontend asset.
  // This field is how we confirm which worker build is actually live.
  apiVersion: 'omni-engine-v1',
  controlPlane: 'omni-engine',
  time: nowMs(), version: 'phase2-structured-json-primary',
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
  checks.config = (isDefaultJwtSecret() || isMissingFieldKey()) ? 'fail' : 'ok';
  if (checks.config === 'fail') ready = false;

  // Database: cheapest possible round trip, hard-bounded so a hung DB cannot
  // hang the probe itself — a readiness check that never answers is useless.
  if (isDbConfigured()) {
    try {
      await withTimeout(dbClient().execute('SELECT 1'), 2000, 'database check');
      checks.database = 'ok';
    } catch (_) {
      checks.database = 'fail';
      ready = false;
    }
  } else {
    checks.database = 'fail';
    ready = false;
  }

  const omni = omniSnapshot();
  checks.load = omni.load;
  checks.scheduler = omni.scheduler;
  checks.breakers = omni.circuits;

  if (!ready) console.warn(JSON.stringify({ level: 'warn', msg: 'readiness_failed', checks }));
  return c.json({ ready }, ready ? 200 : 503);
});

app.get('/api/diag', requireAdmin, async (c) => {
  const out = {
    persistence: primaryPersistenceName(),
    repoConfigured: false, gistConfigured: false,
    canRead: false, canWrite: false, userCount: 0, error: null,
    runtime: 'cloudflare-workers',
    omni: omniSnapshot(),
  };
  try {
    const db = await fetchPrimaryDatabase();
    out.canRead = true;
    out.canWrite = isDbPrimary() || !isPersist();
    out.userCount = (db.users || []).length;
    out.repoConfigured = false;
  } catch (_) { out.error = 'Persistence check failed'; }
  return c.json(out);
});

// v181 (Supabase): when email confirmation is on, signup answers 202 and the
// app record is NOT created. After the user confirms their email, the first
// successful login provisions the app record here. Credentials are already
// verified against GoTrue at this point, and the username/displayName come
// from the user metadata stored at signup time.
async function provisionAppUserFromGoTrue(gu, password, idLower) {
  const now = Date.now();
  const meta = gu && gu.user_metadata && typeof gu.user_metadata === 'object' ? gu.user_metadata : {};
  const email = String((gu && gu.email) || idLower || '').toLowerCase();
  const db = await fetchPrimaryDatabase();
  let username = String(meta.username || '').trim().toLowerCase();
  if (!username) {
    username = String(email.split('@')[0] || 'user').replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'user';
  }
  const taken = new Set((db.users || []).map(u => String(u.username || '').toLowerCase()));
  let candidate = username;
  let suffix = 2;
  while (taken.has(candidate)) candidate = username + (suffix++);
  const displayName = String(meta.displayName || '').trim() || candidate;
  const passwordHash = await hashPassword(password);
  const newUser = {
    id: String(gu.id), email, username: candidate, displayName,
    bio: '', photoUrl: '', passwordHash, pinHash: '',
    recoveryCodeHashes: [], tokenVersion: 0,
    followers: [], following: [], blocked: [], closeFriends: [], isPrivate: false,
    termsAccepted: true, termsVersion: '1.0',
    termsAcceptedAt: now, createdAt: now, verified: false,
  };
  if (isDbConfigured()) {
    try { await upsertUser(newUser); }
    catch (e) {
      if (/unique|constraint/i.test(String(e && e.message))) throw new Error('provision-collision');
      throw e;
    }
  }
  db.users.push(newUser);
  const persisted = await saveDatabaseVerified(db, d => (d.users || []).some(u => u.id === newUser.id));
  if (isPersist() && !persisted) throw new Error('provision-persist-failed');
  return newUser;
}

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
    // SECURITY: reserve the app's own identity strings + known official
    // handles so new signups cannot squat on them. Privilege is enforced only
    // by server-side ADMIN_USERS and represented by the sanitized isOwner
    // presentation claim; this list is defense-in-depth, not authorization.
    const reserved = new Set([
      'admin','administrator','priv-spaca','privspaca','support','system','moderator','staff','help','root',
      'arvind_1011','arvindjaat1011','arvindjaat','ajitjaat1011','arvindjaat1012',
    ]);
    if (reserved.has(usernameLower)) return c.json({ error: 'That username is reserved' }, 403);

    // v181 (Supabase): identity is owned by GoTrue. Create the auth user
    // first; the app record below is keyed by the GoTrue uuid.
    let gotrueSession = null;
    let gotrueUserId = null;
    if (isSupabaseConfigured()) {
      try {
        // Admin create with email_confirm:true (see gotrueAdminSignup):
        // instant, fully-confirmed identities with no confirmation-email
        // dependency and no GoTrue email-send rate limiting. The chosen
        // username/displayName ride along in user_metadata so they survive
        // even if the app record is later re-provisioned from GoTrue.
        const gs = await gotrueAdminSignup({
          email: emailLower, password,
          username, displayName: cleanDN || username,
        });
        gotrueUserId = gs.id;
        gotrueSession = await gotrueLogin({ email: emailLower, password });
      } catch (e) {
        const detail = String(e && e.message) + ' ' + JSON.stringify((e && e.raw) || {});
        if (/already|registered|exists|duplicate/i.test(detail)) {
          return c.json({ error: 'Email already registered' }, 409);
        }
        console.error('[signup] gotrue error:', detail);
        return c.json({ error: 'Signup temporarily unavailable. Please try again in a moment.' }, 503);
      }
    }

    const [passwordHash, pinHash] = await Promise.all([
      hashPassword(password),
      // The PIN uses a lower work factor on purpose — see PBKDF2_PIN_ITERATIONS.
      hashPassword(pin, { iterations: PBKDF2_PIN_ITERATIONS })
    ]);
    const recovery = await createRecoveryCodes();
    const newUser = {
      id: gotrueUserId || uid('usr'), email: emailLower, username, displayName: cleanDN,
      bio: '', photoUrl: '', passwordHash, pinHash, recoveryCodeHashes: recovery.hashes, tokenVersion: 0,
      followers: [], following: [], blocked: [], closeFriends: [], isPrivate: false,
      termsAccepted: true, termsVersion: String(termsVersion || '1.0'),
      termsAcceptedAt: nowMs(), createdAt: nowMs(), verified: false,
    };
    if (isDbConfigured()) {
      try { await upsertUser(newUser); }
      catch (e) {
        if (/unique|constraint/i.test(String(e && e.message))) return c.json({ error: 'Email or username already registered' }, 409);
        return c.json({ error: 'Storage temporarily unavailable. Please try again in a moment.' }, 503);
      }
    }
    db.users.push(newUser);
    const persisted = await saveDatabaseVerified(db, d => (d.users || []).some(u => u.id === newUser.id));
    if (isPersist() && !persisted) {
      db.users = db.users.filter(u => u.id !== newUser.id);
      if (isDbConfigured()) await dbClient().execute({ sql: 'DELETE FROM ps_users WHERE id = ?', args: [newUser.id] }).catch(() => {});
      if (gotrueUserId) await gotrueDeleteUser(gotrueUserId);
      return c.json({ error: 'Storage temporarily unavailable. Please try again in a moment.' }, 503);
    }
    const sessionExtra = { recoveryCodes: recovery.codes };
    if (gotrueSession) sessionExtra._gotrueSession = gotrueSession;
    return issueSession(c, newUser, sessionExtra);
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
    // object directly saves a store round trip on every login.
    const userCacheKey = 'user:' + idLower;
    let _gotruePreSession = null;
    let user = _loginUserCache.get(userCacheKey);
    if (user && (Date.now() - user._cachedAt) < 60_000) {
      user = user._user;  // return a clean copy
    } else {
      user = null;
      try {
        if (isDbConfigured()) {
          const tclient = dbClient();
          const r = await tclient.execute({
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
    if (!user && isSupabaseConfigured()) {
      // Confirmation-gated signup: the GoTrue user exists but the app record
      // does not yet. Verify the password with GoTrue first; only a confirmed
      // user with correct credentials can trigger provisioning.
      let preSession = null;
      try {
        preSession = await gotrueLogin({ email: idLower, password });
      } catch (_) { /* not a valid confirmed user → normal 401 below */ }
      if (preSession && preSession.user && preSession.user.id) {
        try {
          user = await provisionAppUserFromGoTrue(preSession.user, password, idLower);
          _gotruePreSession = preSession;
          } catch (_pe) {
          console.error('[login] provisioning failed:', _pe && _pe.message);
        }
      }
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
    // round and avoids a store read on the cached path. 5 min TTL
    // is short enough that password changes take effect quickly.
    // v181 (Supabase): password checking is GoTrue's job, not bcrypt's.
    // (Provisioning above may have already verified via GoTrue — reuse it.)
    let gotrueSession = _gotruePreSession || null;
    if (isSupabaseConfigured()) {
      try {
        if (!gotrueSession) gotrueSession = await gotrueLogin({ email: matchUser.email.toLowerCase(), password });
      } catch (_) {
        await recordLoginFail(user.id);
        await authFailureDelay();
        return c.json({ error: AUTH_GENERIC_ERROR }, 401);
      }
      await clearLoginFails(user.id);
    } else {
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
      // Rare distributed read-after-write window: a password/PIN reset that
      // just committed can briefly be absent from the next replica read.
      // Retrying once with a forced-fresh read costs nothing on the common
      // (correct-password) path and adds only one extra store round trip to
      // an already-failing attempt, which already pays a
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
    }
    // v154: transparent hash upgrade, now across SCHEMES as well as costs.
    // (bcrypt-only path — GoTrue manages the credential in Supabase mode)
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
          if (isDbConfigured()) {
            try { await upsertUser(u2); } catch (_) {}
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
      return c.json({ challenge: true, ...(await issueWebAuthnChallenge(c, matchUser, 'authentication')) });
    }

    // v183 (Supabase): GoTrue sessions carry no token version (p.sv), so
    // requireAuth compares 0 against the durable tokenVersion. Logout and
    // resets bump it; a fresh login must restore 0 or the just-issued
    // session is immediately rejected as "expired".
    if (isSupabaseConfigured() && Number(matchUser.tokenVersion || 0) !== 0) {
      matchUser.tokenVersion = 0;
      if (isDbConfigured()) {
        try { await upsertUser(matchUser); } catch (_) {}
      }
    }
    return issueSession(c, matchUser, gotrueSession ? { _gotrueSession: gotrueSession } : {});
  } catch (e) {
    console.error('[login] full error:', e && e.message, e && e.stack);
    // Never echo the failure detail: it has previously included SQL and
    // internal hostname strings. The interceptor logs the real cause.
    throw wrapUnexpected(e, 'Login failed. Please try again.');
  }
});

// ---------- Auth: reset by PIN ----------
app.post('/api/auth/reset-by-pin', authRateLimit, async (c) => {
  try {
    const body = await pickBody(c, ['identifier', 'pin', 'recoveryCode', 'newPassword']);
    const { identifier, pin, recoveryCode, newPassword } = body;
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || !isPin(pin) || typeof recoveryCode !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      await authFailureDelay();
      return c.json({ error: 'Invalid reset details.' }, 400);
    }
    const subjLimit = await authSubjectRateLimit(c, 'reset:' + idLower, 8);
    if (!subjLimit.allowed) {
      c.header('Retry-After', String(Math.ceil((subjLimit.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many reset attempts. Please wait and try again.' }, 429);
    }
    // Read the durable user and keep the request's base snapshot for CAS-safe persistence.
    let db = null;
    let user = null;
    try {
      if (isDbConfigured()) {
        const tclient2 = dbClient();
        const r = await tclient2.execute({
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
      db = await fetchPrimaryDatabase();
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
      await recordLoginFail(user.id);
      await authFailureDelay();
      return c.json({ error: 'Invalid reset details.' }, 401);
    }
    const submittedRecoveryHash = await recoveryCodeHash(recoveryCode);
    const recoveryHashes = Array.isArray(user.recoveryCodeHashes) ? user.recoveryCodeHashes : [];
    const recoveryIndex = recoveryHashes.indexOf(submittedRecoveryHash);
    if (recoveryIndex < 0) {
      await recordLoginFail(user.id);
      await authFailureDelay();
      return c.json({ error: 'Invalid reset details. Contact support if you do not have a recovery code.' }, 401);
    }
    if (!db) db = await fetchPrimaryDatabase();
    const durableUser = (db.users || []).find(u => u.id === user.id);
    if (!durableUser) return c.json({ error: 'Storage temporarily unavailable' }, 503);
    user = durableUser;
    const oldRecoveryHashes = [...(user.recoveryCodeHashes || [])];
    user.recoveryCodeHashes = oldRecoveryHashes.filter(hash => hash !== submittedRecoveryHash);
    const oldHash = user.passwordHash;
    const oldTokenVersion = Number(user.tokenVersion || 0);
    user.passwordHash = await hashPassword(newPassword);
    user.tokenVersion = oldTokenVersion + 1;
    user.passwordChangedAt = nowMs();
    // Invalidate session, login-user and password-verification caches before
    // persistence so no request in this isolate can reuse the old password.
    invalidateUserAuthCaches(user);
    const persisted = await saveDatabaseVerified(db, d => {
      const u2 = (d.users || []).find(u => u.id === user.id);
      return !!u2 && u2.passwordHash === user.passwordHash && Number(u2.tokenVersion || 0) === user.tokenVersion;
    });
    if (isPersist() && !persisted) {
      user.passwordHash = oldHash; user.tokenVersion = oldTokenVersion; user.recoveryCodeHashes = oldRecoveryHashes;
      return c.json({ error: 'Storage temporarily unavailable' }, 503);
    }
    // v181 (Supabase): the password is now managed by GoTrue — sync it
    // there. If this fails the new password would not work at login, so
    // roll the app record back.
    if (isSupabaseConfigured()) {
      const synced = await gotrueAdminSetPassword(user.id, newPassword);
      if (!synced) {
        user.passwordHash = oldHash; user.tokenVersion = oldTokenVersion; user.recoveryCodeHashes = oldRecoveryHashes;
        if (isDbConfigured()) await upsertUser(user).catch(() => {});
        return c.json({ error: 'Could not update the password. Please try again.' }, 503);
      }
    }
    if (isDbConfigured()) await upsertUser(user);
    await clearLoginFails(user.id);
    let resetGotrue = null;
    if (isSupabaseConfigured()) {
      try { resetGotrue = await gotrueLogin({ email: user.email.toLowerCase(), password: newPassword }); } catch (_) {}
    }
    return issueSession(c, user, resetGotrue ? { ok: true, _gotrueSession: resetGotrue } : { ok: true });
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

// ---------- Logout (server-side token revocation + cookie clear) ----------
app.post('/api/auth/logout', requireAuth, async (c) => {
  // v181 (Supabase): also revoke the GoTrue session (best-effort).
  if (isSupabaseConfigured()) {
    const _tok = tokenFromRequest(c);
    if (_tok) await gotrueLogout(_tok);
  }
  const user = c.get('authUser');
  const db = await fetchPrimaryDatabase();
  const durable = (db.users || []).find(u => u.id === user.id);
  if (durable) {
    durable.tokenVersion = Number(durable.tokenVersion || 0) + 1;
    durable.loggedOutAt = nowMs();
    await saveDatabaseVerified(db, d => Number((d.users || []).find(u => u.id === durable.id)?.tokenVersion || 0) === durable.tokenVersion);
    if (isDbConfigured()) await upsertUser(durable);
    invalidateUserAuthCaches(durable);
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ---------- Auth: refresh (Supabase mode) ----------
// The client stores the refresh token from the login/signup/reset response
// and calls this when the access-token cookie has aged out.
app.post('/api/auth/refresh', async (c) => {
  if (!isSupabaseConfigured()) return c.json({ error: 'Not available' }, 404);
  try {
    const body = await pickBody(c, ['refreshToken']);
    const rt = String(body.refreshToken || '').trim();
    if (!rt || rt.length > 512) return c.json({ error: 'Missing or invalid token' }, 401);
    const d = await gotrueRefresh(rt);
    if (!d || !d.access_token) return c.json({ error: 'Session expired. Please sign in again.' }, 401);
    setSessionCookie(c, d.access_token);
    return c.json({ ok: true, refreshToken: d.refresh_token || null });
  } catch (_) {
    return c.json({ error: 'Session expired. Please sign in again.' }, 401);
  }
});

// =====================================================================
// PASSKEY 2FA — verified WebAuthn registration and authentication
// =====================================================================

app.post('/api/auth/passkey/register/options', requireAuth, async (c) => {
  const user = c.get('authUser');
  const options = await issueWebAuthnChallenge(c, user, 'registration');
  return c.json({
    challengeId: options.challengeId,
    publicKey: {
      challenge: options.challenge,
      rp: { name: 'Priv Spaca', id: options.rpId },
      user: {
        id: b64url(new TextEncoder().encode(user.id)),
        name: user.username,
        displayName: user.displayName || user.username,
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: options.timeout,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      attestation: 'none',
    },
  });
});

app.post('/api/auth/passkey/register', requireAuth, async (c) => {
  try {
    const user = c.get('authUser');
    const body = await pickBody(c, ['challengeId', 'credential']);
    if (!body.challengeId || !body.credential) return c.json({ error: 'Missing credential data' }, 400);
    const stored = await consumeWebAuthnChallenge({ id: body.challengeId, userId: user.id, purpose: 'registration' });
    if (!stored) return c.json({ error: 'Challenge expired or invalid' }, 401);
    const submitted = body.credential;
    const result = await verifyRegistrationResponse({
      type: submitted.type,
      id: submitted.id,
      rawId: submitted.rawId,
      clientDataJSON: submitted.response?.clientDataJSON,
      attestationObject: submitted.response?.attestationObject,
      transports: submitted.response?.transports,
    }, { challenge: stored.challenge, origin: stored.origin, rpId: stored.rpId });
    const db = await fetchPrimaryDatabase();
    const durable = (db.users || []).find(u => u.id === user.id);
    if (!durable) return c.json({ error: 'Account not found' }, 404);
    durable.passkeyCredentialId = result.credentialId;
    durable.passkeyPublicKeyJwk = result.publicKeyJwk;
    durable.passkeyPublicKey = null;
    durable.passkeyAlgorithm = -7;
    durable.passkeySignCount = result.counter;
    durable.passkeyTransports = result.transports;
    durable.passkeyRpId = stored.rpId;
    durable.passkeyEnabled = true;
    durable.passkeyEnabledAt = nowMs();
    const persisted = await saveDatabaseVerified(db, d => (d.users || []).find(u => u.id === durable.id)?.passkeyCredentialId === result.credentialId);
    if (!persisted) return c.json({ error: 'Storage temporarily unavailable' }, 503);
    if (isDbConfigured()) await upsertUser(durable);
    invalidateUserAuthCaches(durable);
    return c.json({ ok: true, message: 'Passkey enabled' });
  } catch (e) {
    console.warn('[passkey/register] rejected:', e && e.message);
    return c.json({ error: 'Passkey registration failed' }, 400);
  }
});

app.post('/api/auth/passkey/disable', requireAuth, async (c) => {
  const user = c.get('authUser');
  const db = await fetchPrimaryDatabase();
  const durable = (db.users || []).find(u => u.id === user.id);
  if (!durable) return c.json({ error: 'Account not found' }, 404);
  durable.passkeyEnabled = false;
  durable.passkeyCredentialId = null;
  durable.passkeyPublicKey = null;
  durable.passkeyPublicKeyJwk = null;
  durable.passkeyTransports = [];
  durable.passkeyAlgorithm = null;
  durable.passkeySignCount = 0;
  durable.passkeyRpId = null;
  await saveDatabase(db, false);
  if (isDbConfigured()) await upsertUser(durable);
  invalidateUserAuthCaches(durable);
  return c.json({ ok: true, message: 'Passkey disabled' });
});

// Compatibility endpoint for clients that explicitly request the challenge
// after validating a password instead of consuming /api/auth/login's response.
app.post('/api/auth/passkey/challenge', authRateLimit, async (c) => {
  const body = await pickBody(c, ['identifier', 'password']);
  const idLower = normalizeAuthIdentifier(body.identifier);
  if (!idLower || typeof body.password !== 'string' || body.password.length > 128) {
    await authFailureDelay();
    return c.json({ error: AUTH_GENERIC_ERROR }, 401);
  }
  const subject = await authSubjectRateLimit(c, 'passkey:' + idLower, 12);
  if (!subject.allowed) return c.json({ error: 'Too many attempts. Please wait and try again.' }, 429);
  let user = null;
  if (isDbConfigured()) {
    const rs = await dbClient().execute({
      sql: 'SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1',
      args: [idLower, await emailIndex(idLower)],
    });
    if (rs.rows?.[0]) user = await decryptUserPII(safeJson(String(rs.rows[0].data_json || ''), null));
  }
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    if (user) await recordLoginFail(user.id);
    await authFailureDelay();
    return c.json({ error: AUTH_GENERIC_ERROR }, 401);
  }
  const lock = await checkAccountLock(user.id);
  if (lock.locked) return c.json({ error: 'Too many attempts. Please wait and try again.' }, 429);
  if (!user.passkeyEnabled || !user.passkeyCredentialId) {
    await clearLoginFails(user.id);
    return issueSession(c, user);
  }
  return c.json({ challenge: true, ...(await issueWebAuthnChallenge(c, user, 'authentication')) });
});

app.post('/api/auth/passkey/verify', authRateLimit, async (c) => {
  try {
    const body = await pickBody(c, ['userId', 'challengeId', 'credential']);
    if (!body.userId || !body.challengeId || !body.credential) return c.json({ error: 'Missing verification data' }, 400);
    // Consume first: malformed assertions and failed signatures cannot replay.
    const stored = await consumeWebAuthnChallenge({ id: body.challengeId, userId: body.userId, purpose: 'authentication' });
    if (!stored) return c.json({ error: 'Challenge expired or invalid' }, 401);
    let user = null;
    if (isDbConfigured()) {
      const rs = await dbClient().execute({ sql: 'SELECT data_json FROM ps_users WHERE id = ? LIMIT 1', args: [body.userId] });
      if (rs.rows?.[0]) user = await decryptUserPII(safeJson(String(rs.rows[0].data_json || ''), null));
    }
    if (!user || !user.passkeyEnabled || !user.passkeyCredentialId || user.passkeyRpId !== stored.rpId) {
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    const submitted = body.credential;
    const result = await verifyAuthenticationResponse({
      type: submitted.type,
      id: submitted.id,
      rawId: submitted.rawId,
      clientDataJSON: submitted.response?.clientDataJSON,
      authenticatorData: submitted.response?.authenticatorData,
      signature: submitted.response?.signature,
      userHandle: submitted.response?.userHandle,
    }, { challenge: stored.challenge, origin: stored.origin, rpId: stored.rpId }, {
      credentialId: user.passkeyCredentialId,
      publicKeyJwk: user.passkeyPublicKeyJwk,
      counter: Number(user.passkeySignCount || 0),
    });
    const db = await fetchPrimaryDatabase();
    const durable = (db.users || []).find(u => u.id === user.id);
    if (!durable) return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    durable.passkeySignCount = result.counter;
    durable.passkeyLastUsedAt = nowMs();
    const persisted = await saveDatabaseVerified(db, d => Number((d.users || []).find(u => u.id === durable.id)?.passkeySignCount || 0) === result.counter);
    if (!persisted) return c.json({ error: 'Storage temporarily unavailable' }, 503);
    if (isDbConfigured()) await upsertUser(durable);
    await clearLoginFails(durable.id);
    return issueSession(c, durable);
  } catch (e) {
    console.warn('[passkey/verify] rejected:', e && e.message);
    return c.json({ error: 'Passkey verification failed' }, 401);
  }
});
