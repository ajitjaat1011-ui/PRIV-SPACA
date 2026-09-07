/**
 * PRIV SPACA — Routes — admin media migration (one-shot, v175)
 *
 * Moves legacy media files from the GitHub data branch into Turso
 * (ps_media_files) and rewrites stored URLs (raw.githubusercontent.com and
 * /api/media/...) to same-origin /media/... paths. Gated by a one-time
 * key; remove this module once the migration is complete.
 */
import { app } from '../lib/app.js';
import { cfg } from '../lib/config.js';
import { state } from '../lib/state.js';
import { fetchDatabase, saveDatabaseVerified } from '../lib/db.js';
import { isTursoConfigured, tursoEnsure, tursoPutMedia, tursoGetMedia } from '../lib/store-turso.js';
import { wrapUnexpected } from '../lib/errors.js';

const MIGRATION_KEY = 'ps-mig-a4f768939666df2247eabdab';
const FOLDERS = ['posts', 'media', 'avatars'];
const GH_BASE = 'https://api.github.com';

async function gh(path) {
  const r = await fetch(GH_BASE + path, {
    headers: { Authorization: 'Bearer ' + cfg.GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error('github ' + r.status + ' on ' + path.split('?')[0]);
  return r.json();
}

function contentMime(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.webm')) return 'video/webm';
  if (n.endsWith('.mp4')) return 'video/mp4';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

app.post('/api/admin/migrate-media', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    if (!body || body.key !== MIGRATION_KEY) return c.json({ error: 'bad key' }, 401);
    if (!isTursoConfigured()) return c.json({ error: 'turso not configured' }, 503);
    if (!cfg.GITHUB_PAT) return c.json({ error: 'github pat not configured' }, 503);
    await tursoEnsure(); // ps_media_files must exist before any media SQL (cold isolates)
    const action = String(body.action || 'list');

    // Report legacy media size on GitHub (planning).
    if (action === 'list') {
      const out = { folders: {} };
      for (const f of FOLDERS) {
        const items = (await gh(`/repos/${cfg.GH_REPO}/contents/media/${f}?ref=${cfg.GH_BRANCH}&per_page=100`)).filter(x => x.type === 'file');
        out.folders[f] = { files: items.length, bytes: items.reduce((a, x) => a + (x.size || 0), 0) };
      }
      return c.json(out);
    }

    // Migrate one chunk of files from a folder.
    if (action === 'files') {
      const folder = FOLDERS.includes(body.folder) ? body.folder : null;
      if (!folder) return c.json({ error: 'folder must be posts|media|avatars' }, 400);
      const start = Math.max(0, Number(body.start) || 0);
      const limit = Math.max(1, Math.min(10, Number(body.limit) || 8));
      const items = (await gh(`/repos/${cfg.GH_REPO}/contents/media/${folder}?ref=${cfg.GH_BRANCH}&per_page=100`)).filter(x => x.type === 'file');
      const slice = items.slice(start, start + limit);
      let migrated = 0, skipped = 0, bytes = 0;
      const failed = [];
      for (const it of slice) {
        const key = `media/${folder}/${it.name}`;
        try {
          if (await tursoGetMedia(key)) { skipped++; continue; }
          const cj = await gh(`/repos/${cfg.GH_REPO}/contents/${key}?ref=${cfg.GH_BRANCH}`);
          const bin = Uint8Array.from(atob(String(cj.content || '')), ch => ch.charCodeAt(0));
          if (!bin.length) throw new Error('empty content');
          await tursoPutMedia(key, bin, contentMime(it.name));
          migrated++; bytes += bin.length;
        } catch (e) { failed.push(it.name + ': ' + ((e && e.message) || e)); }
      }
      return c.json({ folder, start, processed: slice.length, migrated, skipped, bytes, failed, done: start + slice.length >= items.length });
    }

    // Fetch a single file over raw.githubusercontent (no 1MB contents-API limit).
    if (action === 'raw') {
      const key = String(body.file || '');
      if (!/^media\/(posts|media|avatars)\/[A-Za-z0-9_.-]+$/.test(key)) return c.json({ error: 'bad file' }, 400);
      if (await tursoGetMedia(key)) return c.json({ migrated: 0, skipped: 1, bytes: 0 });
      const r = await fetch(`https://raw.githubusercontent.com/${cfg.GH_REPO}/${cfg.GH_BRANCH}/${key}`, { headers: { 'User-Agent': 'PRIV-SPACA' } });
      if (!r.ok) return c.json({ error: 'raw fetch ' + r.status }, 502);
      const bin = new Uint8Array(await r.arrayBuffer());
      if (!bin.length) return c.json({ error: 'empty' }, 502);
      if (bin.length > 64 * 1024 * 1024) return c.json({ error: 'too large' }, 413);
      await tursoPutMedia(key, bin, contentMime(key.split('/').pop()));
      return c.json({ migrated: 1, skipped: 0, bytes: bin.length });
    }

    // Rewrite legacy media URLs in posts + users to /media/... paths.
    if (action === 'rewrite') {
      state.cacheTimestamp = 0;
      const db = await fetchDatabase({ fresh: true });
      const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rawRe = new RegExp(`https://raw\\.githubusercontent\\.com/${esc(cfg.GH_REPO)}/${esc(cfg.GH_BRANCH)}/(media/[^"?#\\s]+)`, 'g');
      const apiRe = /\/api\/media\/(media\/[^"?#\\s]+)/g;
      const rw = (u) => (typeof u === 'string' && u ? u.replace(rawRe, '/media/$1').replace(apiRe, '/media/$1') : u);
      let postsChanged = 0, usersChanged = 0;
      for (const p of db.posts || []) {
        const before = JSON.stringify(p);
        if (typeof p.imageUrl === 'string') p.imageUrl = rw(p.imageUrl);
        if (Array.isArray(p.images)) p.images = p.images.map(rw);
        if (typeof p.videoUrl === 'string') p.videoUrl = rw(p.videoUrl);
        if (p.music && typeof p.music.art === 'string') p.music.art = rw(p.music.art);
        if (JSON.stringify(p) !== before) postsChanged++;
      }
      for (const u of db.users || []) {
        if (typeof u.photoUrl === 'string') {
          const after = rw(u.photoUrl);
          if (after !== u.photoUrl) { u.photoUrl = after; usersChanged++; }
        }
      }
      if (postsChanged || usersChanged) {
        const persisted = await saveDatabaseVerified(db, () => true, 4, { skipSecondarySync: true });
        return c.json({ postsChanged, usersChanged, persisted: !!persisted });
      }
      return c.json({ postsChanged: 0, usersChanged: 0, persisted: null });
    }

    return c.json({ error: 'unknown action' }, 400);
  } catch (e) { throw wrapUnexpected(e, 'Migration step failed'); }
});
