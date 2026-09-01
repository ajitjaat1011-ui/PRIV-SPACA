/**
 * PRIV SPACA — Library — db
 *
 * Persistence facade: read/write the database through the active store.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { state } from './state.js';
import { CACHE_TTL_MS, EPHEMERAL_WRITE_INTERVAL_MS } from './config.js';
import { isRepo, nowMs, safeJson, sleepMs } from './helpers.js';
import { mergeDatabase, normalizeDb, runScheduler } from './schema.js';
import { repoRead, repoWrite } from './store-github.js';
import { isTursoConfigured, isTursoPrimary, tursoClient, tursoReadDbVersioned, tursoWriteDbCAS } from './store-turso.js';

export const isPersist = () => isTursoPrimary() || isRepo();

export function primaryPersistenceName() {
  if (isTursoPrimary()) return 'turso-libsql-primary';
  if (isRepo()) return 'github-repo';
  return 'in-memory';
}

export async function ensureOwnerAccount(db) { return false; }

export async function fetchPrimaryDatabase() {
  // v65: when Turso is the primary persistence layer, the structured
  // ps_users/ps_posts tables are the actual source of truth (ps_kv is a
  // snapshot/mirror). Read both and let structured take precedence so
  // that direct ps_users writes (e.g. password resets) are reflected
  // immediately without waiting for the mirror to be rewritten.
  if (isTursoConfigured() && isTursoPrimary()) {
    try {
      const tu = tursoClient();
      const batchRs = await tu.batch([
        { sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] },
        { sql: 'SELECT data_json FROM ps_users' },
        { sql: 'SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300' },
      ], 'read');
      const kvRow = (batchRs[0] && batchRs[0].rows && batchRs[0].rows[0]) ? batchRs[0].rows[0].value : '{}';
      const baseDb = safeJson(String(kvRow || '{}'), normalizeDb(state.localCache || {}));
      const uRows = (batchRs[1] && batchRs[1].rows) || [];
      const pRows = (batchRs[2] && batchRs[2].rows) || [];
      const users = uRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
      const posts = pRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
      if (users.length > 0) baseDb.users = users;
      if (posts.length > 0) baseDb.posts = posts;
      state.localCache = normalizeDb(baseDb);
      // perf: this function just did a genuinely fresh 3-statement Turso
      // batch read of ps_kv + ps_users + ps_posts. Previously it left
      // cacheTimestamp untouched, so the very next fetchDatabase() call in
      // the same request (e.g. requireAuth() runs fetchPrimaryDatabase() on
      // every auth-cache-miss, then the route handler calls fetchDatabase())
      // would see a stale cacheTimestamp, decide its cache was expired, and
      // perform a SECOND, fully redundant Turso batch read of the exact
      // same three tables — silently doubling the DB round trips (and
      // therefore latency) on a large fraction of real requests. Stamping
      // cacheTimestamp here lets fetchDatabase() correctly recognize this
      // data as fresh and reuse it instead of re-fetching.
      state.cacheTimestamp = nowMs();
      return state.localCache;
    } catch (e) {
      console.warn('[fetchPrimary] structured read failed, falling back:', e && e.message);
    }
  }
  const remote = await repoRead();
  if (remote && typeof remote === 'object' && !remote._httpError && !remote._err) {
    return normalizeDb(remote);
  }
  return normalizeDb(state.localCache);
}

export async function fetchDatabase({ fresh = false, includeTurso = true } = {}) {
  if (!includeTurso) fresh = true;
  const now = nowMs();
  if (!fresh && now - state.cacheTimestamp < CACHE_TTL_MS && state.cacheTimestamp !== 0) {
    runScheduler(state.localCache);
    return state.localCache;
  }
  if (isTursoConfigured() && isTursoPrimary()) {
    try {
      const tu = tursoClient();
      if (includeTurso) {
        const batchRs = await tu.batch([
          { sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] },
          { sql: 'SELECT data_json FROM ps_users' },
          { sql: 'SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300' },
        ], 'read');
        const kvRow = (batchRs[0] && batchRs[0].rows && batchRs[0].rows[0]) ? batchRs[0].rows[0].value : '{}';
        state.localCache = normalizeDb(safeJson(String(kvRow || '{}'), normalizeDb(state.localCache || {})));
        const uRows = (batchRs[1] && batchRs[1].rows) || [];
        const pRows = (batchRs[2] && batchRs[2].rows) || [];
        const users = uRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
        const posts = pRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
        if (users.length > 0) state.localCache.users = users;
        if (posts.length > 0) state.localCache.posts = posts;
        state.localCache.meta = { ...(state.localCache.meta || {}), secondaryPersistence: 'turso-structured' };
      } else {
        const rs = await tu.execute({ sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
        const kvRow = (rs.rows && rs.rows[0]) ? rs.rows[0].value : '{}';
        state.localCache = normalizeDb(safeJson(String(kvRow || '{}'), normalizeDb(state.localCache || {})));
      }
      const ownerSeeded = await ensureOwnerAccount(state.localCache);
      state.cacheTimestamp = nowMs();
      const changed = runScheduler(state.localCache) || ownerSeeded;
      if (changed) await saveDatabase(state.localCache, false);
      return state.localCache;
    } catch (e) {
      console.warn('[fetchDatabase] Turso batch read failed, falling back:', e && e.message);
    }
  }
  const remote = await repoRead();
  if (remote && typeof remote === 'object' && !remote._httpError && !remote._err) {
    state.localCache = normalizeDb(remote);
  }
  const ownerSeeded = await ensureOwnerAccount(state.localCache);
  state.cacheTimestamp = now;
  const changed = runScheduler(state.localCache) || ownerSeeded;
  if (changed) await saveDatabase(state.localCache, false);
  return state.localCache;
}

export async function saveDatabase(data, isEphemeral = false, opts = {}) {
  state.localCache = data;
  state.cacheTimestamp = nowMs();
  if (!isPersist()) return true;
  // The 30s ephemeral-write throttle exists to protect GitHub API rate limits.
  // It is skipped when Turso is the active backend — otherwise heartbeat/typing
  // indicators are silently dropped almost all the time.
  if (isEphemeral && !isTursoPrimary()) {
    const now = nowMs();
    if (now - state.lastEphemeralWrite < EPHEMERAL_WRITE_INTERVAL_MS) return true;
    state.lastEphemeralWrite = now;
    repoWrite(data).catch(() => {});
    return true;
  }
  if (isEphemeral && isTursoPrimary()) {
    const now = nowMs();
    if (now - state.lastEphemeralWrite < 10000) return true;
    state.lastEphemeralWrite = now;
    // Throttled CAS strategy for ephemeral data: avoids ps_kv lock contention under 100 concurrent users
    try {
      const versioned = await tursoReadDbVersioned();
      const merged = mergeDatabase(versioned.db, data);
      await tursoWriteDbCAS(merged, versioned.version);
    } catch (_) { /* best-effort; ephemeral data, ok to lose occasionally */ }
    return true;
  }
// ---- Neon fast path: optimistic concurrency control (compare-and-swap) ----
  // The whole app's Neon storage is one JSON blob per row, so any two
  // concurrent mutating requests (e.g. two users signing up at the same
  // moment) can both read the same starting state, each add their own
  // change locally, and — without CAS — whichever one writes last would
  // silently overwrite the other's change. That is a real, reproducible
  // data-loss bug (confirmed live: 7 of 8 concurrent signups vanished
  // before this fix), not just a performance concern.
  //
  // Fix: read the row together with its version counter, merge the
  // caller's intended change (`data`) into that fresh copy, and write with
  // `UPDATE ... WHERE version = expected`. If another request won the race
  // and bumped the version first, the UPDATE matches zero rows (CAS
  // failure) — we then re-read the new latest state, re-merge our original
  // intended change into it, and retry. This is a handful of fast Postgres
  // round trips with no artificial sleep, so it stays fast in the common
  // (uncontended) case while remaining correct under real concurrency.
  if (isTursoPrimary()) {
    const originalData = data;
    const MAX_CAS_ATTEMPTS = 15;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      let versioned;
      try {
        versioned = await tursoReadDbVersioned();
      } catch (e) {
        console.error('[saveDatabase:turso] read failed', e && e.message);
        return false;
      }
      const merged = mergeDatabase(versioned.db, originalData);
      let ok = false;
      try {
        ok = await tursoWriteDbCAS(merged, versioned.version);
      } catch (e) {
        console.error('[saveDatabase:turso] CAS write failed', e && e.message);
        return false;
      }
      if (ok) {
        state.localCache = normalizeDb(merged);
        state.cacheTimestamp = nowMs();
        return true;
      }
      if (attempt < MAX_CAS_ATTEMPTS - 1) {
        await sleepMs(10 + Math.floor(Math.random() * (20 + attempt * 10)));
      }
    }
    console.error('[saveDatabase:turso] CAS retries exhausted for key=db');
    return false;
  }
  // ---- GitHub Contents API path (legacy / fallback persistence) ----
  // Merge with the newest remote DB before writing. This prevents a later request
  // from overwriting a user/message/post created by an earlier request.
  let toWrite = data;
  const remoteBeforeWrite = await repoRead();
  if (remoteBeforeWrite && typeof remoteBeforeWrite === 'object' && !remoteBeforeWrite._httpError && !remoteBeforeWrite._err) {
    toWrite = mergeDatabase(remoteBeforeWrite, data);
  }
  let ok = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await sleepMs(250 + attempt * 350);
      state.ghFileSha = null;
      const latest = await repoRead();
      if (latest && typeof latest === 'object' && !latest._httpError && !latest._err) {
        toWrite = mergeDatabase(latest, toWrite);
      }
    }
    ok = await repoWrite(toWrite);
    if (ok) break;
  }
  if (ok) {
    state.localCache = normalizeDb(toWrite);
    state.cacheTimestamp = nowMs();
  }
  return ok;
}

export async function saveDatabaseVerified(data, verifyFn, attempts = 4, opts = {}) {
  // ---- Neon fast path ----
  // saveDatabase() now performs its own internal compare-and-swap retry
  // loop against Neon (see above) and only returns true once the merged
  // data — which includes this call's intended change — is durably
  // committed. Re-reading afterwards to "verify" would be redundant, so we
  // just surface saveDatabase()'s result directly. verifyFn is intentionally
  // unused on this path (kept only for signature/call-site compatibility).
  if (isTursoPrimary()) {
    return await saveDatabase(data, false, opts);
  }
  // ---- GitHub Contents API path (legacy / fallback persistence) ----
  for (let i = 0; i < attempts; i++) {
    const ok = await saveDatabase(data, false, opts);
    if (ok) {
      await sleepMs(300 + i * 350);
      state.cacheTimestamp = 0;
      const fresh = await repoRead();
      if (fresh && typeof fresh === 'object' && !fresh._httpError && !fresh._err && (!verifyFn || verifyFn(normalizeDb(fresh)))) {
        state.localCache = normalizeDb(fresh);
        state.cacheTimestamp = nowMs();
        return true;
      }
      // Re-merge local data with whatever remote currently has, then try again.
      if (fresh && typeof fresh === 'object' && !fresh._httpError && !fresh._err) data = mergeDatabase(fresh, data);
    }
    await sleepMs(500 + i * 500);
  }
  return false;
}
