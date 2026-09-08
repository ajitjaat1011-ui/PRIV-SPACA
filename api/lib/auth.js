/**
 * PRIV SPACA — JWT and session-cookie primitives.
 */

import { cfg, JWT_EXPIRES_DAYS } from './config.js';
import { isSupabaseConfigured } from './store-turso.js';
import { gotrueVerifyCached } from './auth-supabase.js';

const enc = new TextEncoder();
export const SESSION_COOKIE = '__Host-ps_session';
export const TOKEN_ISSUER = 'priv-spaca';
export const TOKEN_AUDIENCE = 'priv-spaca-web';

async function hmacKey(secret, usages = ['sign', 'verify']) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function hmacSha256(secret, msg) {
  const key = await hmacKey(secret, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export function b64url(buf) {
  let s = '';
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlBytes(str, max = 16 * 1024) {
  const input = String(str || '');
  if (!input || input.length > Math.ceil(max * 4 / 3) + 8 || !/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('Bad base64url');
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  if (bin.length > max) throw new Error('Decoded value too large');
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function b64urlDecode(str) {
  return new TextDecoder().decode(b64urlBytes(str));
}

export function b64urlJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}

export async function signToken(user) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + JWT_EXPIRES_DAYS * 24 * 3600;
  const payload = {
    iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE,
    uid: user.id, username: user.username, sv: Number(user.tokenVersion || 0),
    iat, nbf: iat - 5, exp,
    jti: crypto.randomUUID ? crypto.randomUUID() : b64url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const head = b64urlJson(header);
  const body = b64urlJson(payload);
  const sig = b64url(await hmacSha256(cfg.JWT_SECRET, head + '.' + body));
  return head + '.' + body + '.' + sig;
}

export async function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.length > 8192) throw new Error('No token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Bad token');
  const [head, body, sig] = parts;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlBytes(head, 2048)));
    payload = JSON.parse(new TextDecoder().decode(b64urlBytes(body, 4096)));
  } catch (_) { throw new Error('Bad token JSON'); }
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error('Bad token header');
  const key = await hmacKey(cfg.JWT_SECRET, ['verify']);
  const signature = b64urlBytes(sig, 128);
  const valid = await crypto.subtle.verify('HMAC', key, signature, enc.encode(head + '.' + body));
  if (!valid) throw new Error('Bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== TOKEN_ISSUER || payload.aud !== TOKEN_AUDIENCE) throw new Error('Bad token scope');
  if (!payload.uid || !/^[A-Za-z0-9_-]{1,128}$/.test(String(payload.uid))) throw new Error('Bad subject');
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) || payload.exp <= now || payload.iat > now + 60) throw new Error('Expired');
  if (payload.nbf && payload.nbf > now + 5) throw new Error('Not active');
  return payload;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) {}
  }
  return out;
}

export function tokenFromRequest(c) {
  const auth = c.req.header('authorization') || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return parseCookies(c.req.header('cookie') || '')[SESSION_COOKIE] || null;
}

export function hasSessionCookie(c) {
  return !!parseCookies(c.req.header('cookie') || '')[SESSION_COOKIE];
}

export function setSessionCookie(c, token) {
  const maxAge = JWT_EXPIRES_DAYS * 24 * 3600;
  c.header('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`);
}

export function clearSessionCookie(c) {
  c.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}

export async function authFromRequest(c) {
  const token = tokenFromRequest(c);
  if (!token) return null;
  if (isSupabaseConfigured()) {
    // v181 (Supabase): the session cookie carries the GoTrue access JWT
    // (verified against GoTrue, cached 60s). There is no app JWT secret.
    try {
      const gu = await gotrueVerifyCached(token);
      if (gu && gu.id) return { uid: gu.id, email: gu.email, gotrue: true };
    } catch (_) { /* invalid/expired GoTrue token */ }
    return null;
  }
  try { return await verifyToken(token); } catch (_) { return null; }
}

export const _authUserCache = new Map();
export const _loginUserCache = new Map();
export const _bcryptVerifyCache = new Map();
export const _AUTH_CACHE_TTL_MS = 30000;

/**
 * Drop every isolate-local authentication view of a user after logout,
 * password/PIN changes, passkey changes, username changes or deletion.
 * Keeping the password-verification cache after a password reset can otherwise
 * make the old password usable until its five-minute TTL expires.
 */
export function invalidateUserAuthCaches(user, ...formerIdentifiers) {
  if (!user || typeof user !== 'object') return;
  const userId = String(user.id || '');
  if (userId) {
    _authUserCache.delete(userId);
    for (const key of _bcryptVerifyCache.keys()) {
      if (String(key).startsWith(userId + '|')) _bcryptVerifyCache.delete(key);
    }
  }
  for (const identifier of [user.username, user.email, ...formerIdentifiers]) {
    const normalized = String(identifier || '').trim().toLowerCase();
    if (normalized) _loginUserCache.delete('user:' + normalized);
  }
}
