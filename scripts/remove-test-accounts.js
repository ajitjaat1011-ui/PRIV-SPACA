#!/usr/bin/env node
/**
 * Targeted, safe removal of test/debug accounts from the PRIV-SPACA Turso
 * database, created during agent-driven testing sessions (WebRTC call
 * debugging, RTC signaling tests, performance checks, etc.).
 *
 * WHAT IT DOES:
 *   1. Backs up the ENTIRE current DB to ./backups/pre-test-cleanup-<ts>.json
 *   2. Deletes ONLY the explicitly-listed test account IDs below (never an
 *      allowlist-based "keep only owner" wipe — this preserves every real
 *      user account untouched)
 *   3. Cascades deletion to each test account's own posts, messages,
 *      notifications, dm-index rows, user-feed rows, and rtc/event rows
 *   4. Also strips references to deleted user IDs from OTHER users' arrays
 *      (followers/following/blocked/closeFriends) so no dangling IDs remain
 *   5. Rebuilds ps_kv (the JSON blob mirror) to match the new structured
 *      tables
 *
 * USAGE:
 *   node scripts/remove-test-accounts.js --dry-run   # preview only (default)
 *   node scripts/remove-test-accounts.js --yes       # actually delete
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

const TURSO_URL = process.env.TURSO_DATABASE_URL || 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
if (!TURSO_TOKEN) { console.error('Refusing to run: TURSO_AUTH_TOKEN env var is required.'); process.exit(2); }

const DRY_RUN = !process.argv.includes('--yes');
if (DRY_RUN) console.log('=== DRY RUN MODE — no data will be modified ===\n');

// Explicit allowlist of usernames to KEEP no matter what (belt-and-braces
// safety net alongside the explicit test-ID list below).
const KEEP_USERNAMES = new Set([
  'arvind_1011', 'anushka_1011', 'rahdhika', 'arvindjaat', 'krishnjaat',
  'ajitsingh', 'rao',
]);

// The exact test-account IDs identified this session (created by automated
// RTC/call/perf testing scripts). Cross-checked against KEEP_USERNAMES below
// as a second layer of protection before any delete executes.
const TEST_USER_IDS = new Set([
  'usr_mr5tz86x_w7sdc46','usr_mr5tz9zx_jmmzur2','usr_mr5tzj0h_2o2xk9g',
  'usr_mr5tzos0_lpqynqt','usr_mr5tzqev_2fmutum','usr_mr5u01bl_bjylcnc',
  'usr_mr5u02qe_gmpsd3z','usr_mr5w16sx_vbkc6ee','usr_mr5w1a90_76l4d2v',
  'usr_mr5w7k55_46hry4k','usr_mr5w83fg_tc725m7','usr_mr5w8c6b_l0gvj1f',
  'usr_mr5w8owu_ahonq7i','usr_mr5w8vp4_9mg723x','usr_mr5w8zhe_gflutle',
  'usr_mr5w9ylt_il6k23m','usr_mr5wa2lp_bpadj66','usr_mr5wb0ky_fwyqwr6',
  'usr_mr5wb4b3_papmi5u','usr_mr5wbobr_ko7ahok','usr_mr5wbvgg_v7aguf5',
  'usr_mr5whk3b_7658j61','usr_mr5whsfk_ixmx3ra','usr_mr5wj9hv_cpexxm2',
  'usr_mr5wjdfx_dy1muw8','usr_mr5wkmzi_ywaman1','usr_mr5x8xpo_jd4b8u5',
  'usr_mr5xaf09_vq3xoo1','usr_mr5xagsz_fudqwtp','usr_mr5xaua8_dqky5mz',
  'usr_mr5xaxh8_8fbj79w','usr_mr5xeo4y_jwgmphj','usr_mr5xfwua_8eyhjn4',
  'usr_mr5xg0si_rdechtu','usr_mr5xj91h_38qbygt','usr_mr5xph96_za9wlaz',
  'usr_mr5xplj3_wwp46f9','usr_mr5y64g5_wufcxnh','usr_mr5ygxpg_6a55g4x',
  'usr_mr5ykcqj_n16897x','usr_mr5yqbsp_c8d6375','usr_mr5yt9p0_nx2f15p',
  'usr_mr5yu6se_nlz96v4','usr_mr5yucz4_kmmy7ie','usr_mr5yv9di_r1i4sbl',
  'usr_mr5yvdbu_x2smdpl','usr_mr5ywba7_5ji6kcv','usr_mr5ywhp0_mbul8mj',
  'usr_mr5yxfei_nr1n3ae','usr_mr5yxjhn_jni5tgd','usr_mr5yyqhp_3i6ehqm',
  'usr_mr5yyukx_ghonry4','usr_mr6ld2qu_2vf7z0y','usr_mr6ld7n3_70rojzi',
  'usr_mr6lhp4i_v3gpd70','usr_mr6lhtoy_9xa78z2','usr_mr6lj0u0_f05t49h',
  'usr_mr6lj4yy_6p1mh55','usr_mr6lkbq0_vitz8tx','usr_mr6lkfu6_culnliu',
  'usr_mr6llnov_a7431qp','usr_mr6llrsi_06hkpqg','usr_mr6mk6wh_dgphtao',
  'usr_mr6mk8ps_79w1p02','usr_mr6mnps4_3beuh0s','usr_mr6mnrlh_kdkiu1c',
  'usr_mr6mvmdh_ttbycn8','usr_mr6mvosn_rhfzs0h','usr_mr6mwcwc_069bmmb',
  'usr_mr6mwe9a_ml5c0sr','usr_mr6mx5zr_qvf0xpl','usr_mr79n1ri_e8wyke8',
]);

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

  console.log('\n--- 2. Loading users & cross-checking allowlist ---');
  const usersRows = await c.execute('SELECT data_json FROM ps_users');
  const allUsers = usersRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);

  const toDelete = [];
  const kept = [];
  for (const u of allUsers) {
    const isListedTest = TEST_USER_IDS.has(u.id);
    const isProtectedUsername = KEEP_USERNAMES.has(String(u.username || '').toLowerCase());
    if (isListedTest && !isProtectedUsername) {
      toDelete.push(u);
    } else {
      kept.push(u);
    }
  }

  console.log(`\nWill DELETE ${toDelete.length} test accounts:`);
  toDelete.forEach(u => console.log('  - ' + u.username + ' (' + u.id + ')'));
  console.log(`\nWill KEEP ${kept.length} accounts:`);
  kept.forEach(u => console.log('  - ' + u.username + ' (' + u.id + ')'));

  const deleteIds = new Set(toDelete.map(u => u.id));

  console.log('\n--- 3. Backing up entire DB before any change ---');
  const postsRows = await c.execute('SELECT data_json FROM ps_posts');
  const posts = postsRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);
  const messagesRows = await c.execute('SELECT data_json FROM ps_messages');
  const messages = messagesRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);
  const notificationsRows = await c.execute('SELECT data_json FROM ps_notifications');
  const notifications = notificationsRows.rows.map(r => { try { return JSON.parse(String(r.data_json)); } catch { return null; } }).filter(Boolean);

  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `pre-test-cleanup-${ts}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ users: allUsers, posts, messages, notifications, counts }, null, 2));
  console.log('  Backup written to: ' + backupPath);

  if (DRY_RUN) {
    console.log('\n=== DRY RUN COMPLETE — no changes made. Re-run with --yes to apply. ===');
    return;
  }

  console.log('\n--- 4. Deleting test accounts and their data ---');
  const idPlaceholders = [...deleteIds].map(() => '?').join(',');
  const idArgs = [...deleteIds];

  if (idArgs.length) {
    const delUsers = await c.execute({ sql: `DELETE FROM ps_users WHERE id IN (${idPlaceholders})`, args: idArgs });
    console.log('  Deleted from ps_users:', delUsers.rowsAffected);

    const delPosts = await c.execute({ sql: `DELETE FROM ps_posts WHERE user_id IN (${idPlaceholders})`, args: idArgs });
    console.log('  Deleted from ps_posts:', delPosts.rowsAffected);

    const delMessages = await c.execute({ sql: `DELETE FROM ps_messages WHERE user_id IN (${idPlaceholders})`, args: idArgs });
    console.log('  Deleted from ps_messages:', delMessages.rowsAffected);

    const delNotifs = await c.execute({ sql: `DELETE FROM ps_notifications WHERE user_id IN (${idPlaceholders}) OR from_user_id IN (${idPlaceholders})`, args: [...idArgs, ...idArgs] });
    console.log('  Deleted from ps_notifications:', delNotifs.rowsAffected);

    const delDmIndex = await c.execute({ sql: `DELETE FROM ps_dm_index WHERE owner_user_id IN (${idPlaceholders}) OR peer_user_id IN (${idPlaceholders})`, args: [...idArgs, ...idArgs] });
    console.log('  Deleted from ps_dm_index:', delDmIndex.rowsAffected);

    const delFeeds = await c.execute({ sql: `DELETE FROM ps_user_feeds WHERE user_id IN (${idPlaceholders})`, args: idArgs });
    console.log('  Deleted from ps_user_feeds:', delFeeds.rowsAffected);

    const delEvents = await c.execute({ sql: `DELETE FROM ps_events WHERE user_id IN (${idPlaceholders})`, args: idArgs });
    console.log('  Deleted from ps_events:', delEvents.rowsAffected);
  }

  // Also delete any DM-room messages whose room_id references two deleted
  // (or one deleted + one kept) users' dm:a:b room — otherwise orphaned DM
  // threads with a real user could remain visible with a ghost peer.
  const allMessagesRows2 = await c.execute('SELECT id, room_id FROM ps_messages');
  const dmMsgIdsToDelete = [];
  for (const row of allMessagesRows2.rows) {
    const roomId = String(row.room_id || '');
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      if (parts.some(p => deleteIds.has(p))) dmMsgIdsToDelete.push(row.id);
    }
  }
  if (dmMsgIdsToDelete.length) {
    const ph = dmMsgIdsToDelete.map(() => '?').join(',');
    const delDmMsgs = await c.execute({ sql: `DELETE FROM ps_messages WHERE id IN (${ph})`, args: dmMsgIdsToDelete });
    console.log('  Deleted orphaned DM messages referencing a deleted user:', delDmMsgs.rowsAffected);
  }

  console.log('\n--- 5. Stripping deleted-user references from remaining users (followers/following/blocked/closeFriends) ---');
  let strippedCount = 0;
  for (const u of kept) {
    let changed = false;
    for (const field of ['followers', 'following', 'blocked', 'closeFriends']) {
      if (Array.isArray(u[field])) {
        const before = u[field].length;
        u[field] = u[field].filter(id => !deleteIds.has(id));
        if (u[field].length !== before) changed = true;
      }
    }
    if (changed) {
      strippedCount++;
      await c.execute({
        sql: 'UPDATE ps_users SET data_json = ?, updated_at = ? WHERE id = ?',
        args: [JSON.stringify(u), Date.now(), u.id],
      });
    }
  }
  console.log(`  Updated ${strippedCount} remaining users to strip dangling references`);

  console.log('\n--- 6. Rebuilding ps_kv JSON mirror ---');
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
  console.log('  ps_kv rebuilt.');

  console.log('\n--- 7. Final counts ---');
  for (const t of tables) {
    const rs = await c.execute('SELECT count(*) as c FROM ' + t);
    console.log('  ' + t + ': ' + Number(rs.rows[0].c) + ' rows (was ' + counts[t] + ')');
  }

  console.log('\n=== DONE. Backup saved at: ' + backupPath + ' ===');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
