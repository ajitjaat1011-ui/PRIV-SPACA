/**
 * PRIV SPACA — Library — media
 *
 * Media validation, gzip and Cloudinary upload.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { cfg } from './config.js';
import { isSafeImageUrl, isSafeMediaUrl, sanitizeText } from './helpers.js';

// ---------- Cloudinary upload helper ----------
// When CLOUDINARY_* env vars are set, uploads go to Cloudinary (faster, has
// its own CDN, and avoids burning our GitHub Contents API quota). When not
// set, we fall back to the GitHub raw-content path that has shipped since
// day 1. The response shape is identical: { url, persisted }.

/**
 * v67: gzip-compress JSON responses when the client supports it AND the
 * payload is large enough to be worth the CPU. Saves 60-80% bandwidth on
 * big /feed /posts responses. Uses the CompressionStream Web API.
 */
export async function maybeGzip(c, jsonText) {
  if (!jsonText || jsonText.length < 2048) return null;
  const acceptEnc = (c.req.header('accept-encoding') || '').toLowerCase();
  if (!acceptEnc.includes('gzip')) return null;
  try {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    await writer.write(new TextEncoder().encode(jsonText));
    await writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new Uint8Array(chunks.reduce((acc, c) => acc.concat(Array.from(c)), []));
  } catch (e) {
    return null;
  }
}

export async function sha1Hex(str) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-1', enc.encode(str));
  let s = '';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}

export function isCloudinaryConfigured() {
  return !!(cfg.CLOUDINARY_CLOUD_NAME && cfg.CLOUDINARY_API_KEY && cfg.CLOUDINARY_API_SECRET);
}

export async function uploadToCloudinary(dataUrl, folder, publicId) {
  // 1) Decode data URL to a binary buffer
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  // 2) Build signed-form params. Cloudinary signature = SHA-1 of
  //    sorted-key-joined "k=v" pairs + api_secret, all as a single string.
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder,
    public_id: publicId,
    timestamp: String(timestamp),
    overwrite: 'true',
  };
  const toSign = Object.keys(params).sort()
    .map(k => k + '=' + params[k])
    .join('&') + cfg.CLOUDINARY_API_SECRET;
  const signature = await sha1Hex(toSign);
  // 3) Build multipart/form-data
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), 'upload');
  form.append('api_key', cfg.CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);
  form.append('public_id', publicId);
  form.append('overwrite', 'true');
  // 4) POST to Cloudinary upload endpoint
  const url = `https://api.cloudinary.com/v1_1/${cfg.CLOUDINARY_CLOUD_NAME}/auto/upload`;
  const r = await fetch(url, { method: 'POST', body: form });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('[cloudinary]', r.status, t.slice(0, 300));
    return null;
  }
  const j = await r.json();
  return j.secure_url || j.url || null;
}

// ---------- Upload photo (Cloudinary -> GitHub CDN -> inline fallback) ----------
export const MEDIA_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export const MEDIA_MAX_BYTES = 24 * 1024 * 1024;

export function _mediaKindFromMime(mime) {
  mime = String(mime || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return '';
}

// Normalize an optional song attached to a note (title/artist/preview/art).
export function cleanNoteMusic(m) {
  if (!m || typeof m !== 'object' || !m.title) return null;
  return {
    title: sanitizeText(m.title, 80),
    artist: sanitizeText(m.artist || '', 80),
    audio: isSafeMediaUrl(m.audio, { allowData: false }) ? String(m.audio).trim().slice(0, 1024) : '',
    art: isSafeImageUrl(m.art, { allowData: false }) ? String(m.art).trim().slice(0, 1024) : '',
  };
}
