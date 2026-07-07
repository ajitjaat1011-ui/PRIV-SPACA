#!/usr/bin/env node
/**
 * One-time zero-cost migration: Neon Postgres JSON primary -> Turso/libSQL primary.
 *
 * Required env:
 *   DATABASE_URL           Neon Postgres connection string
 *   TURSO_DATABASE_URL     Turso/libSQL URL
 *   TURSO_AUTH_TOKEN       Turso auth token
 *
 * Usage:
 *   DATABASE_URL=... TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
 *     node scripts/migrate-neon-to-turso.mjs --yes
 *
 * The script is non-destructive to Neon. It overwrites Turso PRIV-SPACA tables
 * with a fresh copy from Neon and first writes a local backup of any existing
 * Turso ps_kv JSON row under backups/.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { createClient } from '@libsql/client';

const yes = process.argv.includes('--yes');
if (!yes) {
  console.error('Refusing to overwrite Turso without --yes');
  process.exit(2);
}

const DATABASE_URL = String(process.env.DATABASE_URL || '').replace(/&amp;/g, '&');
const TURSO_DATABASE_URL = String(process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_AUTH_TOKEN = String(process.env.TURSO_AUTH_TOKEN || '').trim();

if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');

const nowMs = () => Date.now();
const safeJson = (s, f) => { try { return JSON.parse(s); } catch { return f; } };
function normalizeDb(db) {
  const out = (db && typeof db === 'object') ? { ...db } : {};
  for (const k of ['users', 'messages', 'scheduledMessages', 'posts', 'notifications', 'rtcSignals']) {
    if (!Array.isArray(out[k])) out[k] = [];
  }
  for (const k of ['typing', 'heartbeat']) {
    if (!out[k] || typeof out[k] !== 'object' || Array.isArray(out[k])) out[k] = {};
  }
  if (!out.meta || typeof out.meta !== 'object' || Array.isArray(out.meta)) out.meta = {};
  return out;
}
function isStoryRecord(post) {
  return !!(post && (post.story === true || post.kind === 'story' || post.storyExpiresAt));
}
async function batch(client, statements, chunkSize = 80) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    await client.batch(statements.slice(i, i + chunkSize), 'write');
  }
}
async function ensureTursoSchema(client) {
  await client.executeMultiple(`
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
    -- UNIQUE constraints prevent TOCTOU on concurrent signups (matches api/index.js tursoEnsure).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_users_username_unique ON ps_users (username_lower);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_users_email_unique ON ps_users (email_lower);
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
}

console.log('[1/5] Reading Neon JSON primary...');
const sql = neon(DATABASE_URL);
const rows = await sql`SELECT value, version FROM priv_spaca_kv WHERE key = 'db' LIMIT 1`;
if (!rows || rows.length === 0) throw new Error('Neon priv_spaca_kv/db row not found');
const raw = rows[0].value;
const db = normalizeDb(typeof raw === 'string' ? safeJson(raw, {}) : raw);
db.meta = { ...(db.meta || {}), storage: 'turso-json-v1', migratedFrom: 'neon-json-v1', migratedAt: nowMs() };
const sourceVersion = Number(rows[0].version || 0);
console.log(`[source] users=${db.users.length} messages=${db.messages.length} posts=${db.posts.length} notifications=${db.notifications.length} neonVersion=${sourceVersion}`);

console.log('[2/5] Preparing Turso schema...');
const turso = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
await ensureTursoSchema(turso);

console.log('[3/5] Backing up existing Turso ps_kv row locally (if any)...');
const existing = await turso.execute({ sql: 'SELECT value, version, updated_at FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] }).catch(() => ({ rows: [] }));
await fs.mkdir('backups', { recursive: true });
const backupPath = path.join('backups', `turso_before_neon_replacement_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(backupPath, JSON.stringify({ at: new Date().toISOString(), existing: existing.rows?.[0] || null }, null, 2));
console.log(`[backup] ${backupPath}`);

console.log('[4/5] Writing full JSON primary into Turso ps_kv...');
const ts = nowMs();
await turso.execute({
  sql: `INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = excluded.version, updated_at = excluded.updated_at`,
  args: ['db', JSON.stringify(db), sourceVersion, ts],
});

console.log('[5/5] Rebuilding structured Turso mirror tables...');
const statements = [];
statements.push({ sql: 'DELETE FROM ps_users' });
for (const u of db.users) {
  statements.push({
    sql: 'INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?)',
    args: [u.id, String(u.username || '').toLowerCase(), String(u.email || '').toLowerCase(), Number(u.createdAt || 0), ts, JSON.stringify(u)],
  });
}
statements.push({ sql: 'DELETE FROM ps_posts' });
for (const post of db.posts) {
  statements.push({
    sql: 'INSERT INTO ps_posts (id, user_id, created_at, deleted_at, story, story_expires_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [post.id, post.userId || '', Number(post.createdAt || 0), post.deletedAt ? Number(post.deletedAt) : null, isStoryRecord(post) ? 1 : 0, post.storyExpiresAt ? Number(post.storyExpiresAt) : null, ts, JSON.stringify(post)],
  });
}
statements.push({ sql: 'DELETE FROM ps_notifications' });
for (const n of db.notifications) {
  statements.push({
    sql: 'INSERT INTO ps_notifications (id, user_id, from_user_id, kind, created_at, seen_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [n.id, n.userId || '', n.fromUserId || null, n.kind || null, Number(n.createdAt || 0), n.seenAt ? Number(n.seenAt) : null, ts, JSON.stringify(n)],
  });
}
statements.push({ sql: 'DELETE FROM ps_messages' });
for (const m of db.messages) {
  statements.push({
    sql: 'INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, disappear_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [m.id, m.roomId || 'general-group', m.userId || '', Number(m.createdAt || 0), m.deletedAt ? Number(m.deletedAt) : null, m.disappearAt ? Number(m.disappearAt) : null, ts, JSON.stringify(m)],
  });
}

const dmIndex = new Map();
for (const m of db.messages) {
  if (!m || m.deletedAt || typeof m.roomId !== 'string' || !m.roomId.startsWith('dm:')) continue;
  const parts = m.roomId.slice(3).split(':').filter(Boolean);
  if (parts.length !== 2) continue;
  for (const ownerId of parts) {
    const peerId = parts.find(id => id !== ownerId);
    if (!peerId) continue;
    const key = `${ownerId}|${peerId}`;
    const prev = dmIndex.get(key);
    if (prev && Number(prev.createdAt || 0) >= Number(m.createdAt || 0)) continue;
    let preview;
    if (m.encrypted) preview = '🔒 Encrypted message';
    else if (m.storyReply) preview = 'Replied to a story';
    else if (m.imageUrl) preview = '📷 Photo';
    else preview = String(m.text || '').slice(0, 60);
    dmIndex.set(key, { ownerUserId: ownerId, peerUserId: peerId, roomId: m.roomId, messageId: m.id, createdAt: Number(m.createdAt || 0), fromMe: m.userId === ownerId, text: preview });
  }
}
statements.push({ sql: 'DELETE FROM ps_dm_index' });
for (const row of dmIndex.values()) {
  statements.push({
    sql: 'INSERT INTO ps_dm_index (owner_user_id, peer_user_id, room_id, created_at, from_me, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [row.ownerUserId, row.peerUserId, row.roomId, row.createdAt, row.fromMe ? 1 : 0, ts, JSON.stringify(row)],
  });
}

statements.push({ sql: 'DELETE FROM ps_user_feeds' });
const usersById = new Map(db.users.map(u => [u.id, u]));
for (const post of db.posts) {
  if (!post || post.deletedAt || isStoryRecord(post)) continue;
  const author = usersById.get(post.userId);
  const followers = (author && Array.isArray(author.followers)) ? author.followers : [];
  for (const fid of followers) {
    statements.push({
      sql: 'INSERT INTO ps_user_feeds (user_id, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, post_id) DO UPDATE SET created_at = excluded.created_at',
      args: [fid, post.id, Number(post.createdAt || 0)],
    });
  }
}
statements.push({
  sql: 'INSERT INTO ps_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  args: ['neon_replacement_migrated_at', new Date(ts).toISOString(), ts],
});

await batch(turso, statements);
console.log(`[done] Turso is ready as primary. Structured rows: users=${db.users.length}, messages=${db.messages.length}, posts=${db.posts.length}, dmIndex=${dmIndex.size}`);
