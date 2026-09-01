/**
 * PRIV SPACA — Library — store-github
 *
 * GitHub db.json fallback store (used only when Turso is unavailable).
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { cfg } from './config.js';
import { state } from './state.js';
import { _b64decode, isRepo, safeJson } from './helpers.js';
import { isTursoPrimary, tursoReadDb, tursoWriteDb } from './store-turso.js';

// ---------- GitHub repo persistence ----------
export async function repoRead() {
  if (isTursoPrimary()) return await tursoReadDb();
  if (isNeonPrimary()) return await neonReadDb();
  if (!isRepo()) return null;
  try {
    const url = `https://api.github.com/repos/${cfg.GH_REPO}/contents/${encodeURIComponent(cfg.GH_FILE)}?ref=${encodeURIComponent(cfg.GH_BRANCH)}&_=${Date.now()}`;
    
    // Read JSON directly from GitHub Contents API. Avoid raw.githubusercontent/raw
    // responses because they can be stale and caused login to say account not found.
    const rSha = await fetch(url, {
      headers: { Authorization: 'token ' + cfg.GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!rSha.ok) return { _httpError: rSha.status, txt: await rSha.text() };
    const dSha = await rSha.json();
    if (dSha && dSha.sha) state.ghFileSha = dSha.sha;
    if (!dSha || !dSha.content) return null;
    const b64 = String(dSha.content || '').replace(/\n/g, '');
    const text = _b64decode(b64);
    return safeJson(text, { _err: 'Invalid JSON', _textPreview: text.slice(0, 100) });
  } catch (e) {
    return { _err: e.message, _stack: e.stack };
  }
}

export async function repoWrite(dbObj) {
  if (isTursoPrimary()) return await tursoWriteDb(dbObj);
  if (isNeonPrimary()) return await neonWriteDb(dbObj);
  if (!isRepo()) return false;
  try {
    if (!state.ghFileSha) await repoRead();
    const str = JSON.stringify(dbObj); const bytes = new TextEncoder().encode(str); let binStr = ''; for(let i=0; i<bytes.byteLength; i++) binStr += String.fromCharCode(bytes[i]); const content = btoa(binStr);
    const url = `https://api.github.com/repos/${cfg.GH_REPO}/contents/${encodeURIComponent(cfg.GH_FILE)}`;
    const doPut = async (sha) => {
      const body = { message: 'priv-spaca sync ' + new Date().toISOString(), content, branch: cfg.GH_BRANCH };
      if (sha) body.sha = sha;
      return fetch(url, {
        method: 'PUT',
        headers: { Authorization: 'token ' + cfg.GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    };
    let r = await doPut(state.ghFileSha);
    // Do NOT retry conflicts here with the same stale content. Return false so
    // saveDatabase() can re-read, merge, and then retry with unioned data.
    if (r.status === 409 || r.status === 422) {
      const t = await r.text().catch(() => '');
      console.warn('[repoWrite conflict]', r.status, t.slice(0, 120));
      state.ghFileSha = null;
      return false;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[repoWrite]', r.status, t.slice(0, 200));
      return false;
    }
    const j = await r.json();
    if (j && j.content && j.content.sha) state.ghFileSha = j.content.sha;
    return true;
  } catch (e) { console.error('[repoWrite]', e.message); return false; }
}
