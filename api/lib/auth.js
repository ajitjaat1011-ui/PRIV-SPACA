/**
 * PRIV SPACA — Library — auth
 *
 * JWT signing/verification, HMAC + base64url primitives, auth caches.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { cfg } from './config.js';
import { JWT_EXPIRES_DAYS } from './config.js';

// Manual JWT (HS256) — avoids jsonwebtoken which uses Node-specific bits
export async function hmacSha256(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export function b64url(buf) {
  let s = '';
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

export function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function signToken(user) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + JWT_EXPIRES_DAYS * 24 * 3600;
  const payload = { uid: user.id, username: user.username, sv: Number(user.tokenVersion || 0), iat, exp };
  const head = b64urlJson(header);
  const body = b64urlJson(payload);
  const sig = b64url(await hmacSha256(cfg.JWT_SECRET, head + '.' + body));
  return head + '.' + body + '.' + sig;
}

export async function verifyToken(token) {
  if (!token || typeof token !== 'string') throw new Error('No token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Bad token');
  const [head, body, sig] = parts;
  const expected = b64url(await hmacSha256(cfg.JWT_SECRET, head + '.' + body));
  if (expected !== sig) throw new Error('Bad signature');
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch (_) { throw new Error('Bad payload'); }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) throw new Error('Expired');
  return payload;
}

export async function authFromRequest(c) {
  const auth = c.req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try { return await verifyToken(token); } catch (_) { return null; }
}

// v66: in-memory auth-user cache. Avoids hitting Turso on every
// authenticated request (which is most of the API). Cloudflare Workers
// can have multiple isolates per region, so this cache is per-isolate
// (each isolate's cache is independent). That's fine: the worst case
// after a deploy is one extra Turso round-trip per isolate, then the
// cache warms up.
export const _authUserCache = new Map();

          // uid -> { user, fetchedAt }
export const _loginUserCache = new Map();

          // idLower -> { _user, _cachedAt }
export const _bcryptVerifyCache = new Map();

       // bcryptCacheKey -> { ok, ts }
export const _AUTH_CACHE_TTL_MS = 30000;
