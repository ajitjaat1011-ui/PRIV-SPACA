#!/usr/bin/env node
/**
 * Destructive wipe of the PRIV-SPACA Turso database.
 *
 * WHAT IT DOES:
 *   1. Backs up the ENTIRE current DB to ./backups/db-wipe-<timestamp>.json
 *   2. Deletes all non-owner users (preserves user id 'usr_admin_arvind_1011'
 *      and any user whose username_lower is 'arvindjaat1011' or email matches
 *      ajitjaat1011@gmail.com / arvindjaat1011@gmail.com)
 *   3. Deletes all posts, messages, notifications, DM-index, user-feeds,
 *      and any other data that belongs to non-owner users
 *   4. Rebuilds ps_kv (the JSON blob) to reflect the new state with only
 *      the owner and their data
 *
 * USAGE:
 *   node scripts/backup-and-wipe.js --dry-run   # preview only, no changes
 *   node scripts/backup-and-wipe.js --yes       # actually wipe
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const TURSO_URL = 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
if (!TURSO_TOKEN) { console.error('Refusing to run: TURSO_AUTH_TOKEN env var is required.'); process.exit(2); }

const DRY_RUN = !process.argv.includes('--yes');
if (DRY_RUN) console.log('=== DRY RUN MODE — no data will be modified ===\n');

const OWNER_IDS = new Set(['usr_admin_arvind_1011']);
const OWNER_USERNAMES = new Set(['arvindjaat1011']);
const OWNER_EMAILS = new Set([
  'ajitjaat1011@gmail.com',
  'arvindjaat1011@gmail.com',
]);

function isOwner(user) {
  if (!user) return false;
  if (OWNER_IDS.has(user.id)) return true;
  if (OWNER_USERNAMES.has(String(user.username || '').toLowerCase())) return true;
  if (OWNER_EMAILS.has(String(user.email || '').toLowerCase())) return true;
  return false;
}

async function main() {
  const c = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  console.log('--- 1. Reading current state ---');
  const tables = ['ps_users', 'ps_posts', 'ps_messages', 'ps_notifications',
                  'ps_dm_index', 'ps_user_feeds', 'ps_events'];
  const counts = {};
  for (const t of tables) {
    const rs = await c.execute('SELECT count(*) as c FROM ' + t);
    counts[t] = Number(rs.rows[0].c);
    console.log('  ' + t + ': ' + counts[t] + ' rows');
  }

  console.log('\n--- 2. Loading full data for backup ---');
  const usersRows = await c.execute('SELECT data_json FROM ps_users');
  const users = usersRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);
  const postsRows = await c.execute('SELECT data_json FROM ps_posts');
  const posts = postsRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);
  const msgsRows = await c.execute('SELECT data_json FROM ps_messages');
  const messages = msgsRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);
  const notifsRows = await c.execute('SELECT data_json FROM ps_notifications');
  const notifications = notifsRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);
  console.log('  loaded: ' + users.length + ' users, ' + posts.length + ' posts, ' + messages.length + ' messages, ' + notifications.length + ' notifications');

  const owner = users.find(isOwner);
  if (!owner) {
    console.log('\n  NO OWNER FOUND in ps_users! Aborting to be safe.');
    console.log('  Looking for username_lower in:', Array.from(OWNER_USERNAMES));
    console.log('  Or email_lower in:', Array.from(OWNER_EMAILS));
    process.exit(1);
  }
  console.log('  Owner found: ' + owner.username + ' (' + owner.email + ') id=' + owner.id);
  OWNER_IDS.add(owner.id);

  const nonOwnerIds = users.filter(u => !isOwner(u)).map(u => u.id);
  const nonOwnerUserIdSet = new Set(nonOwnerIds);
  console.log('  Non-owner users to delete: ' + nonOwnerIds.length);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, 'db-wipe-' + ts + '.json');
  const backup = {
    timestamp: ts,
    mode: DRY_RUN ? 'dry-run' : 'wipe',
    counts,
    owner: { id: owner.id, username: owner.username, email: owner.email },
    nonOwnerUserIds: nonOwnerIds,
    users, posts, messages, notifications,
  };
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log('  Backup written: ' + backupFile + ' (' + (fs.statSync(backupFile).size / 1024).toFixed(1) + ' KB)');

  console.log('\n--- 3. Deleting non-owner data ---');
  if (DRY_RUN) {
    console.log('  [DRY RUN] Would execute the following DELETE statements:');
    console.log('    DELETE FROM ps_users WHERE id NOT IN (owner_ids)  -- ' + (users.length - 1) + ' rows');
    console.log('    DELETE FROM ps_posts WHERE user_id IN (non_owner_ids)  -- ~' + posts.filter(p => nonOwnerUserIdSet.has(p.userId)).length + ' rows');
    console.log('    DELETE FROM ps_messages WHERE user_id IN (non_owner_ids)  -- ~' + messages.filter(m => nonOwnerUserIdSet.has(m.userId)).length + ' rows');
    console.log('    DELETE FROM ps_notifications WHERE user_id IN (non_owner_ids) OR from_user_id IN (non_owner_ids)  -- ~' + notifications.filter(n => nonOwnerUserIdSet.has(n.userId) || nonOwnerUserIdSet.has(n.fromUserId)).length + ' rows');
    console.log('    DELETE FROM ps_dm_index WHERE owner_user_id IN (non_owner_ids) OR peer_user_id IN (non_owner_ids)');
    console.log('    DELETE FROM ps_user_feeds WHERE user_id IN (non_owner_ids)');
    console.log('    DELETE FROM ps_events WHERE user_id IN (non_owner_ids)');
    console.log('    UPSERT ps_kv with new JSON containing only owner');
  } else {
    const ownerIdList = Array.from(OWNER_IDS);
    const placeholders = ownerIdList.map(() => '?').join(',');
    const r1 = await c.execute({ sql: 'DELETE FROM ps_users WHERE id NOT IN (' + placeholders + ')', args: ownerIdList });
    console.log('  ps_users: ' + Number(r1.rowsAffected || 0) + ' rows deleted');

    const nonOwnerPh = Array.from(nonOwnerUserIdSet).map(() => '?').join(',');
    if (nonOwnerUserIdSet.size > 0) {
      const nonOwnerArr = Array.from(nonOwnerUserIdSet);
      const r2 = await c.execute({ sql: 'DELETE FROM ps_posts WHERE user_id IN (' + nonOwnerPh + ')', args: nonOwnerArr });
      console.log('  ps_posts: ' + Number(r2.rowsAffected || 0) + ' rows deleted');
      const r3 = await c.execute({ sql: 'DELETE FROM ps_messages WHERE user_id IN (' + nonOwnerPh + ')', args: nonOwnerArr });
      console.log('  ps_messages: ' + Number(r3.rowsAffected || 0) + ' rows deleted');
      const r4 = await c.execute({ sql: 'DELETE FROM ps_notifications WHERE user_id IN (' + nonOwnerPh + ') OR from_user_id IN (' + nonOwnerPh + ')', args: [...nonOwnerArr, ...nonOwnerArr] });
      console.log('  ps_notifications: ' + Number(r4.rowsAffected || 0) + ' rows deleted');
      const r5 = await c.execute({ sql: 'DELETE FROM ps_dm_index WHERE owner_user_id IN (' + nonOwnerPh + ') OR peer_user_id IN (' + nonOwnerPh + ')', args: [...nonOwnerArr, ...nonOwnerArr] });
      console.log('  ps_dm_index: ' + Number(r5.rowsAffected || 0) + ' rows deleted');
      const r6 = await c.execute({ sql: 'DELETE FROM ps_user_feeds WHERE user_id IN (' + nonOwnerPh + ')', args: nonOwnerArr });
      console.log('  ps_user_feeds: ' + Number(r6.rowsAffected || 0) + ' rows deleted');
      const r7 = await c.execute({ sql: 'DELETE FROM ps_events WHERE user_id IN (' + nonOwnerPh + ')', args: nonOwnerArr });
      console.log('  ps_events: ' + Number(r7.rowsAffected || 0) + ' rows deleted');
    }
  }

  console.log('\n--- 4. Rebuilding ps_kv ---');
  if (DRY_RUN) {
    const ownerPosts = posts.filter(p => p.userId === owner.id);
    const ownerMessages = messages.filter(m => m.userId === owner.id);
    const ownerNotifs = notifications.filter(n => n.userId === owner.id);
    console.log('  [DRY RUN] Would rebuild ps_kv with:');
    console.log('    users: 1 (just the owner)');
    console.log('    posts: ' + ownerPosts.length);
    console.log('    messages: ' + ownerMessages.length);
    console.log('    notifications: ' + ownerNotifs.length);
  } else {
    const ownerPosts = posts.filter(p => p.userId === owner.id);
    const ownerMessages = messages.filter(m => m.userId === owner.id);
    const ownerNotifs = notifications.filter(n => n.userId === owner.id);
    const newDb = {
      users: [owner],
      posts: ownerPosts,
      messages: ownerMessages,
      scheduledMessages: [],
      notifications: ownerNotifs,
      typing: {},
      heartbeat: {},
      rtcSignals: [],
      meta: { storage: 'turso-json-v1', wipedAt: Date.now(), wipedBy: 'agent-wipe-script' },
    };
    const ts2 = Date.now();
    await c.execute({
      sql: "INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = ps_kv.version + 1, updated_at = excluded.updated_at",
      args: ['db', JSON.stringify(newDb), ts2],
    });
    console.log('  ps_kv: 1 row updated (version bumped)');
  }

  console.log('\n--- 5. Verifying ---');
  for (const t of ['ps_users', 'ps_posts', 'ps_messages', 'ps_notifications', 'ps_dm_index', 'ps_user_feeds', 'ps_events']) {
    const rs = await c.execute('SELECT count(*) as c FROM ' + t);
    console.log('  ' + t + ': ' + Number(rs.rows[0].c) + ' rows');
  }
  if (!DRY_RUN) {
    const finalUsers = await c.execute('SELECT username_lower, email_lower FROM ps_users');
    console.log('\n  Remaining users:');
    for (const r of finalUsers.rows) {
      console.log('    ' + r.username_lower + ' (' + r.email_lower + ')');
    }
  }

  console.log('\n=== ' + (DRY_RUN ? 'DRY RUN complete' : 'WIPE complete') + ' ===');
  console.log('Backup: ' + backupFile);
  if (DRY_RUN) console.log('To actually wipe, run: node scripts/backup-and-wipe.js --yes');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
