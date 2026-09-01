/**
 * PRIV SPACA — Library — push
 *
 * Web Push (VAPID ES256 + RFC 8291 aes128gcm payload encryption).
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { cfg } from './config.js';
import { fetchDatabase, saveDatabase } from './db.js';

// ============================================================
// Web Push via VAPID — native WebCrypto implementation
// Implements:
//   - VAPID JWT (ES256) signing using the existing P-256 keys
//   - aes128gcm payload encryption per RFC 8291
//   - HTTP POST to the subscription endpoint (FCM/Mozilla/etc.)
// No npm deps; runs on Cloudflare Workers.
// ============================================================

// ---- Base64URL helpers (work on Uint8Array or string) ----
export function _b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function _b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function _concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- VAPID ES256 JWT signing using the configured P-256 private key ----
// VAPID_PRIVATE is the raw 32-byte d (base64url). Public is uncompressed 65-byte point.
export async function _importVapidKey() {
  const d = _b64urlDecode(cfg.VAPID_PRIVATE);
  const pub = _b64urlDecode(cfg.VAPID_PUBLIC); // 0x04 || X(32) || Y(32)
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('Bad VAPID public key');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: _b64urlEncode(d),
    x: _b64urlEncode(pub.slice(1, 33)),
    y: _b64urlEncode(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

export async function _signVapidJwt(audience, expSeconds) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: expSeconds, sub: cfg.VAPID_SUBJECT };
  const enc = new TextEncoder();
  const headerB64 = _b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = _b64urlEncode(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(headerB64 + '.' + payloadB64);
  const key = await _importVapidKey();
  // WebCrypto ECDSA produces raw r||s (64 bytes), which is what VAPID expects.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return headerB64 + '.' + payloadB64 + '.' + _b64urlEncode(new Uint8Array(sig));
}

// ---- aes128gcm Web Push encryption per RFC 8291 ----
export async function _hkdf(salt, ikm, info, length) {
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    length * 8
  ));
}

export async function _encryptPushPayload(subscription, payloadBytes) {
  // Receiver keys from the subscription
  const ua_public = _b64urlDecode(subscription.keys.p256dh); // 65 bytes uncompressed
  const auth_secret = _b64urlDecode(subscription.keys.auth); // 16 bytes

  // Ephemeral sender keypair (ES = sender)
  const esKeypair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const esPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', esKeypair.publicKey)); // 65 bytes

  // Import receiver public key for ECDH
  const uaPubKey = await crypto.subtle.importKey(
    'raw',
    ua_public,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPubKey },
    esKeypair.privateKey,
    256
  ));

  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || es_public, 32)
  const enc = new TextEncoder();
  const keyInfo = _concatBytes(
    enc.encode('WebPush: info\0'),
    ua_public,
    esPublicRaw
  );
  const ikm = await _hkdf(auth_secret, sharedSecret, keyInfo, 32);

  // Random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)
  const cek = await _hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  // Nonce = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)
  const nonce = await _hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Padded plaintext: payload || 0x02 (delimiter for last record) + zero pad to record size
  // (We send a single record; the 0x02 byte marks "last").
  const padded = _concatBytes(payloadBytes, new Uint8Array([0x02]));

  // AES-128-GCM encrypt
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    padded
  ));

  // Build aes128gcm content-coding header:
  //   salt(16) || rs(4 big-endian) || idlen(1) || keyid(idlen) || ciphertext
  // For Web Push, keyid = es_public_raw (65 bytes), so idlen = 65.
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  // record size as 4-byte big-endian uint32
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>>  8) & 0xff;
  header[19] = (rs       ) & 0xff;
  header[20] = 65;
  header.set(esPublicRaw, 21);

  return _concatBytes(header, ciphertext);
}

// v77-bugfix: Send web push notification with improved error handling and observability
export async function sendWebPush(db, recipientId, payload) {
  const result = { sent: 0, failed: 0, pruned: 0 };
  
  try {
    if (!cfg.VAPID_PRIVATE || !cfg.VAPID_PUBLIC) {
      console.warn('[push] VAPID keys not configured - push notifications disabled');
      return result;
    }
    
    const user = (db && db.users || []).find(u => u.id === recipientId);
    if (!user) {
      console.warn('[push] recipient not found:', recipientId);
      return result;
    }
    if (!user.pushSubs || user.pushSubs.length === 0) {
      // No subscriptions - expected, not an error
      return result;
    }

    const bodyStr = JSON.stringify(payload || {});
    const bodyBytes = new TextEncoder().encode(bodyStr);

    // Process each subscription in parallel; prune expired ones (404/410)
    const dead = [];
    await Promise.all(user.pushSubs.map(async (sub) => {
      if (!sub || !sub.endpoint) {
        console.warn('[push] invalid subscription for', user.username);
        dead.push(sub && sub.endpoint);
        result.pruned++;
        return;
      }
      
      try {
        if (!sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          console.warn('[push] subscription missing keys for', user.username);
          dead.push(sub.endpoint);
          result.pruned++;
          return;
        }
        
        const url = new URL(sub.endpoint);
        const audience = url.origin;
        const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12h
        const jwt = await _signVapidJwt(audience, exp);

        const cipher = await _encryptPushPayload(sub, bodyBytes);

        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            'TTL': '86400',
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
            'Authorization': `vapid t=${jwt}, k=${cfg.VAPID_PUBLIC}`,
            'Urgency': 'normal',
          },
          body: cipher,
        });
        
        if (res.status === 201 || res.ok) {
          result.sent++;
        } else if (res.status === 404 || res.status === 410) {
          console.log('[push] pruning expired sub for', user.username, '-', sub.endpoint.slice(0, 50));
          dead.push(sub.endpoint);
          result.pruned++;
        } else if (res.status >= 400 && res.status < 500) {
          // Client errors (except 404/410) - likely bad subscription
          console.warn('[push] client error', res.status, 'for', user.username, '-', sub.endpoint.slice(0, 50));
          dead.push(sub.endpoint);
          result.pruned++;
          result.failed++;
        } else {
          // Server errors (5xx) - keep subscription, might be transient
          console.warn('[push] server error', res.status, 'for', user.username, '-', sub.endpoint.slice(0, 50));
          result.failed++;
        }
      } catch (e) {
        console.error('[push] exception for', user.username, {
          message: e && e.message,
          endpoint: sub.endpoint ? sub.endpoint.slice(0, 60) : 'unknown'
        });
        result.failed++;
      }
    }));

    // Prune expired/invalid subscriptions (best-effort write; don't block)
    if (dead.length) {
      try {
        const fresh = await fetchDatabase();
        const u = fresh.users.find(x => x.id === recipientId);
        if (u && u.pushSubs) {
          const deadSet = new Set(dead.filter(Boolean));
          u.pushSubs = u.pushSubs.filter(s => s && s.endpoint && !deadSet.has(s.endpoint));
          await saveDatabase(fresh, false);
        }
      } catch (e) {
        console.warn('[push] failed to save pruned subs:', e && e.message);
      }
    }
  } catch (e) {
    console.error('[sendWebPush] outer error:', {
      message: e && e.message,
      stack: e && e.stack ? e.stack.slice(0, 200) : null,
      recipientId
    });
  }
  
  return result;
}
