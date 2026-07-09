#!/usr/bin/env node
/**
 * Final cleanup pass: removes the handful of extra test accounts created
 * DURING the performance-optimization/testing work itself (after the main
 * remove-test-accounts.js cleanup already ran). Same safety model: explicit
 * ID list + username cross-check + backup before delete.
 *
 * USAGE:
 *   node scripts/remove-final-test-accounts.js --dry-run
 *   node scripts/remove-final-test-accounts.js --yes
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const TURSO_URL = process.env.TURSO_DATABASE_URL || 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
if (!TURSO_TOKEN) { console.error('Refusing to run: TURSO_AUTH_TOKEN env var is required.'); process.exit(2); }

const DRY_RUN = !process.argv.includes('--yes');
if (DRY_RUN) console.log('=== DRY RUN MODE — no data will be modified ===\n');

const KEEP_USERNAMES = new Set([
  'arvind_1011', 'anushka_1011', 'rahdhika', 'arvindjaat', 'krishnjaat',
  'ajitsingh', 'rao',
]);

const TEST_USER_IDS = new Set([
  'usr_mr79w5xn_nu4o217', // postcleanupchk2
]);

async function main() {
  const c = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

  const usersRows = await c.execute('SELECT data_json FROM ps_users');
  const allUsers = usersRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);

  const toDelete = [];
  const kept = [];
  for (const u of allUsers) {
    const isListedTest = TEST_USER_IDS.has(u.id);
    const isProtectedUsername = KEEP_USERNAMES.has(String(u.username || '').toLowerCase());
    if (isListedTest && !isProtectedUsername) toDelete.push(u); else kept.push(u);
  }

  console.log(`Will DELETE ${toDelete.length}:`, toDelete.map(u => u.username));
  console.log(`Will KEEP ${kept.length}:`, kept.map(u => u.username));

  const deleteIds = new Set(toDelete.map(u => u.id));

  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `pre-final-test-cleanup-${ts}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ users: allUsers }, null, 2));
  console.log('Backup written to: ' + backupPath);

  if (DRY_RUN) { console.log('\n=== DRY RUN COMPLETE ==='); return; }
  if (!deleteIds.size) { console.log('Nothing to delete.'); return; }

  const idPlaceholders = [...deleteIds].map(() => '?').join(',');
  const idArgs = [...deleteIds];

  const delUsers = await c.execute({ sql: `DELETE FROM ps_users WHERE id IN (${idPlaceholders})`, args: idArgs });
  console.log('Deleted from ps_users:', delUsers.rowsAffected);
  const delPosts = await c.execute({ sql: `DELETE FROM ps_posts WHERE user_id IN (${idPlaceholders})`, args: idArgs });
  console.log('Deleted from ps_posts:', delPosts.rowsAffected);
  const delMessages = await c.execute({ sql: `DELETE FROM ps_messages WHERE user_id IN (${idPlaceholders})`, args: idArgs });
  console.log('Deleted from ps_messages:', delMessages.rowsAffected);
  const delNotifs = await c.execute({ sql: `DELETE FROM ps_notifications WHERE user_id IN (${idPlaceholders}) OR from_user_id IN (${idPlaceholders})`, args: [...idArgs, ...idArgs] });
  console.log('Deleted from ps_notifications:', delNotifs.rowsAffected);
  const delDmIndex = await c.execute({ sql: `DELETE FROM ps_dm_index WHERE owner_user_id IN (${idPlaceholders}) OR peer_user_id IN (${idPlaceholders})`, args: [...idArgs, ...idArgs] });
  console.log('Deleted from ps_dm_index:', delDmIndex.rowsAffected);
  const delFeeds = await c.execute({ sql: `DELETE FROM ps_user_feeds WHERE user_id IN (${idPlaceholders})`, args: idArgs });
  console.log('Deleted from ps_user_feeds:', delFeeds.rowsAffected);
  const delEvents = await c.execute({ sql: `DELETE FROM ps_events WHERE user_id IN (${idPlaceholders})`, args: idArgs });
  console.log('Deleted from ps_events:', delEvents.rowsAffected);

  // Rebuild ps_kv mirror
  const kvRow = await c.execute({ sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
  let dbBlob = {};
  try { dbBlob = JSON.parse(String((kvRow.rows[0] && kvRow.rows[0].value) || '{}')); } catch { dbBlob = {}; }
  dbBlob.users = kept;
  dbBlob.posts = (dbBlob.posts || []).filter(p => !deleteIds.has(p.userId));
  dbBlob.messages = (dbBlob.messages || []).filter(m => !deleteIds.has(m.userId));
  dbBlob.notifications = (dbBlob.notifications || []).filter(n => !deleteIds.has(n.userId) && !deleteIds.has(n.fromUserId));
  await c.execute({
    sql: `INSERT INTO ps_kv (key, value, version, updated_at) VALUES ('db', ?, 1, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = ps_kv.version + 1, updated_at = excluded.updated_at`,
    args: [JSON.stringify(dbBlob), Date.now()],
  });
  console.log('ps_kv rebuilt.');
  console.log('\n=== DONE ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
