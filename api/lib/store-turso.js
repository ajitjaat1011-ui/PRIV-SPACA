/**
 * PRIV SPACA — Library — store-turso
 *
 * Turso/libSQL primary store: client scoping, schema bootstrap, KV + mirror tables.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient as createTursoClient } from '@libsql/client/http';
import { cfg } from './config.js';
import { decryptDatabasePII, decryptUserPII, emailIndex, encryptDatabasePII, encryptUserPII, isFieldEncryptionEnabled } from './crypto-fields.js';
import { state } from './state.js';
import { nowMs, safeJson } from './helpers.js';
import { normalizeDb } from './schema.js';
import { withFaultDomain } from './omni-engine.js';

function sqlText(statement) {
  if (typeof statement === 'string') return statement;
  return String(statement?.sql || '');
}

function isReadOnlyStatement(statement) {
  return /^\s*(SELECT|PRAGMA|EXPLAIN|WITH\s+[^]*?\bSELECT\b)/i.test(sqlText(statement));
}

/**
 * Wrap every libSQL network operation in the database fault domain. Correlation
 * context is retained by Omni's AsyncLocalStorage even though the libSQL SDK
 * does not expose a portable custom-header hook.
 */
function instrumentTursoClient(client) {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === '__omniInstrumented') return true;
      if (property === 'execute') {
        return (statement) => {
          const readOnly = isReadOnlyStatement(statement);
          return withFaultDomain('database.turso', () => target.execute(statement), {
            idempotent: readOnly,
            timeoutMs: readOnly ? 2500 : 7000,
          });
        };
      }
      if (property === 'batch') {
        return (statements, mode) => {
          const readOnly = Array.isArray(statements) && statements.every(isReadOnlyStatement);
          return withFaultDomain('database.turso', () => target.batch(statements, mode), {
            idempotent: readOnly,
            timeoutMs: readOnly ? 3000 : 8000,
          });
        };
      }
      if (property === 'executeMultiple') {
        return (sql) => withFaultDomain('database.turso',
          () => target.executeMultiple(sql),
          { idempotent: false, timeoutMs: 10_000 });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createInstrumentedTursoClient() {
  return instrumentTursoClient(createTursoClient({ url: cfg.TURSO_DATABASE_URL, authToken: cfg.TURSO_AUTH_TOKEN }));
}

// ---------- Persistence routing (Turso-only in production) ----------
// Production middleware fails closed if Turso or field encryption is absent.
// The in-memory cache is available only to localhost development/tests. There
// is deliberately no public-repository db.json fallback.
export function isTursoPrimary() {
  return isTursoConfigured();
}

export const _tursoAls = new AsyncLocalStorage();

export function isTursoConfigured() {
  return !!(cfg.TURSO_DATABASE_URL && cfg.TURSO_AUTH_TOKEN);
}

export function tursoClient() {
  const store = _tursoAls.getStore();
  if (store) {
    if (!store.client) store.client = createInstrumentedTursoClient();
    return store.client;
  }
  // Background work gets a fresh instrumented client; never a module-global
  // socket/client whose lifecycle outlives a Worker request.
  return createInstrumentedTursoClient();
}

// Runs `fn` inside a fresh per-request Turso-client scope. Wired into the
// global '*' middleware below so every request gets exactly one scope.
export function runWithTursoRequestScope(fn) {
  return _tursoAls.run({ client: null }, fn);
}

export async function tursoEnsure() {
  if (!isTursoConfigured()) return false;
  if (state._tursoReady) return true;
  // Mark this isolate ready before the first network await. Multiple requests
  // can enter a cold Worker concurrently; without this guard each one ran the
  // entire DDL/migration sequence and a normal page launch saturated Turso.
  // Queries may proceed concurrently because production tables already exist;
  // on a genuinely empty database they fail transiently until this initializer
  // finishes, and a failed initializer clears the flag for a later retry.
  state._tursoReady = true;
  try {
    const c = tursoClient();
    await c.executeMultiple(`
    CREATE TABLE IF NOT EXISTS ps_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ps_rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL,
      locked_until INTEGER DEFAULT 0,
      first_at INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_rate_limits_reset_at ON ps_rate_limits (reset_at);
    CREATE TABLE IF NOT EXISTS ps_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_events_user_ts ON ps_events (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ps_events_ts ON ps_events (created_at);
    CREATE TABLE IF NOT EXISTS ps_users (
      id TEXT PRIMARY KEY,
      username_lower TEXT,
      email_lower TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_users_username_lower ON ps_users (username_lower);
    CREATE INDEX IF NOT EXISTS idx_ps_users_email_lower ON ps_users (email_lower);
    CREATE TABLE IF NOT EXISTS ps_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      story INTEGER NOT NULL DEFAULT 0,
      story_expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_posts_user_id ON ps_posts (user_id);
    CREATE INDEX IF NOT EXISTS idx_ps_posts_created_at ON ps_posts (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ps_posts_story ON ps_posts (story, story_expires_at);
    CREATE TABLE IF NOT EXISTS ps_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      from_user_id TEXT,
      kind TEXT,
      post_id TEXT,
      comment_id TEXT,
      created_at INTEGER NOT NULL,
      seen_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_notifications_user_created ON ps_notifications (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_dm_index (
      owner_user_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, peer_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_dm_index_owner_created ON ps_dm_index (owner_user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_read_state (
      owner_user_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, room_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_read_state_owner ON ps_read_state (owner_user_id);
    CREATE TABLE IF NOT EXISTS ps_conversation_state (
      owner_user_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      unread_count INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER NOT NULL DEFAULT 0,
      last_read_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, room_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_conversation_state_owner_message ON ps_conversation_state (owner_user_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ps_conversation_state_room ON ps_conversation_state (room_id, owner_user_id);
    CREATE TABLE IF NOT EXISTS ps_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      disappear_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_messages_room_created ON ps_messages (room_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ps_messages_room_user_created ON ps_messages (room_id, user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_message_reactions (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_message_reactions_message ON ps_message_reactions (message_id, created_at);
    CREATE TABLE IF NOT EXISTS ps_message_receipts (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      delivered_at INTEGER NOT NULL DEFAULT 0,
      read_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_message_receipts_message_state ON ps_message_receipts (message_id, read_at, delivered_at);
    CREATE TABLE IF NOT EXISTS ps_link_previews (
      url_hash TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      description TEXT,
      image_url TEXT,
      site_name TEXT,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_link_previews_expiry ON ps_link_previews (expires_at);
    CREATE TABLE IF NOT EXISTS ps_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ps_user_feeds (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_user_feeds_user_created ON ps_user_feeds (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_presence (
      user_id TEXT PRIMARY KEY,
      last_seen_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_presence_seen ON ps_presence (last_seen_at DESC);
    CREATE TABLE IF NOT EXISTS ps_typing_state (
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_typing_room_expiry ON ps_typing_state (room_id, expires_at);
    CREATE TABLE IF NOT EXISTS ps_webauthn_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      challenge TEXT NOT NULL,
      rp_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_webauthn_expiry ON ps_webauthn_challenges (expires_at);
    CREATE TABLE IF NOT EXISTS ps_media_files (
      key TEXT PRIMARY KEY,
      data BLOB NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ps_users_username_lower ON ps_users (username_lower) WHERE username_lower IS NOT NULL AND username_lower <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ps_users_email_lower ON ps_users (email_lower) WHERE email_lower IS NOT NULL AND email_lower <> '';
  `);
    await tursoMigrate();
    await tursoMigrateSensitiveData();
    return true;
  } catch (error) {
    state._tursoReady = false;
    throw error;
  }
}

/**
 * Additive column migrations.
 *
 * CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, even
 * if the existing table is missing columns the schema above declares. So a
 * table created by an older build keeps its old shape forever and every query
 * touching a newer column fails at runtime.
 *
 * That is not hypothetical: ps_rate_limits in production was created with only
 * (key, count, reset_at, updated_at). The schema above also declares
 * locked_until and first_at, which the brute-force lockout in ratelimit.js
 * needs — so checkAccountLock() and recordLoginFail() were throwing
 *   "no such column: first_at"
 * on every login and silently falling back to per-isolate memory. The lockout
 * still worked within one isolate, but an attacker spreading attempts across
 * isolates was never durably locked out. Found by the structured error logging
 * added in v154.
 *
 * Each entry is idempotent: we read the live column list and only add what is
 * missing. Adding a column with a constant DEFAULT is a fast metadata-only
 * operation in SQLite, so this is safe to run on every cold start.
 */
async function tursoMigrate() {
  const wanted = {
    ps_rate_limits: {
      locked_until: 'INTEGER DEFAULT 0',
      first_at: 'INTEGER DEFAULT 0',
    },
  };
  const c = tursoClient();
  for (const [table, columns] of Object.entries(wanted)) {
    try {
      const info = await c.execute({ sql: `PRAGMA table_info(${table})` });
      const have = new Set((info.rows || []).map((r) => String(r.name)));
      if (have.size === 0) continue;
      for (const [col, decl] of Object.entries(columns)) {
        if (have.has(col)) continue;
        try {
          await c.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${col} ${decl}` });
          console.log(JSON.stringify({ level: 'info', msg: 'schema_migrated', table, column: col }));
        } catch (e) {
          if (!/duplicate column/i.test(String((e && e.message) || ''))) {
            console.warn('[tursoMigrate] failed', table, col, e && e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[tursoMigrate] table_info failed for', table, e && e.message);
    }
  }
}

/** One-time migration that removes plaintext PII from both structured rows and ps_kv. */
async function tursoMigrateSensitiveData() {
  if (!isFieldEncryptionEnabled()) return;
  const c = tursoClient();
  const marker = await c.execute({ sql: 'SELECT value FROM ps_meta WHERE key = ? LIMIT 1', args: ['pii_encryption_v2'] });
  if (marker.rows?.length) return;
  const [usersRs, kvRs] = await c.batch([
    { sql: 'SELECT id, data_json FROM ps_users' },
    { sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] },
  ], 'read');
  const now = nowMs();
  const statements = [];
  for (const row of usersRs.rows || []) {
    const parsed = safeJson(String(row.data_json || ''), null);
    if (!parsed || !parsed.id) continue;
    const plain = await decryptUserPII(parsed);
    const protectedUser = await encryptUserPII(plain);
    statements.push({
      sql: 'UPDATE ps_users SET username_lower = ?, email_lower = ?, data_json = ?, updated_at = ? WHERE id = ?',
      args: [String(plain.username || '').toLowerCase(), await emailIndex(plain.email), JSON.stringify(protectedUser), now, String(row.id)],
    });
  }
  const kvRow = kvRs.rows?.[0];
  if (kvRow) {
    const database = normalizeDb(safeJson(String(kvRow.value || '{}'), {}));
    const protectedDb = await encryptDatabasePII(database);
    statements.push({ sql: 'UPDATE ps_kv SET value = ?, version = version + 1, updated_at = ? WHERE key = ?', args: [JSON.stringify(protectedDb), now, 'db'] });
  }
  statements.push({ sql: `INSERT OR IGNORE INTO ps_user_feeds (user_id, post_id, created_at)
                          SELECT user_id, id, created_at FROM ps_posts WHERE deleted_at IS NULL` });
  statements.push({
    sql: 'INSERT INTO ps_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    args: ['pii_encryption_v2', 'complete', now],
  });
  await c.batch(statements, 'write');
  console.log(JSON.stringify({ level: 'info', msg: 'pii_encryption_migrated', users: usersRs.rows?.length || 0 }));
}

// ---------- Turso/libSQL full JSON primary storage ----------
export async function tursoReadDb() {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
  if (!rs.rows || rs.rows.length === 0) return normalizeDb({});
  return normalizeDb(await decryptDatabasePII(safeJson(String(rs.rows[0].value || '{}'), normalizeDb({}))));
}

export async function tursoReadDbVersioned() {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT value, version FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
  if (!rs.rows || rs.rows.length === 0) return { db: normalizeDb({}), version: null };
  const db = normalizeDb(await decryptDatabasePII(safeJson(String(rs.rows[0].value || '{}'), normalizeDb({}))));
  return { db, version: Number(rs.rows[0].version || 0) };
}

export async function tursoWriteDb(dbObj) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const db = normalizeDb(dbObj);
  db.meta = { ...(db.meta || {}), storage: 'turso-json-v2-encrypted', updatedAt: Date.now() };
  const protectedDb = await encryptDatabasePII(db);
  const ts = nowMs();
  await tursoClient().execute({
    sql: `INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = ps_kv.version + 1, updated_at = excluded.updated_at`,
    args: ['db', JSON.stringify(protectedDb), ts],
  });
  return true;
}

export async function tursoWriteDbCAS(dbObj, expectedVersion) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const db = normalizeDb(dbObj);
  db.meta = { ...(db.meta || {}), storage: 'turso-json-v2-encrypted', updatedAt: Date.now() };
  const protectedDb = await encryptDatabasePII(db);
  const ts = nowMs();
  if (expectedVersion === null || expectedVersion === undefined) {
    const rs = await tursoClient().execute({
      sql: 'INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO NOTHING',
      args: ['db', JSON.stringify(protectedDb), ts],
    });
    return Number(rs.rowsAffected || 0) > 0;
  }
  const rs = await tursoClient().execute({
    sql: 'UPDATE ps_kv SET value = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?',
    args: [JSON.stringify(protectedDb), ts, 'db', Number(expectedVersion || 0)],
  });
  return Number(rs.rowsAffected || 0) > 0;
}

export async function tursoResetDb() {
  if (!isTursoConfigured()) return false;
  const empty = normalizeDb({ users: [], messages: [], scheduledMessages: [], posts: [], notifications: [], typing: {}, heartbeat: {}, rtcSignals: [], meta: { storage: 'turso-json-v1', resetAt: Date.now() } });
  await tursoWriteDb(empty);
  state.localCache = empty;
  state.cacheTimestamp = Date.now();
  return true;
}

export async function syncTursoMirror(db) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const c = tursoClient();
  const src = normalizeDb(db);
  const ts = nowMs();
  try {
    const statements = [{ sql: 'DELETE FROM ps_users' }];
    for (const u of src.users || []) {
      // PII is encrypted at the storage boundary, and email_lower becomes a
      // blind index so login can still look it up. See crypto-fields.js.
      const encU = await encryptUserPII(u);
      statements.push({
        sql: 'INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?)',
        args: [u.id, String(u.username || '').toLowerCase(), await emailIndex(u.email), Number(u.createdAt || 0), ts, JSON.stringify(encU)],
      });
    }
    statements.push({ sql: 'DELETE FROM ps_posts' });
    for (const p of src.posts || []) {
      statements.push({
        sql: 'INSERT INTO ps_posts (id, user_id, created_at, deleted_at, story, story_expires_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [p.id, p.userId, Number(p.createdAt || 0), p.deletedAt ? Number(p.deletedAt) : null, p.story ? 1 : 0, p.storyExpiresAt ? Number(p.storyExpiresAt) : null, ts, JSON.stringify(p)],
      });
    }
    statements.push({ sql: 'DELETE FROM ps_notifications' });
    for (const n of src.notifications || []) {
      statements.push({
        sql: 'INSERT INTO ps_notifications (id, user_id, from_user_id, kind, created_at, seen_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [n.id, n.userId, n.fromUserId || null, n.kind || null, Number(n.createdAt || 0), n.seenAt ? Number(n.seenAt) : null, ts, JSON.stringify(n)],
      });
    }
    const dmIndex = new Map();
    for (const m of src.messages || []) {
      if (!m || m.deletedAt || typeof m.roomId !== 'string' || !m.roomId.startsWith('dm:')) continue;
      const parts = m.roomId.slice(3).split(':').filter(Boolean);
      if (parts.length !== 2) continue;
      for (const ownerId of parts) {
        const peerId = parts.find(id => id !== ownerId);
        if (!peerId) continue;
        const key = ownerId + '|' + peerId;
        const prev = dmIndex.get(key);
        if (prev && Number(prev.createdAt || 0) >= Number(m.createdAt || 0)) continue;
        let preview;
        if (m.encrypted) preview = '🔒 Encrypted message';
        else if (m.storyReply) preview = 'Replied to a story';
        else if (m.imageUrl) preview = '📷 Photo';
        else preview = String(m.text || '').slice(0, 60);
        dmIndex.set(key, {
          ownerUserId: ownerId,
          peerUserId: peerId,
          roomId: m.roomId,
          messageId: m.id,
          createdAt: Number(m.createdAt || 0),
          fromMe: m.userId === ownerId,
          text: preview,
        });
      }
    }
    statements.push({ sql: 'DELETE FROM ps_dm_index' });
    for (const row of dmIndex.values()) {
      statements.push({
        sql: 'INSERT INTO ps_dm_index (owner_user_id, peer_user_id, room_id, created_at, from_me, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [row.ownerUserId, row.peerUserId, row.roomId, row.createdAt, row.fromMe ? 1 : 0, ts, JSON.stringify(row)],
      });
    }
    statements.push({ sql: 'DELETE FROM ps_messages' });
    for (const m of src.messages || []) {
      statements.push({
        sql: 'INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, disappear_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [m.id, m.roomId || 'general-group', m.userId || '', Number(m.createdAt || 0), m.deletedAt ? Number(m.deletedAt) : null, m.disappearAt ? Number(m.disappearAt) : null, ts, JSON.stringify(m)],
      });
    }
    statements.push({
      sql: 'INSERT INTO ps_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      args: ['bootstrap_v1', String(ts), ts],
    });
    await c.batch(statements, 'write');
    state._tursoBootstrapped = true;
    return true;
  } catch (e) {
    console.warn('[turso] sync failed', e && e.message);
    return false;
  }
}

export async function fetchTursoMirror(fallbackDb = null) {
  if (!isTursoConfigured()) return fallbackDb ? normalizeDb(fallbackDb) : normalizeDb({});
  try {
    await tursoEnsure();
    const c = tursoClient();
    if (!state._tursoBootstrapped) {
      const meta = await c.execute({ sql: 'SELECT value FROM ps_meta WHERE key = ?', args: ['bootstrap_v1'] }).catch(() => ({ rows: [] }));
      if (!meta.rows || meta.rows.length === 0) {
        if (fallbackDb) await syncTursoMirror(fallbackDb);
      } else {
        state._tursoBootstrapped = true;
      }
    }
    let usersRows = await c.execute('SELECT data_json FROM ps_users ORDER BY created_at ASC');
    let postsRows = await c.execute('SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300');
    if ((!usersRows.rows?.length && !postsRows.rows?.length) && fallbackDb) {
      await syncTursoMirror(fallbackDb);
      usersRows = await c.execute('SELECT data_json FROM ps_users ORDER BY created_at ASC');
      postsRows = await c.execute('SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300');
    }
    return normalizeDb({
      users: await Promise.all(
        (usersRows.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean).map(decryptUserPII)
      ),
      posts: (postsRows.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean),
    });
  } catch (e) {
    console.warn('[turso] mirror read failed', e && e.message);
    return fallbackDb ? normalizeDb(fallbackDb) : normalizeDb({});
  }
}

export async function fetchTursoUserById(userId) {
  if (!isTursoConfigured() || !userId) return null;
  await tursoEnsure();
  // Authentication callers must distinguish a missing row from database
  // unavailability. Never collapse a failed durable read into an empty result.
  const row = await tursoClient().execute({
    sql: 'SELECT data_json FROM ps_users WHERE id = ? LIMIT 1',
    args: [userId],
  });
  if (!row.rows || row.rows.length === 0) return null;
  return await decryptUserPII(safeJson(String(row.rows[0].data_json || '{}'), null));
}

export async function fetchTursoNotifications(userId) {
  if (!isTursoConfigured() || !userId) return [];
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT data_json FROM ps_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', args: [userId] }).catch(() => ({ rows: [] }));
  return (rs.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean);
}

export async function fetchTursoDmIndex(ownerUserId) {
  if (!isTursoConfigured() || !ownerUserId) return {};
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT data_json FROM ps_dm_index WHERE owner_user_id = ? ORDER BY created_at DESC', args: [ownerUserId] }).catch(() => ({ rows: [] }));
  const out = {};
  for (const row of (rs.rows || [])) {
    const item = safeJson(String(row.data_json || '{}'), null);
    if (item && item.peerUserId) out[item.peerUserId] = { text: item.text || '', createdAt: Number(item.createdAt || 0), fromMe: !!item.fromMe };
  }
  return out;
}

export async function fetchTursoMessages(roomId, now = nowMs(), options = {}) {
  if (!isTursoConfigured() || !roomId) return null;
  try {
    await tursoEnsure();
    const before = Number(options.beforeTimestamp || 0);
    const since = Number(options.sinceTimestamp || 0);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 30));
    const whereCursor = since > 0 ? ' AND created_at > ?' : (before > 0 ? ' AND created_at < ?' : '');
    const args = [roomId, Number(now || 0)];
    if (since > 0) args.push(since);
    else if (before > 0) args.push(before);
    args.push(limit + 1);
    const order = since > 0 ? 'ASC' : 'DESC';
    const pageSql = `SELECT id, data_json FROM ps_messages
                     WHERE room_id = ?
                       AND (deleted_at IS NULL OR deleted_at = 0)
                       AND (disappear_at IS NULL OR disappear_at > ?)
                       ${whereCursor}
                     ORDER BY created_at ${order} LIMIT ?`;
    const idPageSql = pageSql.replace('SELECT id, data_json', 'SELECT id');
    // All three indexed reads share one libSQL round trip. Reactions/receipts
    // are narrow side tables, so status changes never rewrite message blobs.
    const [messageRs, reactionRs, receiptRs] = await tursoClient().batch([
      { sql: pageSql, args },
      { sql: `SELECT message_id, user_id, emoji, created_at FROM ps_message_reactions
              WHERE message_id IN (${idPageSql}) ORDER BY created_at ASC`, args },
      { sql: `SELECT message_id, user_id, delivered_at, read_at FROM ps_message_receipts
              WHERE message_id IN (${idPageSql})`, args },
    ], 'read');
    let list = (messageRs?.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean);
    const hasMore = list.length > limit;
    if (hasMore) list = list.slice(0, limit);
    list.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    list.forEach(m => { m.reactions = []; m.receipts = {}; });
    const byId = new Map(list.map(m => [String(m.id), m]));
    for (const row of (reactionRs?.rows || [])) {
      const message = byId.get(String(row.message_id));
      if (!message) continue;
      message.reactions.push({ userId: String(row.user_id), emoji: String(row.emoji), createdAt: Number(row.created_at || 0) });
    }
    for (const row of (receiptRs?.rows || [])) {
      const message = byId.get(String(row.message_id));
      if (!message) continue;
      message.receipts[String(row.user_id)] = {
        deliveredAt: Number(row.delivered_at || 0),
        readAt: Number(row.read_at || 0),
      };
    }
    return { messages: list, hasMore, nextCursor: list.length ? Number(list[0].createdAt || 0) : null };
  } catch (e) {
    console.warn('[turso] messages read failed', e && e.message);
    return null;
  }
}

export async function tursoSetMessageReaction(messageId, userId, emoji, active, createdAt = nowMs()) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const statement = active
    ? { sql: `INSERT INTO ps_message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(message_id, user_id, emoji) DO UPDATE SET created_at=excluded.created_at`, args: [messageId, userId, emoji, createdAt] }
    : { sql: 'DELETE FROM ps_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', args: [messageId, userId, emoji] };
  await tursoClient().execute(statement);
  return true;
}

export async function tursoUpsertMessageReceipts(userId, messageIds, stateName, at = nowMs()) {
  if (!isTursoConfigured() || !userId || !Array.isArray(messageIds) || !messageIds.length) return false;
  await tursoEnsure();
  const isRead = stateName === 'read';
  const statements = messageIds.slice(0, 100).map(messageId => ({
    sql: `INSERT INTO ps_message_receipts (message_id, user_id, delivered_at, read_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(message_id, user_id) DO UPDATE SET
            delivered_at=MAX(ps_message_receipts.delivered_at, excluded.delivered_at),
            read_at=MAX(ps_message_receipts.read_at, excluded.read_at),
            updated_at=excluded.updated_at`,
    args: [messageId, userId, at, isRead ? at : 0, at],
  }));
  await tursoClient().batch(statements, 'write');
  return true;
}

export async function tursoUpsertUser(user) {
  if (!isTursoConfigured() || !user) return false;
  await tursoEnsure();
  const ts = nowMs();
  // Deliberately let constraint/storage errors reach the caller. Signup and
  // username-change routes translate UNIQUE failures to 409; swallowing them
  // here would let a racing request report success without a durable identity.
  await tursoClient().execute({
    sql: 'INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username_lower=excluded.username_lower, email_lower=excluded.email_lower, updated_at=excluded.updated_at, data_json=excluded.data_json',
    args: [user.id, String(user.username || '').toLowerCase(), await emailIndex(user.email), Number(user.createdAt || 0), ts, JSON.stringify(await encryptUserPII(user))],
  });
  return true;
}

export async function tursoUpsertPosts(posts) {
  if (!isTursoConfigured()) return false;
  const list = (posts || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map(p => ({
    sql: 'INSERT INTO ps_posts (id, user_id, created_at, deleted_at, story, story_expires_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, created_at=excluded.created_at, deleted_at=excluded.deleted_at, story=excluded.story, story_expires_at=excluded.story_expires_at, updated_at=excluded.updated_at, data_json=excluded.data_json',
    args: [p.id, p.userId, Number(p.createdAt || 0), p.deletedAt ? Number(p.deletedAt) : null, p.story ? 1 : 0, p.storyExpiresAt ? Number(p.storyExpiresAt) : null, ts, JSON.stringify(p)],
  }));
  await tursoClient().batch(stmts, 'write').catch(e => { console.warn('[turso] post upsert failed', e && e.message); });
  return true;
}

export async function tursoUpsertNotifications(notifs) {
  if (!isTursoConfigured()) return false;
  const list = (notifs || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map(n => ({
    sql: 'INSERT INTO ps_notifications (id, user_id, from_user_id, kind, created_at, seen_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, from_user_id=excluded.from_user_id, kind=excluded.kind, created_at=excluded.created_at, seen_at=excluded.seen_at, updated_at=excluded.updated_at, data_json=excluded.data_json',
    args: [n.id, n.userId, n.fromUserId || null, n.kind || null, Number(n.createdAt || 0), n.seenAt ? Number(n.seenAt) : null, ts, JSON.stringify(n)],
  }));
  await tursoClient().batch(stmts, 'write').catch(e => { console.warn('[turso] notification upsert failed', e && e.message); });
  return true;
}

export async function tursoClearNotificationsForUser(userId) {
  if (!isTursoConfigured() || !userId) return false;
  await tursoEnsure();
  await tursoClient().execute({ sql: 'DELETE FROM ps_notifications WHERE user_id = ?', args: [userId] }).catch(e => { console.warn('[turso] notification clear failed', e && e.message); });
  return true;
}

export async function tursoUpsertMessages(messages) {
  if (!isTursoConfigured()) return false;
  const list = (messages || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map(m => ({
    sql: 'INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, disappear_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id, user_id=excluded.user_id, created_at=excluded.created_at, deleted_at=excluded.deleted_at, disappear_at=excluded.disappear_at, updated_at=excluded.updated_at, data_json=excluded.data_json',
    args: [m.id, m.roomId || 'general-group', m.userId || '', Number(m.createdAt || 0), m.deletedAt ? Number(m.deletedAt) : null, m.disappearAt ? Number(m.disappearAt) : null, ts, JSON.stringify(m)],
  }));
  await tursoClient().batch(stmts, 'write').catch(e => { console.warn('[turso] message upsert failed', e && e.message); });
  return true;
}

// Bug #8 fix: Use UPSERT instead of DELETE+INSERT to avoid race conditions
// when multiple concurrent requests refresh DM index for the same owner.
export async function tursoRefreshDmIndexForOwners(db, ownerIds) {
  if (!isTursoConfigured()) return false;
  const owners = Array.from(new Set((ownerIds || []).filter(Boolean)));
  if (!owners.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = [];
  for (const ownerId of owners) {
    const dmIndex = new Map();
    for (const m of (db.messages || [])) {
      if (!m || m.deletedAt || typeof m.roomId !== 'string' || !m.roomId.startsWith('dm:')) continue;
      const parts = m.roomId.slice(3).split(':').filter(Boolean);
      if (!parts.includes(ownerId) || parts.length !== 2) continue;
      const peerId = parts.find(id => id !== ownerId);
      if (!peerId) continue;
      const prev = dmIndex.get(peerId);
      if (prev && Number(prev.createdAt || 0) >= Number(m.createdAt || 0)) continue;
      let preview;
      if (m.encrypted) preview = '🔒 Encrypted message';
      else if (m.storyReply) preview = 'Replied to a story';
      else if (m.imageUrl) preview = '📷 Photo';
      else preview = String(m.text || '').slice(0, 60);
      dmIndex.set(peerId, {
        ownerUserId: ownerId,
        peerUserId: peerId,
        roomId: m.roomId,
        createdAt: Number(m.createdAt || 0),
        fromMe: m.userId === ownerId,
        text: preview,
      });
    }
    // Use UPSERT: only update if new message is more recent to avoid race clobbering
    for (const row of dmIndex.values()) {
      stmts.push({
        sql: `INSERT INTO ps_dm_index (owner_user_id, peer_user_id, room_id, created_at, from_me, updated_at, data_json) 
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner_user_id, peer_user_id) DO UPDATE SET
                room_id = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.room_id ELSE ps_dm_index.room_id END,
                created_at = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.created_at ELSE ps_dm_index.created_at END,
                from_me = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.from_me ELSE ps_dm_index.from_me END,
                updated_at = excluded.updated_at,
                data_json = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.data_json ELSE ps_dm_index.data_json END`,
        args: [row.ownerUserId, row.peerUserId, row.roomId, row.createdAt, row.fromMe ? 1 : 0, ts, JSON.stringify(row)],
      });
    }
  }
  if (stmts.length) await tursoClient().batch(stmts, 'write').catch(e => { console.warn('[turso] dm index refresh failed', e && e.message); });
  return true;
}

 // users with <= this many followers get push fan-out
export async function tursoUpsertUserFeeds(userFeeds) {
  if (!isTursoConfigured() || !Array.isArray(userFeeds) || userFeeds.length === 0) return;
  await tursoEnsure();
  const stmts = userFeeds.map(uf => ({
    sql: `INSERT INTO ps_user_feeds (user_id, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, post_id) DO UPDATE SET created_at = excluded.created_at`,
    args: [uf.userId, uf.postId, uf.createdAt]
  }));
  await tursoClient().batch(stmts, 'write').catch(e => console.warn('[turso] user_feeds upsert failed', e?.message));
}

export async function fetchTursoUserFeed(userId, limit = 20) {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const capped = Math.max(5, Math.min(50, Number(limit) || 20));
  const rs = await tursoClient().execute({
    sql: `SELECT p.data_json
          FROM ps_user_feeds f
          JOIN ps_posts p ON p.id = f.post_id
          WHERE f.user_id = ? AND p.deleted_at IS NULL
          ORDER BY f.created_at DESC LIMIT ?`,
    args: [userId, capped],
  });
  return (rs.rows || []).map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
}

// ---------- Per-room read state + unread counts ----------
// A conversation's unread count is "messages in that room, from someone else,
// created after the last time I opened it". last_read_at lives in
// ps_read_state (one row per user+room) and is stamped by
// POST /api/messages/read when the client opens a thread.

// Rooms this user takes part in: the shared group plus any dm: room whose id
// contains their user id (dm ids are 'dm:<sortedIdA>:<sortedIdB>').
const _MY_ROOMS_SQL = "(m.room_id = 'general-group' OR (m.room_id LIKE 'dm:%' AND instr(m.room_id, ?) > 0))";

/**
 * Timestamp before which everything counts as already read.
 *
 * Written once, the first time this code touches the database, and never
 * changed. Without it, shipping unread counts against a database full of
 * history would greet every existing user with hundreds of unread badges.
 *
 * A global epoch is deliberately used instead of seeding each user lazily on
 * their first request: lazy seeding stamps "now", so a message that arrived
 * before the user's very first page load would be silently marked read.
 */
async function _unreadEpoch() {
  if (state._unreadEpoch) return state._unreadEpoch;
  const c = tursoClient();
  const ts = nowMs();
  // One batch, not two awaits: this runs on the first /users of every cold
  // isolate, and sequential round trips there are exactly the kind of
  // per-request overhead that trips Cloudflare's CPU limit (503 / 1102).
  const res = await c.batch([
    { sql: 'INSERT INTO ps_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING', args: ['unread_epoch', String(ts), ts] },
    { sql: 'SELECT value FROM ps_meta WHERE key = ?', args: ['unread_epoch'] },
  ], 'write').catch(() => null);
  const rows = res && res[1] && res[1].rows;
  const val = Number((rows && rows[0] && rows[0].value) || ts);
  state._unreadEpoch = Number.isFinite(val) && val > 0 ? val : ts;
  return state._unreadEpoch;
}

/**
 * Unread count per room for one user: { [roomId]: count }.
 * A message is unread when it is newer than this user's last_read_at for that
 * room (or newer than the global epoch, if they have never opened it).
 */
export async function fetchTursoUnreadCounts(myId) {
  if (!isTursoConfigured() || !myId) return {};
  await tursoEnsure();
  const c = tursoClient();
  try {
    const markerKey = `unread-materialized:${myId}`;
    const [stateRs, markerRs] = await c.batch([
      { sql: 'SELECT room_id, unread_count FROM ps_conversation_state WHERE owner_user_id = ? AND unread_count > 0', args: [myId] },
      { sql: 'SELECT value FROM ps_meta WHERE key = ? LIMIT 1', args: [markerKey] },
    ], 'read');
    if ((markerRs?.rows || []).length) {
      const out = {};
      for (const row of (stateRs?.rows || [])) {
        const n = Math.max(0, Number(row.unread_count || 0));
        if (n) out[String(row.room_id)] = n;
      }
      return out;
    }

    // One-time backfill for pre-v169 databases. Subsequent inbox reads are
    // narrow indexed lookups; they never repeat this grouped COUNT scan.
    const epoch = await _unreadEpoch();
    const legacy = await c.execute({
      sql: `SELECT m.room_id AS room_id, COUNT(*) AS n, MAX(m.created_at) AS last_message_at,
                   COALESCE(r.last_read_at, ?) AS last_read_at
            FROM ps_messages m
            LEFT JOIN ps_read_state r
              ON r.owner_user_id = ? AND r.room_id = m.room_id
            WHERE ${_MY_ROOMS_SQL}
              AND m.user_id != ?
              AND (m.deleted_at IS NULL OR m.deleted_at = 0)
              AND (m.disappear_at IS NULL OR m.disappear_at > ?)
              AND m.created_at > COALESCE(r.last_read_at, ?)
            GROUP BY m.room_id`,
      args: [epoch, myId, myId, myId, nowMs(), epoch],
    });
    const out = {};
    const ts = nowMs();
    const writes = [];
    for (const row of (legacy.rows || [])) {
      const n = Math.max(0, Number(row.n || 0));
      if (n) out[String(row.room_id)] = n;
      writes.push({
        sql: `INSERT INTO ps_conversation_state (owner_user_id, room_id, unread_count, last_message_at, last_read_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner_user_id, room_id) DO UPDATE SET
                unread_count=excluded.unread_count,
                last_message_at=MAX(ps_conversation_state.last_message_at, excluded.last_message_at),
                last_read_at=MAX(ps_conversation_state.last_read_at, excluded.last_read_at),
                updated_at=excluded.updated_at`,
        args: [myId, String(row.room_id), n, Number(row.last_message_at || 0), Number(row.last_read_at || epoch), ts],
      });
    }
    writes.push({
      sql: 'INSERT INTO ps_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      args: [markerKey, '1', ts],
    });
    await c.batch(writes, 'write');
    return out;
  } catch (e) {
    console.warn('[turso] unread counts failed', e && e.message);
    return {};
  }
}

/** Stamp a room as read up to `ts` for one user. */
export async function tursoMarkRoomRead(myId, roomId, ts = nowMs()) {
  return tursoMarkRoomsRead(myId, [{ roomId, at: ts }]);
}

export async function tursoMarkRoomsRead(myId, receipts) {
  if (!isTursoConfigured() || !myId || !Array.isArray(receipts) || receipts.length === 0) return false;
  await tursoEnsure();
  const updatedAt = nowMs();
  const statements = receipts.slice(0, 50).flatMap((receipt) => {
    const at = Number(receipt.at) || updatedAt;
    return [
      {
        sql: `INSERT INTO ps_read_state (owner_user_id, room_id, last_read_at, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(owner_user_id, room_id) DO UPDATE SET
                last_read_at = MAX(ps_read_state.last_read_at, excluded.last_read_at),
                updated_at = excluded.updated_at`,
        args: [myId, receipt.roomId, at, updatedAt],
      },
      {
        sql: `INSERT INTO ps_conversation_state (owner_user_id, room_id, unread_count, last_message_at, last_read_at, updated_at)
              VALUES (?, ?, 0, 0, ?, ?)
              ON CONFLICT(owner_user_id, room_id) DO UPDATE SET
                unread_count = CASE WHEN excluded.last_read_at >= ps_conversation_state.last_read_at THEN 0 ELSE ps_conversation_state.unread_count END,
                last_read_at = MAX(ps_conversation_state.last_read_at, excluded.last_read_at),
                updated_at = excluded.updated_at`,
        args: [myId, receipt.roomId, at, updatedAt],
      },
    ];
  });
  try {
    await tursoClient().batch(statements, 'write');
    return true;
  } catch (e) {
    console.warn('[turso] mark read batch failed', e && e.message);
    return false;
  }
}

/**
 * Self-healing migration for ps_notifications.post_id / comment_id.
 *
 * Deliberately NOT called from tursoEnsure(): that runs on the first Turso
 * touch of every cold isolate, i.e. the hot path of every endpoint, and the
 * extra PRAGMA + ALTER round trips there pushed requests over Cloudflare's
 * per-request CPU limit (HTTP 503, "error code: 1102") on routes that had
 * nothing to do with notifications.
 *
 * Instead this is invoked only from the error path of a write that failed
 * because the columns are missing - once per isolate, effectively once per
 * database.
 */
export async function tursoHealNotificationColumns() {
  if (!isTursoConfigured()) return false;
  if (state._notifColsHealed) return true;
  try {
    const c = tursoClient();
    const info = await c.execute('PRAGMA table_info(ps_notifications)');
    const cols = new Set((info.rows || []).map(r => String(r.name)));
    if (!cols.has('post_id')) await c.execute('ALTER TABLE ps_notifications ADD COLUMN post_id TEXT');
    if (!cols.has('comment_id')) await c.execute('ALTER TABLE ps_notifications ADD COLUMN comment_id TEXT');
    state._notifColsHealed = true;
    console.log('[turso] healed ps_notifications columns');
    return true;
  } catch (e) {
    console.warn('[turso] notification column heal failed:', e && e.message);
    return false;
  }
}

// ---- v175: media objects in Turso (ps_media_files) -------------------------
// Media (photos/videos/avatars) is stored as BLOBs and served same-origin
// by the worker at /media/* so client devices never need to reach an
// external CDN (raw.githubusercontent.com) to render a post or avatar.
export async function tursoPutMedia(key, data, contentType) {
  const c = tursoClient();
  const bin = data instanceof Uint8Array ? data : new Uint8Array(data);
  await c.execute({
    sql: `INSERT INTO ps_media_files (key, data, content_type, size, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET data=excluded.data, content_type=excluded.content_type, size=excluded.size`,
    args: [key, bin, String(contentType || 'application/octet-stream'), bin.length, Date.now()],
  });
}

export async function tursoGetMedia(key) {
  const c = tursoClient();
  const res = await c.execute({ sql: `SELECT data, content_type, size FROM ps_media_files WHERE key = ?`, args: [key] });
  const row = res.rows && res.rows[0];
  if (!row || !row.data) return null;
  const data = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
  return { data, contentType: row.content_type || 'application/octet-stream', size: Number(row.size) || data.length };
}
