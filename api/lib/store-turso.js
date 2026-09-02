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
import { state } from './state.js';
import { nowMs, safeJson } from './helpers.js';
import { normalizeDb } from './schema.js';

// ---------- Persistence routing (Turso primary, GitHub fallback) ----------
// Neon Postgres has been removed from this build. Turso is the only primary
// store. If Turso is unreachable or not configured, the app falls back to
// reading/writing the GitHub db.json path. For local dev with neither
// configured, an in-memory cache is used.
//
// (Historical note: this file once carried dead Neon stubs — isNeonPrimary,
// neonReadDb, etc. They were deleted, but two call sites in store-github.js
// were missed and threw ReferenceError whenever the GitHub fallback ran. Fixed
// in v154; do not reintroduce references to them.)
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
    if (!store.client) store.client = createTursoClient({ url: cfg.TURSO_DATABASE_URL, authToken: cfg.TURSO_AUTH_TOKEN });
    return store.client;
  }
  // Fallback for any code path that runs outside the per-request ALS context
  // (e.g. scheduled/background work). Still request-scoped in spirit: a new
  // client each time, never cached at module level.
  return createTursoClient({ url: cfg.TURSO_DATABASE_URL, authToken: cfg.TURSO_AUTH_TOKEN });
}

// Runs `fn` inside a fresh per-request Turso-client scope. Wired into the
// global '*' middleware below so every request gets exactly one scope.
export function runWithTursoRequestScope(fn) {
  return _tursoAls.run({ client: null }, fn);
}

export async function tursoEnsure() {
  if (!isTursoConfigured()) return false;
  if (state._tursoReady) return true;
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
  `);
  state._tursoReady = true;
  return true;
}

// ---------- Turso/libSQL full JSON primary storage ----------
export async function tursoReadDb() {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
  if (!rs.rows || rs.rows.length === 0) return normalizeDb({});
  return normalizeDb(safeJson(String(rs.rows[0].value || '{}'), normalizeDb({})));
}

export async function tursoReadDbVersioned() {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT value, version FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
  if (!rs.rows || rs.rows.length === 0) return { db: normalizeDb({}), version: null };
  return { db: normalizeDb(safeJson(String(rs.rows[0].value || '{}'), normalizeDb({}))), version: Number(rs.rows[0].version || 0) };
}

export async function tursoWriteDb(dbObj) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const db = normalizeDb(dbObj);
  db.meta = { ...(db.meta || {}), storage: 'turso-json-v1', updatedAt: Date.now() };
  const ts = nowMs();
  await tursoClient().execute({
    sql: `INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = ps_kv.version + 1, updated_at = excluded.updated_at`,
    args: ['db', JSON.stringify(db), ts],
  });
  return true;
}

export async function tursoWriteDbCAS(dbObj, expectedVersion) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const db = normalizeDb(dbObj);
  db.meta = { ...(db.meta || {}), storage: 'turso-json-v1', updatedAt: Date.now() };
  const ts = nowMs();
  if (expectedVersion === null || expectedVersion === undefined) {
    const rs = await tursoClient().execute({
      sql: 'INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO NOTHING',
      args: ['db', JSON.stringify(db), ts],
    });
    return Number(rs.rowsAffected || 0) > 0;
  }
  const rs = await tursoClient().execute({
    sql: 'UPDATE ps_kv SET value = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?',
    args: [JSON.stringify(db), ts, 'db', Number(expectedVersion || 0)],
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
      statements.push({
        sql: 'INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?)',
        args: [u.id, String(u.username || '').toLowerCase(), String(u.email || '').toLowerCase(), Number(u.createdAt || 0), ts, JSON.stringify(u)],
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
      users: (usersRows.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean),
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
  const row = await tursoClient().execute({ sql: 'SELECT data_json FROM ps_users WHERE id = ? LIMIT 1', args: [userId] }).catch(() => ({ rows: [] }));
  if (!row.rows || row.rows.length === 0) return null;
  return safeJson(String(row.rows[0].data_json || '{}'), null);
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

export async function fetchTursoMessages(roomId, now = nowMs()) {
  if (!isTursoConfigured() || !roomId) return null;
  try {
    await tursoEnsure();
    const rs = await tursoClient().execute({
      sql: 'SELECT data_json FROM ps_messages WHERE room_id = ? AND (deleted_at IS NULL OR deleted_at = 0) AND (disappear_at IS NULL OR disappear_at > ?) ORDER BY created_at DESC LIMIT 200',
      args: [roomId, Number(now || 0)],
    });
    const list = (rs.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean);
    return list.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  } catch (e) {
    console.warn('[turso] messages read failed', e && e.message);
    return null;
  }
}

export async function tursoUpsertUser(user) {
  if (!isTursoConfigured() || !user) return false;
  await tursoEnsure();
  const ts = nowMs();
  try {
    await tursoClient().execute({
      sql: 'INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username_lower=excluded.username_lower, email_lower=excluded.email_lower, updated_at=excluded.updated_at, data_json=excluded.data_json',
      args: [user.id, String(user.username || '').toLowerCase(), String(user.email || '').toLowerCase(), Number(user.createdAt || 0), ts, JSON.stringify(user)],
    });
    return true;
  } catch (e) {
    console.warn('[turso] user upsert failed', e && e.message);
    return false;
  }
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
    const epoch = await _unreadEpoch();
    const rs = await c.execute({
      sql: `SELECT m.room_id AS room_id, COUNT(*) AS n
            FROM ps_messages m
            LEFT JOIN ps_read_state r
              ON r.owner_user_id = ? AND r.room_id = m.room_id
            WHERE ${_MY_ROOMS_SQL}
              AND m.user_id != ?
              AND (m.deleted_at IS NULL OR m.deleted_at = 0)
              AND (m.disappear_at IS NULL OR m.disappear_at > ?)
              AND m.created_at > COALESCE(r.last_read_at, ?)
            GROUP BY m.room_id`,
      args: [myId, myId, myId, nowMs(), epoch],
    });
    const out = {};
    for (const row of (rs.rows || [])) {
      const n = Number(row.n || 0);
      if (n > 0) out[String(row.room_id)] = n;
    }
    return out;
  } catch (e) {
    console.warn('[turso] unread counts failed', e && e.message);
    return {};
  }
}

/** Stamp a room as read up to `ts` for one user. */
export async function tursoMarkRoomRead(myId, roomId, ts = nowMs()) {
  if (!isTursoConfigured() || !myId || !roomId) return false;
  await tursoEnsure();
  try {
    await tursoClient().execute({
      sql: `INSERT INTO ps_read_state (owner_user_id, room_id, last_read_at, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(owner_user_id, room_id) DO UPDATE SET
              last_read_at = MAX(ps_read_state.last_read_at, excluded.last_read_at),
              updated_at = excluded.updated_at`,
      args: [myId, roomId, Number(ts) || nowMs(), nowMs()],
    });
    return true;
  } catch (e) {
    console.warn('[turso] mark read failed', e && e.message);
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
