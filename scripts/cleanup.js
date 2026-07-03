// Full cleanup: remove wire_* test users + their stale data + clean up follower/following lists
const { createClient } = require('@libsql/client');
const TURSO = 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODMwMDIwNDUsImlkIjoiMDE5ZjIzMzMtZWYwMS03MDZjLTliMjgtMzAxN2JkNGRiMzg0Iiwia2lkIjoienVDWHBCUlUtOU1paW1aOW45NlhYRUJyRzdUU0U3Y1JJWG4zbE5rQUxzWSIsInJpZCI6ImZhZWI5ODQ1LWFmY2YtNDBkNy05MTQ3LTQxYmQ0ZTNjOThhOCJ9.QC4XCoH8yfu0br39fhLbuCZcQQP4O2k0-QLnenGrCj8otlasu30W3kkHLWMXPBvYkupbrVxGpBfH1TLroVwmDA';
const fs = require('fs');
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

  // Step 2: dump full backup
  const backup = { users: [], posts: [], messages: [], notifications: [], dm_index: [], kv: null, deletedTestUsers: testIds };
  for (const t of ['ps_users', 'ps_posts', 'ps_messages', 'ps_notifications', 'ps_dm_index']) {
    const rs = await c.execute(`SELECT * FROM ${t}`);
    backup[t.replace('ps_','')] = rs.rows.map(r => {
      const o = {};
      for (const k of Object.keys(r)) o[k] = r[k];
      return o;
    });
  }
  const kv = await c.execute("SELECT value FROM ps_kv WHERE key = 'db'");
  if (kv.rows.length) backup.kv = JSON.parse(String(kv.rows[0].value));
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));
  console.log('Backup written to', BACKUP);

  // Step 3: wipe test user rows
  for (const id of testIds) {
    await c.execute({ sql: 'DELETE FROM ps_users WHERE id = ?', args: [id] });
    await c.execute({ sql: 'DELETE FROM ps_posts WHERE user_id = ?', args: [id] });
    await c.execute({ sql: 'DELETE FROM ps_messages WHERE user_id = ?', args: [id] });
    await c.execute({ sql: 'DELETE FROM ps_notifications WHERE user_id = ? OR from_user_id = ?', args: [id, id] });
    await c.execute({ sql: 'DELETE FROM ps_dm_index WHERE owner_user_id = ? OR peer_user_id = ?', args: [id, id] });
    await c.execute({ sql: 'DELETE FROM ps_events WHERE user_id = ?', args: [id] });
  }
  console.log('Wiped', testIds.length, 'test users');

  // Step 4: clean up stale follower/following/blocked IDs in the surviving users
  // This is the critical fix — drop any ID that no longer exists
  const rs = await c.execute('SELECT id, data_json FROM ps_users');
  for (const r of rs.rows) {
    const u = JSON.parse(String(r.data_json));
    let changed = false;
    if (Array.isArray(u.followers)) {
      const before = u.followers.length;
      u.followers = u.followers.filter(id => realIds.has(String(id)));
      if (u.followers.length !== before) changed = true;
    }
    if (Array.isArray(u.following)) {
      const before = u.following.length;
      u.following = u.following.filter(id => realIds.has(String(id)));
      if (u.following.length !== before) changed = true;
    }
    if (Array.isArray(u.followedBy)) {
      const before = u.followedBy.length;
      u.followedBy = u.followedBy.filter(id => realIds.has(String(id)));
      if (u.followedBy.length !== before) changed = true;
    }
    if (Array.isArray(u.blocked)) {
      const before = u.blocked.length;
      u.blocked = u.blocked.filter(id => realIds.has(String(id)));
      if (u.blocked.length !== before) changed = true;
    }
    if (changed) {
      await c.execute({ sql: 'UPDATE ps_users SET data_json = ? WHERE id = ?', args: [JSON.stringify(u), String(r.id)] });
      console.log(`  Cleaned ${r.id.slice(0,15)}: followers=${u.followers.length} following=${u.following.length} blocked=${(u.blocked||[]).length}`);
    }
  }

  // Step 5: also clean posts that reference missing users (e.g. likes by wiped users)
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
      await c.execute({ sql: 'UPDATE ps_posts SET data_json = ? WHERE id = ?', args: [JSON.stringify(p), String(r.id)] });
      console.log(`  Cleaned post ${String(r.id).slice(0,15)}: likes=${p.likes.length} comments=${p.comments.length}`);
    }
  }

  // Step 6: also rebuild ps_kv mirror
  const kv2 = await c.execute("SELECT value FROM ps_kv WHERE key = 'db'");
  if (kv2.rows.length) {
    const db = JSON.parse(String(kv2.rows[0].value));
    db.users = (db.users || []).filter(u => realIds.has(String(u.id)));
    for (const u of db.users) {
      if (Array.isArray(u.followers)) u.followers = u.followers.filter(id => realIds.has(String(id)));
      if (Array.isArray(u.following)) u.following = u.following.filter(id => realIds.has(String(id)));
      if (Array.isArray(u.blocked)) u.blocked = u.blocked.filter(id => realIds.has(String(id)));
    }
    db.posts = (db.posts || []).map(p => {
      if (Array.isArray(p.likes)) p.likes = p.likes.filter(id => realIds.has(String(id)));
      if (Array.isArray(p.comments)) p.comments = p.comments.filter(c => !c.userId || realIds.has(String(c.userId)));
      return p;
    });
    await c.execute({ sql: "UPDATE ps_kv SET value = ?, updated_at = ? WHERE key = 'db'", args: [JSON.stringify(db), Date.now()] });
    console.log('ps_kv mirror cleaned');
  }
  // Final summary
  const final = await c.execute("SELECT username_lower, id, data_json FROM ps_users");
  console.log('\n=== Final state ===');
  for (const r of final.rows) {
    const d = JSON.parse(r.data_json);
    console.log(`  ${r.username_lower} (${String(r.id).slice(0,15)}): followers=${(d.followers||[]).length} following=${(d.following||[]).length}`);
  }
})();
