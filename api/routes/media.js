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
import { isTursoConfigured, tursoPutMedia, tursoGetMedia } from '../lib/store-turso.js';
import { MEDIA_MAX_BYTES, MEDIA_MIME_EXT, _mediaKindFromMime, base64DecodedSize, decodeBase64Chunked, isCloudinaryConfigured, mediaMagicMatches, uploadToCloudinary } from '../lib/media.js';
import * as S from '../lib/schemas.js';
import { body as vbody } from '../lib/validate.js';
import { requireAuth } from '../lib/middleware.js';
import { wrapUnexpected } from '../lib/errors.js';
import { omniFetch, withFaultDomain } from '../lib/omni-engine.js';

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

    // v175: Turso first — stored in ps_media, served same-origin by the worker
    // at /media/*, so the client's network never needs to reach an external CDN.
    if (isTursoConfigured()) {
      await withFaultDomain('media.turso', async () => {
        const bin = await decodeBase64Chunked(m[2]);
        await tursoPutMedia(key, bin, mime);
      }, { idempotent: false, timeoutMs: 20_000 });
      return c.json({ url: `/media/${key}`, mediaUrl: `/media/${key}`, type: kind, mimeType: mime, bytes: decodedBytes, storage: 'turso' });
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
    // v175: Turso first — stored in ps_media, served same-origin at /media/*,
    // so the client's network never needs to reach an external CDN.
    if (isTursoConfigured()) {
      await withFaultDomain('media.turso', async () => {
        const bin = await decodeBase64Chunked(b64);
        await tursoPutMedia(`media/${folder}/${id}.${ext}`, bin, declaredMime);
      }, { idempotent: false, timeoutMs: 20_000 });
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

// ---- v175: same-origin media serving (Turso-backed) -------------------
// /media/<key>           primary path (what new uploads return)
// /api/media/<key>       legacy alias (old posts stored /api/media/... URLs)
async function _tursoMediaResponse(key) {
  if (!key || key.includes('..') || key.startsWith('/')) return new Response('Not found', { status: 404 });
  let hit = null;
  try { hit = await tursoGetMedia(key); } catch (_) { hit = null; }
  if (!hit) return new Response('Not found', { status: 404 });
  return new Response(hit.data, {
    status: 200,
    headers: {
      'Content-Type': hit.contentType || 'application/octet-stream',
      'Content-Length': String(hit.size || hit.data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
app.get('/media/*', (c) => _tursoMediaResponse(decodeURIComponent(c.req.path.slice('/media/'.length))));
app.get('/api/media/*', (c) => _tursoMediaResponse('media/' + decodeURIComponent(c.req.path.slice('/api/media/'.length))));
