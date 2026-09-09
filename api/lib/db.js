/** PRIV SPACA — Supabase persistence facade with three-way CAS merging. */

import { state } from './state.js';
import { CACHE_TTL_MS } from './config.js';
import { nowMs, safeJson, sleepMs } from './helpers.js';
import { decryptDatabasePII, decryptUserPII } from './crypto-fields.js';
import { DATABASE_BASE_SNAPSHOT, databaseWorkingCopy, mergeDatabaseThreeWay, normalizeDb, runScheduler } from './schema.js';
import { isDbConfigured, isDbPrimary, dbClient, readDbVersioned, writeDbCAS } from './store.js';

export const isPersist = () => isDbPrimary();

export function primaryPersistenceName() {
  return isDbPrimary() ? 'supabase-postgres-primary' : 'in-memory';
}

export async function ensureOwnerAccount() { return false; }

async function readStructuredDatabase() {
  const tu = dbClient();
  const batchRs = await tu.batch([
    { sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] },
    { sql: 'SELECT data_json FROM ps_users' },
    { sql: 'SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300' },
  ], 'read');
  const kvRow = batchRs[0]?.rows?.[0]?.value || '{}';
  const baseDb = await decryptDatabasePII(safeJson(String(kvRow || '{}'), normalizeDb(state.localCache || {})));
  const uRows = batchRs[1]?.rows || [];
  const pRows = batchRs[2]?.rows || [];
  const users = await Promise.all(
    uRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean).map(decryptUserPII)
  );
  const posts = pRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
  if (users.length > 0) baseDb.users = users;
  if (posts.length > 0) baseDb.posts = posts;
  baseDb.meta = { ...(baseDb.meta || {}), secondaryPersistence: 'structured' };
  return normalizeDb(baseDb);
}

export async function fetchPrimaryDatabase() {
  if (isDbConfigured() && isDbPrimary()) {
    try {
      state.localCache = await readStructuredDatabase();
      state.cacheTimestamp = nowMs();
      return databaseWorkingCopy(state.localCache);
    } catch (e) {
      console.warn('[fetchPrimary] store read failed:', e && e.message);
    }
  }
  return databaseWorkingCopy(state.localCache);
}

export async function fetchDatabase({ fresh = false, includeStore = true } = {}) {
  if (!includeStore) fresh = true;
  const now = nowMs();
  if (!fresh && now - state.cacheTimestamp < CACHE_TTL_MS && state.cacheTimestamp !== 0) {
    runScheduler(state.localCache);
    return databaseWorkingCopy(state.localCache);
  }
  if (isDbConfigured() && isDbPrimary()) {
    try {
      if (includeStore) {
        state.localCache = await readStructuredDatabase();
      } else {
        const rs = await dbClient().execute({ sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
        const kvRow = rs.rows?.[0]?.value || '{}';
        state.localCache = normalizeDb(await decryptDatabasePII(safeJson(String(kvRow), normalizeDb(state.localCache || {}))));
      }
      state.cacheTimestamp = nowMs();
      const scheduled = databaseWorkingCopy(state.localCache);
      const changed = runScheduler(scheduled);
      if (changed) await saveDatabase(scheduled, false);
      return databaseWorkingCopy(state.localCache);
    } catch (e) {
      console.warn('[fetchDatabase] store read failed:', e && e.message);
    }
  }
  runScheduler(state.localCache);
  return databaseWorkingCopy(state.localCache);
}

export async function saveDatabase(data, isEphemeral = false) {
  const local = normalizeDb(data);
  const base = data && data[DATABASE_BASE_SNAPSHOT] ? normalizeDb(data[DATABASE_BASE_SNAPSHOT]) : normalizeDb(state.localCache);
  if (!isPersist()) {
    state.localCache = local;
    state.cacheTimestamp = nowMs();
    return true;
  }

  // Presence/typing now use dedicated TTL tables. Remaining ephemeral mirror
  // writes are best-effort and never overwrite an unrelated concurrent field.
  const maxAttempts = isEphemeral ? 3 : 15;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let versioned;
    try {
      versioned = await readDbVersioned();
    } catch (e) {
      console.error('[saveDatabase:db] read failed', e && e.message);
      return false;
    }
    const merged = mergeDatabaseThreeWay(versioned.db, base, local);
    let ok = false;
    try {
      ok = await writeDbCAS(merged, versioned.version);
    } catch (e) {
      console.error('[saveDatabase:db] CAS write failed', e && e.message);
      return false;
    }
    if (ok) {
      state.localCache = normalizeDb(merged);
      state.cacheTimestamp = nowMs();
      return true;
    }
    if (attempt < maxAttempts - 1) await sleepMs(10 + Math.floor(Math.random() * (20 + attempt * 10)));
  }
  if (!isEphemeral) console.error('[saveDatabase:db] CAS retries exhausted for key=db');
  return false;
}

export async function saveDatabaseVerified(data, verifyFn, attempts = 4, opts = {}) {
  if (isDbPrimary()) {
    const ok = await saveDatabase(data, false, opts);
    if (!ok) return false;
    if (!verifyFn) return true;
    // The write is already CAS-protected. Verification may briefly reach a
    // replica that has not observed that committed version, so honor the
    // attempts parameter instead of turning one stale read into a false 503.
    const maxAttempts = Math.max(1, Math.min(8, Number(attempts) || 1));
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const versioned = await readDbVersioned();
        if (verifyFn(versioned.db)) return true;
      } catch (_) {
        // Retry boundedly; a persistent storage failure still returns false.
      }
      if (attempt < maxAttempts - 1) await sleepMs(15 * (attempt + 1));
    }
    return false;
  }
  const ok = await saveDatabase(data, false, opts);
  return !!(ok && (!verifyFn || verifyFn(state.localCache)));
}
