/**
 * PRIV SPACA — Routes — media
 *
 * Media and photo upload endpoints.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { cfg } from '../lib/config.js';
import { isGithubMediaConfigured, uid } from '../lib/helpers.js';
import { MEDIA_MAX_BYTES, MEDIA_MIME_EXT, _mediaKindFromMime, base64DecodedSize, decodeBase64Chunked, isCloudinaryConfigured, mediaMagicMatches, uploadToCloudinary } from '../lib/media.js';
import * as S from '../lib/schemas.js';
import { body as vbody } from '../lib/validate.js';
import { requireAuth } from '../lib/middleware.js';
import { wrapUnexpected } from '../lib/errors.js';
import { omniFetch, withFaultDomain } from '../lib/omni-engine.js';
import { isSupabaseConfigured, dbClient } from '../lib/store.js';

// ---------- Supabase media (v181) ----------
// In Supabase mode, media lives in the ps_media bytea table and is served
// same-origin by GET /api/media/* below. The edge request body
// limit (~6 MB) caps uploads at 3 MB decoded (base64 overhead).
const SUPABASE_MEDIA_MAX = 3 * 1024 * 1024;

function supabaseMediaUrl(c, objectId) {
  // The public URL must be built from the known public base (PS_PUBLIC_BASE,
  // set by the function entry) — the internal request URL has the wrong
  // scheme/path on the Supabase edge.
  const origin = (String(cfg.PS_PUBLIC_BASE || '').replace(/\/+$/, '')
    || (String(cfg.SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1/app'));
  return origin + '/api/media/' + objectId;
}

async function supabaseStoreMedia(c, { objectId, userId, mime, size, b64, kind }) {
  const tclient = dbClient();
  await tclient.execute({
    sql: `INSERT INTO ps_media (object_id, user_id, mime, size, data, kind, created_at)
          VALUES (?, ?, ?, ?, decode(?, 'base64'), ?, ?)
          ON CONFLICT (object_id) DO UPDATE SET data = excluded.data, mime = excluded.mime, size = excluded.size, kind = excluded.kind`,
    args: [objectId, String(userId || ''), mime, size, b64, kind, Date.now()],
  });
  return supabaseMediaUrl(c, objectId);
}

app.post('/api/upload-media', requireAuth, async (c) => {
  try {
    const me = c.get('userId');
    const body = await vbody(c, S.UploadMediaBody);
    const dataUrl = body && body.dataUrl;
    if (!dataUrl || typeof dataUrl !== 'string') return c.json({ error: 'dataUrl required' }, 400);
    const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) return c.json({ error: 'Invalid media payload' }, 400);
    const mime = String((body && body.mimeType) || m[1] || '').toLowerCase();
    const ext = MEDIA_MIME_EXT[mime];
    const kind = _mediaKindFromMime(mime);
    if (!ext || !kind) return c.json({ error: 'Unsupported media type' }, 415);
    const decodedBytes = base64DecodedSize(m[2]);
    if (!decodedBytes) return c.json({ error: 'Empty media' }, 400);
    if (decodedBytes > MEDIA_MAX_BYTES) return c.json({ error: 'Media too large (24MB max)' }, 413);
    if (!mediaMagicMatches(m[2], mime)) return c.json({ error: 'Media content does not match its declared type' }, 415);
    const safeName = String((body && body.name) || 'media').replace(/[^a-z0-9_.-]+/gi, '-').slice(-64) || ('media.' + ext);
    const key = `media/${Date.now()}-${uid('m')}-${safeName.replace(/\.[^.]+$/, '')}.${ext}`;
    // v181 (Supabase): bytea table first.
    if (isSupabaseConfigured()) {
      if (decodedBytes > SUPABASE_MEDIA_MAX) return c.json({ error: 'Media too large (3 MB max here)' }, 413);
      const url = await supabaseStoreMedia(c, { objectId: key, userId: me, mime, size: decodedBytes, b64: m[2], kind });
      return c.json({ url, mediaUrl: url, type: kind, mimeType: mime, bytes: decodedBytes, storage: 'supabase-media' });
    }

    // Preferred architectural path: Cloudflare R2. The current Pages project has
    // no binding yet, but this goes live automatically once MEDIA_BUCKET is bound
    // and MEDIA_PUBLIC_BASE_URL points at its public/custom domain.
    if (c.env && c.env.MEDIA_BUCKET && typeof c.env.MEDIA_BUCKET.put === 'function') {
      await withFaultDomain('media.r2', async () => {
        const bin = await decodeBase64Chunked(m[2]);
        await c.env.MEDIA_BUCKET.put(key, bin, {
          httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
          customMetadata: { uploader: String(me || ''), type: kind },
        });
      }, { idempotent: false, timeoutMs: 10_000 });
      const base = String(c.env.MEDIA_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      const url = base ? `${base}/${key}` : `/media/${key}`;
      return c.json({ url, mediaUrl: url, type: kind, mimeType: mime, bytes: decodedBytes, storage: 'cloudflare-r2' });
    }

    if (isGithubMediaConfigured()) {
      const ghUrl = `https://api.github.com/repos/${cfg.GH_REPO}/contents/${key}`;
      const r = await omniFetch('media.github', ghUrl, {
        method: 'PUT',
        headers: { 'Authorization': `token ${cfg.GITHUB_PAT}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'PRIV-SPACA' },
        body: JSON.stringify({ message: `upload media ${key}`, content: m[2], branch: cfg.GH_BRANCH }),
      }, { idempotent: false, timeoutMs: 12_000 });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.error('[upload-media] GitHub write failed', r.status, txt.slice(0, 160));
        return c.json({ error: 'Media storage failed' }, 502);
      }
      const rawUrl = `https://raw.githubusercontent.com/${cfg.GH_REPO}/${cfg.GH_BRANCH}/${key}`;
      return c.json({ url: rawUrl, mediaUrl: rawUrl, type: kind, mimeType: mime, bytes: decodedBytes, storage: 'github-media' });
    }

    return c.json({ error: 'Media storage not configured' }, 503);
  } catch (e) {
    console.error('[upload-media]', e && e.stack || e);
    throw wrapUnexpected(e, 'Upload failed. Please try again.');
  }
});

app.post('/api/upload-photo', requireAuth, async (c) => {
  try {
    const body = await vbody(c, S.UploadMediaBody);
    const { dataUrl, kind } = body;
    if (typeof dataUrl !== 'string' || (!dataUrl.startsWith('data:image/') && !dataUrl.startsWith('data:audio/') && !dataUrl.startsWith('data:video/'))) {
      return c.json({ error: 'Send a data URL: data:image/... , data:audio/... or data:video/...' }, 400);
    }
    const m = dataUrl.match(/^data:(image|audio|video)\/(jpeg|jpg|png|webp|avif|gif|webm|mp3|mp4|quicktime|mov);base64,(.+)$/);
    if (!m) return c.json({ error: 'Unsupported media type' }, 400);
    const isVideo = m[1] === 'video';
    let ext = m[2] === 'jpeg' ? 'jpg' : (m[2] === 'quicktime' ? 'mov' : m[2]);
    const b64 = m[3];
    const declaredMime = m[1] === 'audio' && m[2] === 'mp3' ? 'audio/mpeg'
      : m[1] === 'video' && ['quicktime','mov'].includes(m[2]) ? 'video/quicktime'
      : `${m[1]}/${m[2] === 'jpg' ? 'jpeg' : m[2]}`;
    const size = base64DecodedSize(b64);
    if (!size || !mediaMagicMatches(b64, declaredMime)) return c.json({ error: 'Media content does not match its declared type' }, 415);
    // Videos get a larger cap (short story clips); images/audio stay at 5 MB.
    const maxBytes = isVideo ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (size > maxBytes) return c.json({ error: (isVideo ? 'Video too large (max 10 MB)' : 'Image too large (max 5 MB)') }, 413);
    const userId = c.get('userId');
    const safeKind = (kind === 'post' || kind === 'avatar') ? kind : 'media';
    const folder = safeKind === 'avatar' ? 'avatars' : (safeKind === 'post' ? 'posts' : 'media');
    const id = safeKind === 'avatar' ? userId : uid(isVideo ? 'vid' : 'img');
    // v181 (Supabase): bytea table first.
    if (isSupabaseConfigured()) {
      const photoMax = isVideo ? SUPABASE_MEDIA_MAX : Math.min(5 * 1024 * 1024, SUPABASE_MEDIA_MAX);
      if (size > photoMax) return c.json({ error: 'Media too large (3 MB max here)' }, 413);
      const objectId = `media/${folder}/${id}.${ext}`;
      const url = await supabaseStoreMedia(c, { objectId, userId, mime: declaredMime, size, b64, kind: safeKind });
      return c.json({ url, persisted: true });
    }
    // v175: R2 first — served same-origin by the worker (/media/*), so no
    // external CDN reachability is required on the client's network.
    if (c.env && c.env.MEDIA_BUCKET && typeof c.env.MEDIA_BUCKET.put === 'function') {
      await withFaultDomain('media.r2', async () => {
        const bin = await decodeBase64Chunked(b64);
        await c.env.MEDIA_BUCKET.put(`media/${folder}/${id}.${ext}`, bin, {
          httpMetadata: { contentType: declaredMime, cacheControl: 'public, max-age=31536000, immutable' },
          customMetadata: { uploader: String(userId || ''), kind: safeKind },
        });
      }, { idempotent: false, timeoutMs: 10_000 });
      return c.json({ url: `/media/${folder}/${id}.${ext}`, persisted: true });
    }
    // Cloudinary: fastest path, has its own CDN, no GitHub rate-limit cost.
    if (isCloudinaryConfigured()) {
      try {
        const cdn = await uploadToCloudinary(dataUrl, `${cfg.CLOUDINARY_FOLDER}/${folder}`, id);
        if (cdn) return c.json({ url: cdn, persisted: true });
      } catch (e) { console.warn('[upload] cloudinary failed, falling back to GitHub:', e && e.message); }
    }
    // GitHub: legacy fallback. Stable but slow + has rate limits.
    const path = `media/${folder}/${id}.${ext}`;
    if (!isGithubMediaConfigured()) return c.json({ error: 'Media storage is temporarily unavailable' }, 503);
    let priorSha = null;
    try {
      const h = await omniFetch('media.github', `https://api.github.com/repos/${cfg.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(cfg.GH_BRANCH)}`, {
        headers: { Authorization: 'token ' + cfg.GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json' },
      }, { idempotent: true, timeoutMs: 5000 });
      if (h.ok) { const j = await h.json(); priorSha = j.sha || null; }
    } catch (_) {}
    const putBody = { message: `upload ${safeKind} ${id}`, content: b64, branch: cfg.GH_BRANCH };
    if (priorSha) putBody.sha = priorSha;
    const put = await omniFetch('media.github', `https://api.github.com/repos/${cfg.GH_REPO}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { Authorization: 'token ' + cfg.GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    }, { idempotent: false, timeoutMs: 12_000 });
    if (!put.ok) {
      const t = await put.text().catch(() => '');
      console.error('[upload]', put.status, t.slice(0, 200));
      // Never report an inline data URL as a successful upload: it is neither
      // durable nor shareable across devices and can silently disappear.
      return c.json({ error: 'Media storage failed. Please try again.' }, 502);
    }
    const cdn = `https://raw.githubusercontent.com/${cfg.GH_REPO}/${encodeURIComponent(cfg.GH_BRANCH)}/${path}?t=${Date.now()}`;
    return c.json({ url: cdn, persisted: true });
  } catch (e) {
    console.error('[upload]', e);
    throw wrapUnexpected(e, 'Upload failed. Please try again.');
  }
});

// v181 (Supabase): public media serving from ps_media. Object ids contain
// slashes (media/avatars/...), so this is a wildcard route, not :objectId.
// v185 (pages+render): /media/* alias for legacy v175-era URLs.
async function _supabaseMediaResponse(c, objectId) {
  if (!objectId || objectId.includes('..') || objectId.startsWith('/')) {
    return c.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!/^media\/[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)*\.[A-Za-z0-9]{2,5}$/.test(objectId)) {
    return c.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const rs = await dbClient().execute({ sql: 'SELECT data, mime, size FROM ps_media WHERE object_id = ? LIMIT 1', args: [objectId] });
    const row = rs.rows && rs.rows[0];
    if (!row || !row.data) return c.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const bytes = row.data;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new Response(u8, {
      status: 200,
      headers: {
        'Content-Type': String(row.mime || 'application/octet-stream'),
        'Content-Length': String(Number(row.size) || u8.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    console.error('[media:get]', e && e.message);
    return c.json({ error: 'Media temporarily unavailable' }, 503);
  }
}

app.get('/api/media/*', async (c) => {
  if (!isSupabaseConfigured()) return c.json({ error: 'Not found' }, 404);
  const p = c.req.path;
  const marker = '/api/media/';
  const idx = p.indexOf(marker);
  if (idx === -1) return c.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return _supabaseMediaResponse(c, decodeURIComponent(p.slice(idx + marker.length)));
});

app.get('/media/*', async (c) => {
  if (!isSupabaseConfigured()) return c.json({ error: 'Not found' }, 404);
  const p = c.req.path;
  const idx = p.indexOf('/media/');
  if (idx === -1) return c.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return _supabaseMediaResponse(c, decodeURIComponent(p.slice(idx + '/media/'.length)));
});
