/**
 * PRIV SPACA — Library — auth-supabase
 *
 * v182 — GoTrue bridge. All auth calls go to the project's managed GoTrue
 * ({SUPABASE_URL}/auth/v1) using the SERVICE ROLE key injected by the
 * runtime. The app's session cookie carries the GoTrue ACCESS token; the
 * refresh token travels in the response body and is renewed via
 * POST /api/auth/refresh.
 *
 * Returns the RAW GoTrue JSON shapes ({ access_token, refresh_token,
 * expires_in, user, ... }) so call sites can use them as-is.
 */

import { cfg } from './config.js';

function base() {
  return String(cfg.SUPABASE_URL || '').replace(/\/+$/, '');
}

function svc() {
  return {
    apikey: cfg.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + cfg.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  };
}

/** Sign up. Returns the GoTrue body: { id, session | null, user, ... }.
 * With email confirmation ON there is NO session in the body. */
export async function gotrueSignup({ email, password }) {
  const r = await fetch(base() + '/auth/v1/signup', {
    method: 'POST',
    headers: svc(),
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error_description || d.msg || d.error || 'signup failed');
    e.status = r.status;
    e.raw = d;
    throw e;
  }
  return d;
}

/**
 * Sign up via the ADMIN API with the account pre-confirmed. Returns the
 * created GoTrue user ({ id, email, user_metadata, ... }).
 *
 * Why admin and not the public /signup endpoint: this app owns account
 * security (PBKDF2 hashes, PIN + offline recovery codes — no email flows),
 * so an email-verification round-trip is pure friction. The public endpoint
 * is also unusable on projects with email confirmations enabled when no
 * SMTP sender is configured — GoTrue rate-limits the confirmation sends
 * (over_email_send_rate_limit) and signups 429/503. Admin create with
 * email_confirm:true mints a fully confirmed identity with no email send
 * and no confirmation rate limit. Callers then trade the password for a
 * real session via gotrueLogin(). A duplicate email surfaces as a 4xx with
 * 'already registered' in the body.
 */
export async function gotrueAdminSignup({ email, password, username, displayName }) {
  const r = await fetch(base() + '/auth/v1/admin/users', {
    method: 'POST',
    headers: svc(),
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { username: username || null, displayName: displayName || username || null },
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.msg || d.error_description || d.error || 'signup failed');
    e.status = r.status;
    e.raw = d;
    throw e;
  }
  return d; // { id, email, user_metadata, ... } (no session — call gotrueLogin)
}

export async function gotrueLogin({ email, password }) {
  const r = await fetch(base() + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: svc(),
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error_description || d.error || 'invalid credentials');
    e.status = r.status;
    e.code = d.error_code || (r.status === 400 ? 'invalid_credentials' : 'unknown');
    e.raw = d;
    throw e;
  }
  return d; // { access_token, refresh_token, expires_in, user }
}

/** Refresh a session (rotates the refresh token). */
export async function gotrueRefresh(refreshToken) {
  const r = await fetch(base() + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: svc(),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error_description || 'refresh failed');
  return d;
}

/** Verify an access token → the GoTrue user object (throws on invalid). */
export async function gotrueVerify(token) {
  const r = await fetch(base() + '/auth/v1/user', {
    method: 'GET',
    headers: { apikey: cfg.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + token },
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error_description || 'invalid token');
    e.status = r.status;
    throw e;
  }
  return d;
}

/** Cached verify (60s) — used by requireAuth on every API call. */
const _verifyCache = new Map();
export async function gotrueVerifyCached(token) {
  if (!token) throw new Error('no token');
  const hit = _verifyCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;
  const user = await gotrueVerify(token);
  _verifyCache.set(token, { user, exp: Date.now() + 60_000 });
  if (_verifyCache.size > 200) {
    const oldest = _verifyCache.keys().next().value;
    _verifyCache.delete(oldest);
  }
  return user;
}

/** Update the user's password (admin). Best-effort. */
export async function gotrueAdminSetPassword(gotrueUserId, password) {
  try {
    const r = await fetch(base() + '/auth/v1/admin/users/' + encodeURIComponent(gotrueUserId), {
      method: 'PUT',
      headers: svc(),
      body: JSON.stringify({ password }),
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

/** Update the user's metadata (stores username/displayName so a
 * confirmation-gated signup can be completed at first login). */
export async function gotrueSetUserMetadata(gotrueUserId, metadata) {
  const r = await fetch(base() + '/auth/v1/admin/users/' + encodeURIComponent(gotrueUserId), {
    method: 'PUT',
    headers: svc(),
    body: JSON.stringify({ data: metadata }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(d.error_description || d.msg || 'set user metadata failed');
    e.status = r.status;
    throw e;
  }
  return d;
}

/** Revoke the refresh token (logout). Best-effort. */
export async function gotrueLogout(accessToken) {
  try {
    // scope=global revokes EVERY session of this user in GoTrue (verified
    // against the live project: other sessions' tokens 403 immediately after
    // this call). The app's logout semantics revoke all sessions, matching
    // its tokenVersion-based logout for app-issued tokens.
    const r = await fetch(base() + '/auth/v1/logout?scope=global', {
      method: 'POST',
      headers: {
        apikey: cfg.SUPABASE_SERVICE_KEY,
        Authorization: 'Bearer ' + (accessToken || cfg.SUPABASE_SERVICE_KEY),
        'Content-Type': 'application/json',
      },
    });
    // invalidate cached verifies — scope=global just revoked EVERY session of
    // this user, so the per-token cache (60s TTL) must not resurrect any of
    // them on the next request.
    _verifyCache.clear();
    return r.ok || r.status === 204;
  } catch (_) {
    return false;
  }
}

/** Delete the auth user (admin). Best-effort. */
export async function gotrueDeleteUser(gotrueUserId) {
  try {
    const r = await fetch(base() + '/auth/v1/admin/users/' + encodeURIComponent(gotrueUserId), {
      method: 'DELETE',
      headers: svc(),
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}
