/**
 * PRIV SPACA — Routes — notifications
 *
 * Notification counts and read state.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { fetchDatabase, saveDatabase } from '../lib/db.js';
import { wrapUnexpected } from '../lib/errors.js';
import { nowMs, sanitizeUser } from '../lib/helpers.js';
import { requireAuth } from '../lib/middleware.js';
import { fetchTursoNotifications, isTursoConfigured, tursoClearNotificationsForUser, tursoUpsertNotifications } from '../lib/store-turso.js';

// ---------- Notifications ----------
app.get('/api/notifications', requireAuth, async (c) => {
  const myId = c.get('userId');
  // perf: same independent-round-trips pattern as /api/messages — run the
  // db fetch and the Turso notifications fetch concurrently instead of
  // sequentially since neither depends on the other's result.
  const [db, tursoNotifs] = await Promise.all([
    fetchDatabase(),
    isTursoConfigured() ? fetchTursoNotifications(myId) : Promise.resolve(null),
  ]);
  const sourceUsers = db.users || [];
  const mine = isTursoConfigured()
    ? tursoNotifs
    : (db.notifications || []).filter(n => n.userId === myId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  const enriched = mine.map(n => {
    const author = sourceUsers.find(u => u.id === n.fromUserId);
    return { ...n, from: author ? sanitizeUser(author) : (n.fromSnapshot || { id: n.fromUserId, displayName: 'Member', username: 'member' }) };
  });
  return c.json({ notifications: enriched, unread: enriched.filter(n => !n.seenAt).length });
});

app.post('/api/notifications/seen', requireAuth, async (c) => {
  try {
  const db = await fetchDatabase();
  const now = nowMs();
  let n = 0;
  const touched = [];
  (db.notifications || []).forEach(x => {
    if (x.userId === c.get('userId') && !x.seenAt) {
      x.seenAt = now; n++; touched.push(x);
    }
  });
  if (n) {
    await saveDatabase(db, true);
    if (isTursoConfigured()) await tursoUpsertNotifications(touched);
  }
  return c.json({ ok: true, updated: n });
  } catch (e) { throw wrapUnexpected(e); }
});

app.post('/api/notifications/clear', requireAuth, async (c) => {
  try {
  const db = await fetchDatabase();
  const before = (db.notifications || []).length;
  db.notifications = (db.notifications || []).filter(n => n.userId !== c.get('userId'));
  if (before !== db.notifications.length) {
    await saveDatabase(db, false, { skipSecondarySync: true });
    if (isTursoConfigured()) await tursoClearNotificationsForUser(c.get('userId'));
  }
  return c.json({ ok: true, removed: before - db.notifications.length });
  } catch (e) { throw wrapUnexpected(e); }
});
