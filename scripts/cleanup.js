// Full cleanup: remove wire_* test users + their stale data + clean up follower/following lists.
// SAFETY: requires --yes (default is dry-run). Reads Turso creds from env vars only.
const fs = require('fs');
const { createClient } = require('@libsql/client');

const TURSO = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
if (!TURSO || !TURSO_TOKEN) {
  console.error('Refusing to run: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN env vars are required.');
  console.error('This script is destructive — set both env vars explicitly so you never');
  console.error('accidentally target the wrong database.');
  process.exit(2);
}
const DRY_RUN = !process.argv.includes('--yes');
if (DRY_RUN) console.log('=== DRY RUN MODE — no data will be modified. Re-run with --yes to apply. ===\n');

const BACKUP = `backups/full-cleanup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;

(async () => {
  const c = createClient({ url: TURSO, authToken: TURSO_TOKEN });
  // Step 1: get all users
  const allUsers = await c.execute('SELECT id, username_lower, data_json FROM ps_users');
  const userMap = {};
  for (const r of allUsers.rows) userMap[String(r.id)] = r.username_lower;
  // Find test users
  const testIds = allUsers.rows.filter(r => String(r.username_lower).startsWith('wire_')).map(r => String(r.id));
  const realIds = new Set(allUsers.rows.filter(r => !String(r.username_lower).startsWith('wire_')).map(r => String(r.id)));
  console.log('Test user IDs to remove:', testIds);
  console.log('Real user IDs to keep:', [...realIds]);

  // Step 2: dump full backup (all structured tables + ps_kv blob)
  const backup = { users: [], posts: [], messages: [], notifications: [], dm_index: [], user_feeds: [], events: [], kv: null, deletedTestUsers: testIds };
  for (const t of ['ps_users', 'ps_posts', 'ps_messages', 'ps_notifications', 'ps_dm_index', 'ps_user_feeds', 'ps_events']) {
    try {
      const rs = await c.execute(`SELECT * FROM ${t}`);
      backup[t.replace('ps_','')] = rs.rows.map(r => {
        const o = {};
        for (const k of Object.keys(r)) o[k] = r[k];
        return o;
      });
    } catch (e) { console.warn(`  (skip ${t}: ${e.message})`); }
  }
  try {
    const kv = await c.execute("SELECT value FROM ps_kv WHERE key = 'db'");
    if (kv.rows.length) backup.kv = JSON.parse(String(kv.rows[0].value));
  } catch (_) {}
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));
  console.log('Backup written to', BACKUP);

  if (DRY_RUN) {
    console.log('\n=== DRY RUN COMPLETE — no changes made. Re-run with --yes to apply. ===');
    return;
  }

  // Step 3: wipe test user rows — batched in a single transaction per user so
  // a crash mid-script can't leave orphaned rows.
  for (const id of testIds) {
    await c.batch([
      { sql: 'DELETE FROM ps_users WHERE id = ?', args: [id] },
      { sql: 'DELETE FROM ps_posts WHERE user_id = ?', args: [id] },
      { sql: 'DELETE FROM ps_messages WHERE user_id = ?', args: [id] },
      { sql: 'DELETE FROM ps_notifications WHERE user_id = ? OR from_user_id = ?', args: [id, id] },
      { sql: 'DELETE FROM ps_dm_index WHERE owner_user_id = ? OR peer_user_id = ?', args: [id, id] },
      { sql: 'DELETE FROM ps_user_feeds WHERE user_id = ?', args: [id] },
      { sql: 'DELETE FROM ps_events WHERE user_id = ?', args: [id] },
    ], 'write');
  }
  console.log('Wiped', testIds.length, 'test users');

  // Step 4: clean up ALL dangling social-graph arrays in surviving users.
  // Previously this loop missed `closeFriends`. Now covers all 5 arrays.
  const SOCIAL_ARRAY_FIELDS = ['followers', 'following', 'followedBy', 'blocked', 'closeFriends'];
  const rs = await c.execute('SELECT id, data_json FROM ps_users');
  for (const r of rs.rows) {
    const u = JSON.parse(String(r.data_json));
    let changed = false;
    for (const field of SOCIAL_ARRAY_FIELDS) {
      if (Array.isArray(u[field])) {
        const before = u[field].length;
        u[field] = u[field].filter(id => realIds.has(String(id)));
        if (u[field].length !== before) changed = true;
      }
    }
    if (changed) {
      await c.execute({ sql: 'UPDATE ps_users SET data_json = ?, updated_at = ? WHERE id = ?', args: [JSON.stringify(u), Date.now(), String(r.id)] });
      console.log(`  Cleaned ${r.id.slice(0,15)}: followers=${u.followers?.length||0} following=${u.following?.length||0} blocked=${u.blocked?.length||0} closeFriends=${u.closeFriends?.length||0}`);
    }
  }

  // Step 5: also clean posts that reference missing users (likes by wiped users,
  // comments by wiped users).
  const posts = await c.execute('SELECT id, data_json FROM ps_posts');
  for (const r of posts.rows) {
    const p = JSON.parse(String(r.data_json));
    let changed = false;
    if (Array.isArray(p.likes)) {
      const before = p.likes.length;
      p.likes = p.likes.filter(id => realIds.has(String(id)));
      if (p.likes.length !== before) changed = true;
    }
    if (Array.isArray(p.comments)) {
      const before = p.comments.length;
      p.comments = p.comments.filter(c => !c.userId || realIds.has(String(c.userId)));
      if (p.comments.length !== before) changed = true;
    }
    if (changed) {
      await c.execute({ sql: 'UPDATE ps_posts SET data_json = ?, updated_at = ? WHERE id = ?', args: [JSON.stringify(p), Date.now(), String(r.id)] });
    }
  }

  // Step 6: rebuild ps_kv mirror — include ALL collections (users, posts,
  // messages, notifications) so cf-worker.js reading from ps_kv stays consistent
  // with the structured tables.
  const kv2 = await c.execute("SELECT value FROM ps_kv WHERE key = 'db'");
  if (kv2.rows.length) {
    const db = JSON.parse(String(kv2.rows[0].value));
    db.users = (db.users || []).filter(u => realIds.has(String(u.id)));
    for (const u of db.users) {
      for (const field of SOCIAL_ARRAY_FIELDS) {
        if (Array.isArray(u[field])) u[field] = u[field].filter(id => realIds.has(String(id)));
      }
    }
    db.posts = (db.posts || []).filter(p => realIds.has(String(p.userId))).map(p => {
      if (Array.isArray(p.likes)) p.likes = p.likes.filter(id => realIds.has(String(id)));
      if (Array.isArray(p.comments)) p.comments = p.comments.filter(c => !c.userId || realIds.has(String(c.userId)));
      return p;
    });
    // Previously this script skipped messages + notifications in the ps_kv rebuild,
    // leaving ghost DMs/notifications that cf-worker.js would resurrect from ps_kv.
    db.messages = (db.messages || []).filter(m => realIds.has(String(m.userId)));
    db.notifications = (db.notifications || []).filter(n => realIds.has(String(n.userId)) && realIds.has(String(n.fromUserId)));
    await c.execute({ sql: "UPDATE ps_kv SET value = ?, updated_at = ? WHERE key = 'db'", args: [JSON.stringify(db), Date.now()] });
    console.log('ps_kv mirror cleaned (users + posts + messages + notifications)');
  }
  // Final summary
  const final = await c.execute("SELECT username_lower, id, data_json FROM ps_users");
  console.log('\n=== Final state ===');
  for (const r of final.rows) {
    const d = JSON.parse(r.data_json);
    console.log(`  ${r.username_lower} (${String(r.id).slice(0,15)}): followers=${(d.followers||[]).length} following=${(d.following||[]).length}`);
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
