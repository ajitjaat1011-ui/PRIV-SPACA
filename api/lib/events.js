/**
 * PRIV SPACA — Library — events
 *
 * In-memory pub/sub feeding SSE + notification fan-out.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { nowMs, uid } from './helpers.js';
import { sendWebPush } from './push.js';
import { isTursoPrimary, tursoClient, tursoEnsure } from './store-turso.js';
import { getOmniContext, supervisedTask } from './omni-engine.js';

// ---------- Real-time events (in-memory; SSE per-request) ----------
// Note: In Cloudflare Workers, each isolate has its own memory and is ephemeral,
// so module-level Maps don't accumulate indefinitely like in long-lived Node.js.
// Bug #9 addressed in index.js for Node environments. Here, queue limits suffice.
export const _eventQueues = new Map();

export const _eventSubscribers = new Map();

// `opts.persist === false` keeps the event in-memory / SSE only and skips the
// ps_events row. Used by POST /api/rtc/signal, which writes its OWN canonical
// row: writing both produced TWO ps_events rows for the same WebRTC signal in
// two different shapes (envelope `{id,ts,kind,data}` vs flat
// `{id,createdAt,fromId,author,signal}`). GET /api/rtc/signals spread whichever
// row it read, so the envelope row reached the client as `{id,createdAt,ts,
// kind,data}` with NO top-level `signal`. handleRTCSignal() bails on that, and
// the client had already advanced its `since` watermark past it — so the flat
// sibling row (written with an equal/earlier timestamp) was then filtered out
// by `created_at > since` and the offer was lost forever. Net effect: the
// caller saw "Calling…" but the callee never got the incoming-call popup.
export function _pushEvent(userId, kind, data, opts = {}) {
  if (!userId) return;
  const correlationId = getOmniContext()?.correlationId || null;
  const evt = { id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), ts: Date.now(), kind, data, correlationId };
  if (!_eventQueues.has(userId)) _eventQueues.set(userId, []);
  const q = _eventQueues.get(userId);
  q.push(evt);
  if (q.length > 200) q.splice(0, q.length - 200);
  const subs = _eventSubscribers.get(userId);
  if (subs) for (const sub of subs) {
    if (sub.closed) continue;
    try { sub.write(`id: ${evt.id}\nevent: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`); }
    catch (_) { sub.closed = true; }
  }
  if (opts.persist === false) return evt;
  if (isTursoPrimary()) {
    supervisedTask(null, tursoEnsure().then(() => tursoClient().execute({
      sql: 'INSERT INTO ps_events (id, user_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      args: [evt.id, userId, kind, JSON.stringify(evt), evt.ts],
    })), `event.persist.${kind}`);
  } // Neon events path removed
  return evt;
}

export function _broadcastEvent(kind, data, excludeUserId) {
  for (const userId of new Set([..._eventSubscribers.keys(), ..._eventQueues.keys()])) {
    if (userId === excludeUserId) continue;
    _pushEvent(userId, kind, data);
  }
  if (isTursoPrimary()) {
    _pushEvent('__ALL__', kind, data);
  }
}

// ---------- Notifications + Web Push ----------
export function pushNotification(db, recipientId, kind, fromUserId, extra = {}) {
  if (!recipientId || !fromUserId || recipientId === fromUserId) return null;
  if (!Array.isArray(db.notifications)) db.notifications = [];
  const recipient = db.users.find(u => u.id === recipientId);
  if (recipient && Array.isArray(recipient.blocked) && recipient.blocked.includes(fromUserId)) return null;
  const now = nowMs();
  const dupe = db.notifications.find(n =>
    n.userId === recipientId && n.kind === kind && n.fromUserId === fromUserId &&
    n.postId === (extra.postId || null) && (now - n.createdAt) < 30000
  );
  if (dupe) { dupe.createdAt = now; delete dupe.seenAt; return dupe; }
  const author = db.users.find(u => u.id === fromUserId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
  const notif = {
    id: uid('ntf'), userId: recipientId, kind, fromUserId, fromSnapshot: snap,
    postId: extra.postId || null, commentId: extra.commentId || null,
    text: extra.text || null, createdAt: now,
  };
  db.notifications.push(notif);
  const perUser = db.notifications.filter(n => n.userId === recipientId);
  if (perUser.length > 500) {
    const oldest = perUser.slice(0, perUser.length - 500).map(n => n.id);
    db.notifications = db.notifications.filter(n => !oldest.includes(n.id));
  }
  _pushEvent(recipientId, 'notification', { kind, fromUserId, fromSnapshot: snap, postId: notif.postId, text: notif.text, notifId: notif.id });
  const fromName = (snap && (snap.username || snap.displayName)) || 'Someone';
  let title = 'PRIV SPACA', body = '';
  if (kind === 'like')    body = `${fromName} liked your post`;
  if (kind === 'comment') body = `${fromName} commented: ${(notif.text || '').slice(0, 80)}`;
  if (kind === 'follow')  body = `${fromName} started following you`;
  if (kind === 'message') body = `${fromName}: ${(notif.text || '').slice(0, 80)}`;
  if (kind === 'story_reply') body = `${fromName} replied to your story`;
  if (body) supervisedTask(null,
    sendWebPush(db, recipientId, { title, body, tag: 'priv-spaca-' + notif.id, url: '/', kind, notifId: notif.id }),
    `push.send.${kind}`,
  );
  return notif;
}
