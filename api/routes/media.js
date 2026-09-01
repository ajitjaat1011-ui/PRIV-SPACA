/**
 * PRIV SPACA — Routes — media
 *
 * Media and photo upload endpoints.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { cfg } from '../lib/config.js';
import { isRepo, uid } from '../lib/helpers.js';
import { MEDIA_MAX_BYTES, MEDIA_MIME_EXT, _mediaKindFromMime, isCloudinaryConfigured, uploadToCloudinary } from '../lib/media.js';
import { requireAuth } from '../lib/middleware.js';

app.post('/api/upload-media', requireAuth, async (c) => {
  try {
    const me = c.get('userId');
    const body = await c.req.json().catch(() => ({}));
    const dataUrl = body && body.dataUrl;
    if (!dataUrl || typeof dataUrl !== 'string') return c.json({ error: 'dataUrl required' }, 400);
    const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!m) return c.json({ error: 'Invalid media payload' }, 400);
    const mime = String((body && body.mimeType) || m[1] || '').toLowerCase();
    const ext = MEDIA_MIME_EXT[mime];
    const kind = _mediaKindFromMime(mime);
    if (!ext || !kind) return c.json({ error: 'Unsupported media type' }, 415);
    const bin = Uint8Array.from(atob(m[2]), ch => ch.charCodeAt(0));
    if (!bin.length) return c.json({ error: 'Empty media' }, 400);
    if (bin.length > MEDIA_MAX_BYTES) return c.json({ error: 'Media too large (24MB max)' }, 413);
    const safeName = String((body && body.name) || 'media').replace(/[^a-z0-9_.-]+/gi, '-').slice(-64) || ('media.' + ext);
    const key = `media/${Date.now()}-${uid('m')}-${safeName.replace(/\.[^.]+$/, '')}.${ext}`;

    // Preferred architectural path: Cloudflare R2. The current Pages project has
    // no binding yet, but this goes live automatically once MEDIA_BUCKET is bound
    // and MEDIA_PUBLIC_BASE_URL points at its public/custom domain.
    if (c.env && c.env.MEDIA_BUCKET && typeof c.env.MEDIA_BUCKET.put === 'function') {
      await c.env.MEDIA_BUCKET.put(key, bin, {
        httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: { uploader: String(me || ''), type: kind },
      });
      const base = String(c.env.MEDIA_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      const url = base ? `${base}/${key}` : `/media/${key}`;
      return c.json({ url, mediaUrl: url, type: kind, mimeType: mime, bytes: bin.length, storage: 'cloudflare-r2' });
    }

    if (repoStorageConfigured()) {
      const ghUrl = `https://api.github.com/repos/${cfg.GH_REPO}/contents/${key}`;
      const r = await fetch(ghUrl, {
        method: 'PUT',
        headers: { 'Authorization': `token ${cfg.GITHUB_PAT}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'PRIV-SPACA' },
        body: JSON.stringify({ message: `upload media ${key}`, content: m[2], branch: cfg.GH_BRANCH }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.error('[upload-media] GitHub write failed', r.status, txt.slice(0, 160));
        return c.json({ error: 'Media storage failed' }, 502);
      }
      const rawUrl = `https://raw.githubusercontent.com/${cfg.GH_REPO}/${cfg.GH_BRANCH}/${key}`;
      return c.json({ url: rawUrl, mediaUrl: rawUrl, type: kind, mimeType: mime, bytes: bin.length, storage: 'github-media' });
    }

    return c.json({ error: 'Media storage not configured' }, 503);
  } catch (e) {
    console.error('[upload-media]', e && e.stack || e);
    return c.json({ error: 'Upload failed' }, 500);
  }
});

app.post('/api/upload-photo', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { dataUrl, kind } = body;
    if (typeof dataUrl !== 'string' || (!dataUrl.startsWith('data:image/') && !dataUrl.startsWith('data:audio/') && !dataUrl.startsWith('data:video/'))) {
      return c.json({ error: 'Send a data URL: data:image/... , data:audio/... or data:video/...' }, 400);
    }
    const m = dataUrl.match(/^data:(image|audio|video)\/(jpeg|jpg|png|webp|gif|webm|mp3|mp4|quicktime|mov);base64,(.+)$/);
    if (!m) return c.json({ error: 'Unsupported media type' }, 400);
    const isVideo = m[1] === 'video';
    let ext = m[2] === 'jpeg' ? 'jpg' : (m[2] === 'quicktime' ? 'mov' : m[2]);
    const b64 = m[3];
    const size = Math.floor(b64.length * 3 / 4);
    // Videos get a larger cap (short story clips); images/audio stay at 5 MB.
    const maxBytes = isVideo ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (size > maxBytes) return c.json({ error: (isVideo ? 'Video too large (max 10 MB)' : 'Image too large (max 5 MB)') }, 413);
    const userId = c.get('userId');
    const safeKind = (kind === 'post' || kind === 'avatar') ? kind : 'media';
    const folder = safeKind === 'avatar' ? 'avatars' : (safeKind === 'post' ? 'posts' : 'media');
    const id = safeKind === 'avatar' ? userId : uid(isVideo ? 'vid' : 'img');
    // Cloudinary: fastest path, has its own CDN, no GitHub rate-limit cost.
    if (isCloudinaryConfigured()) {
      try {
        const cdn = await uploadToCloudinary(dataUrl, `${cfg.CLOUDINARY_FOLDER}/${folder}`, id);
        if (cdn) return c.json({ url: cdn, persisted: true });
      } catch (e) { console.warn('[upload] cloudinary failed, falling back to GitHub:', e && e.message); }
    }
    // GitHub: legacy fallback. Stable but slow + has rate limits.
    const path = `media/${folder}/${id}.${ext}`;
    if (!isRepo()) return c.json({ url: dataUrl, persisted: false });
    let priorSha = null;
    try {
      const h = await fetch(`https://api.github.com/repos/${cfg.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(cfg.GH_BRANCH)}`, {
        headers: { Authorization: 'token ' + cfg.GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json' },
      });
      if (h.ok) { const j = await h.json(); priorSha = j.sha || null; }
    } catch (_) {}
    const putBody = { message: `upload ${safeKind} ${id}`, content: b64, branch: cfg.GH_BRANCH };
    if (priorSha) putBody.sha = priorSha;
    const put = await fetch(`https://api.github.com/repos/${cfg.GH_REPO}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { Authorization: 'token ' + cfg.GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });
    if (!put.ok) {
      const t = await put.text().catch(() => '');
      console.error('[upload]', put.status, t.slice(0, 200));
      return c.json({ url: dataUrl, persisted: false, warning: 'GitHub upload failed; using inline data URL.' });
    }
    const cdn = `https://raw.githubusercontent.com/${cfg.GH_REPO}/${encodeURIComponent(cfg.GH_BRANCH)}/${path}?t=${Date.now()}`;
    return c.json({ url: cdn, persisted: true });
  } catch (e) {
    console.error('[upload]', e);
    return c.json({ error: 'Upload failed' }, 500);
  }
});
