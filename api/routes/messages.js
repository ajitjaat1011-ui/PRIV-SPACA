/**
 * PRIV SPACA — Routes — messages
 *
 * Direct + group messaging, scheduling, delete/restore.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { fetchDatabase, isPersist, saveDatabase, saveDatabaseVerified } from '../lib/db.js';
import { wrapUnexpected } from '../lib/errors.js';
import { _broadcastEvent, _pushEvent, pushNotification } from '../lib/events.js';
import { isSafeMediaUrl, nowMs, sanitizeText, sanitizeUser, uid } from '../lib/helpers.js';
import * as S from '../lib/schemas.js';
import { body as vbody } from '../lib/validate.js';
import { requireAuth } from '../lib/middleware.js';
import { dmRoomFor, normalizeRoomId } from '../lib/rooms.js';
import { fetchTursoMessages, isTursoConfigured, tursoClient, tursoHealNotificationColumns, tursoMarkRoomRead, tursoMarkRoomsRead, tursoRefreshDmIndexForOwners, tursoUpsertMessages } from '../lib/store-turso.js';

// ---------- Messages ----------
app.get('/api/messages', requireAuth, async (c) => {
  const roomId = normalizeRoomId(c.req.query('roomId') || 'general-group', c.get('userId'));
  if (roomId.startsWith('dm:')) {
    const parts = roomId.slice(3).split(':');
    if (!parts.includes(c.get('userId'))) return c.json({ error: 'Forbidden' }, 403);
  }
  let now = nowMs();
  // perf: fetchDatabase() and fetchTursoMessages() are two independent Turso
  // round trips that don't depend on each other's results (fetchTursoMessages
  // only needs roomId/now, not the db object). They used to run sequentially,
  // each paying the same network round-trip cost — running them concurrently
  // via Promise.all cuts this endpoint's wait roughly in half on any request
  // that isn't served entirely from the in-memory cache.
  let [db, list] = await Promise.all([
    fetchDatabase(),
    fetchTursoMessages(roomId, now),
  ]);
  const dbRoomMessages = () => db.messages
    .filter(m => m.roomId === roomId && !m.deletedAt && !(m.disappearAt && m.disappearAt <= now))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-200);
  if (!Array.isArray(list) || (list.length === 0 && db.messages.some(m => m.roomId === roomId && !m.deletedAt))) {
    list = dbRoomMessages();
  }
  const enriched = list.map(m => {
    const author = db.users.find(u => u.id === m.userId);
    if (author) return { ...m, author: sanitizeUser(author) };
    if (m.authorSnapshot) return { ...m, author: m.authorSnapshot };
    return { ...m, author: { id: m.userId, displayName: 'Member', username: (m.userId || 'member').slice(-6) } };
  });

  return c.json({ messages: enriched, roomId });
});

app.post('/api/messages/send', requireAuth, async (c) => {
  try {
    const body = await vbody(c, S.MessageSendBody);
    const {
      roomId: raw, text, imageUrl, replyTo, targetUserId,
      encrypted, cipher, iv,                  // E2E payload (Part 3)
      disappearAfterMs,                       // disappearing messages (Part 3)
      clientNonce,                            // optimistic-UI correlation id
    } = body;
    // Echoed back (and broadcast over SSE) so the sender's optimistic bubble
    // can be matched to its real row instead of being drawn twice.
    const nonce = typeof clientNonce === 'string' ? clientNonce.slice(0, 64) : null;
    const myId = c.get('userId');
    let roomId = raw;
    if (!roomId && targetUserId) roomId = dmRoomFor(myId, targetUserId);
    roomId = normalizeRoomId(roomId || 'general-group', myId);
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      if (!parts.includes(myId)) return c.json({ error: 'Forbidden' }, 403);
    }

    // ---- Encrypted (E2E) path ----
    const isEncrypted = !!encrypted && typeof cipher === 'string' && typeof iv === 'string';
    if (isEncrypted && !roomId.startsWith('dm:')) {
      return c.json({ error: 'E2E only supported in DMs' }, 400);
    }
    if (isEncrypted) {
      // Safety bounds on encrypted blobs (base64 of ~4KB plaintext)
      if (cipher.length > 12000 || iv.length > 64) {
        return c.json({ error: 'Payload too large' }, 413);
      }
    }

    const ct = isEncrypted ? '' : sanitizeText(text, 4000);
    const ci = isSafeMediaUrl(imageUrl) ? String(imageUrl).trim() : null;
    if (!ct && !ci && !isEncrypted) return c.json({ error: 'Empty message' }, 400);

    // Disappearing TTL (clamp to 10s..24h)
    let disappearAt = null;
    if (typeof disappearAfterMs === 'number' && disappearAfterMs > 0) {
      const ms = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, disappearAfterMs));
      disappearAt = nowMs() + ms;
    }

    const db = await fetchDatabase();
    // SECURITY: block self-DMs.
    if (targetUserId && targetUserId === myId) {
      return c.json({ error: 'Cannot message yourself' }, 400);
    }
    // SECURITY: honor block list BEFORE pushing the SSE event for DMs.
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      const recipId = parts.find(id => id !== myId);
      const recip = recipId && db.users.find(u => u.id === recipId);
      if (recip && Array.isArray(recip.blocked) && recip.blocked.includes(myId)) {
        return c.json({ error: 'Cannot message this user' }, 403);
      }
    }
    let replyRef = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.id) {
      replyRef = {
        id: replyTo.id,
        text: typeof replyTo.text === 'string' ? replyTo.text.slice(0, 200) : '',
        username: typeof replyTo.username === 'string' ? replyTo.username.slice(0, 60) : '',
        imageUrl: isSafeMediaUrl(replyTo.imageUrl) ? String(replyTo.imageUrl).trim().slice(0, 2048) : null,
      };
    }
    const author = db.users.find(u => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
    const msg = {
      id: uid('msg'), roomId, userId: myId,
      text: ct, imageUrl: ci, replyTo: replyRef, authorSnapshot: snap, createdAt: nowMs(),
    };
    if (nonce) msg.clientNonce = nonce;
    if (isEncrypted) { msg.encrypted = true; msg.cipher = cipher; msg.iv = iv; }
    if (disappearAt) { msg.disappearAt = disappearAt; msg.disappearAfterMs = disappearAfterMs; }
    db.messages.push(msg);

    const enriched = { ...msg, author: snap || { id: myId, displayName: 'Member', username: 'member' } };
    const tursoNotifs = [];
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      parts.filter(uid2 => uid2 !== myId).forEach(recip => {
        _pushEvent(recip, 'new_message', { roomId, message: enriched });
        // For E2E messages, server never sees plaintext → push preview is generic
        const previewText = isEncrypted ? '🔒 Encrypted message' : (ct || (ci ? '📷 Photo' : ''));
        const notif = pushNotification(db, recip, 'message', myId, { text: previewText.slice(0, 80) });
        if (notif) tursoNotifs.push(notif);
      });
    } else {
      _broadcastEvent('new_message', { roomId, message: enriched }, myId);
    }
    if (isTursoConfigured()) {
      const stmts = [];
      stmts.push({
        sql: 'INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at, updated_at=excluded.updated_at, data_json=excluded.data_json',
        args: [msg.id, msg.roomId, msg.userId, Number(msg.createdAt||0), msg.deletedAt?Number(msg.deletedAt):null, nowMs(), JSON.stringify(msg)]
      });
      for (const n of tursoNotifs) {
        stmts.push({
          // updated_at is NOT NULL; omitting it aborted the whole batch, which
          // also rolled back the ps_dm_index upsert below (empty inbox preview).
          sql: 'INSERT INTO ps_notifications (id, user_id, kind, from_user_id, post_id, comment_id, created_at, seen_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at, updated_at=excluded.updated_at, data_json=excluded.data_json',
          args: [n.id, n.userId, n.kind, n.fromUserId, n.postId||null, n.commentId||null, Number(n.createdAt||0), n.seenAt?Number(n.seenAt):null, nowMs(), JSON.stringify(n)]
        });
      }
      if (roomId.startsWith('dm:')) {
        const ownerIds = roomId.slice(3).split(':').filter(Boolean);
        // Preview text mirrors fetchTursoDmIndex()/tursoRefreshDmIndexForOwners().
        let previewText;
        if (isEncrypted) previewText = '🔒 Encrypted message';
        else if (msg.storyReply) previewText = 'Replied to a story';
        else if (msg.imageUrl) previewText = '📷 Photo';
        else previewText = String(msg.text || '').slice(0, 60);
        for (const oid of ownerIds) {
          const peerId = oid === myId ? (ownerIds.find(x => x !== myId) || myId) : myId;
          // One row per side of the conversation. data_json MUST carry
          // peerUserId - fetchTursoDmIndex() drops any row without it, which
          // is why the inbox showed no preview and had nothing to sort by.
          // fromMe is per-owner: true for the sender, false for the recipient.
          const dmPreview = {
            ownerUserId: oid,
            peerUserId: peerId,
            roomId,
            text: previewText,
            fromMe: oid === myId,
            createdAt: Number(msg.createdAt || 0),
          };
          stmts.push({
            sql: `INSERT INTO ps_dm_index (owner_user_id, peer_user_id, room_id, created_at, from_me, updated_at, data_json)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(owner_user_id, peer_user_id) DO UPDATE SET
                    room_id = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.room_id ELSE ps_dm_index.room_id END,
                    created_at = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.created_at ELSE ps_dm_index.created_at END,
                    from_me = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.from_me ELSE ps_dm_index.from_me END,
                    updated_at = excluded.updated_at,
                    data_json = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.data_json ELSE ps_dm_index.data_json END`,
            args: [oid, peerId, roomId, Number(msg.createdAt||0), oid === myId ? 1 : 0, nowMs(), JSON.stringify(dmPreview)]
          });
        }
      }
      // Sending into a room implies you have read it: clear the sender's own
      // unread for this room in the same batch, so the count is right even if
      // the client never calls /api/messages/read.
      stmts.push({
        sql: `INSERT INTO ps_read_state (owner_user_id, room_id, last_read_at, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(owner_user_id, room_id) DO UPDATE SET
                last_read_at = MAX(ps_read_state.last_read_at, excluded.last_read_at),
                updated_at = excluded.updated_at`,
        args: [myId, roomId, Number(msg.createdAt || 0) || nowMs(), nowMs()],
      });
      const [persisted] = await Promise.all([
        saveDatabaseVerified(db, d => (d.messages || []).some(m => m.id === msg.id), 4, { skipSecondarySync: true }),
        tursoClient().batch(stmts, 'write').catch(async (e) => {
          const emsg = (e && e.message) || '';
          console.warn('[send] batched write failed:', emsg);
          // A database created before post_id/comment_id existed rejects the
          // notification insert and takes the whole batch (including the
          // ps_dm_index upsert that drives the inbox preview) down with it.
          // Patch the columns once, then retry the batch before falling back.
          if (/no column named (post_id|comment_id)/i.test(emsg)) {
            const healed = await tursoHealNotificationColumns();
            if (healed) {
              try { return await tursoClient().batch(stmts, 'write'); }
              catch (e2) { console.warn('[send] retry after heal failed:', e2 && e2.message); }
            }
          }
          return tursoUpsertMessages([msg]).catch(() => {});
        })
      ]);
      if (isPersist() && !persisted) return c.json({ error: 'Message storage unavailable. Please retry.' }, 503);
    } else {
      const persisted = await saveDatabaseVerified(db, d => (d.messages || []).some(m => m.id === msg.id), 4, { skipSecondarySync: true });
      if (isPersist() && !persisted) return c.json({ error: 'Message storage unavailable. Please retry.' }, 503);
    }
    return c.json({ message: enriched });
  } catch (e) { console.error('[send]', e); throw wrapUnexpected(e, 'Send failed. Please try again.'); }
});

app.post('/api/messages/delete', requireAuth, async (c) => {
  try {
    const { messageId } = await vbody(c, S.MessageIdBody);
    if (!messageId) return c.json({ error: 'messageId required' }, 400);
    const db = await fetchDatabase();
    const m = db.messages.find(x => x.id === messageId);
    if (!m) return c.json({ error: 'Not found' }, 404);
    if (m.userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
    m.deletedAt = nowMs();
    await saveDatabase(db, false, { skipSecondarySync: true });
    if (isTursoConfigured()) {
      await tursoUpsertMessages([m]);
      if (typeof m.roomId === 'string' && m.roomId.startsWith('dm:')) await tursoRefreshDmIndexForOwners(db, m.roomId.slice(3).split(':').filter(Boolean));
    }
    return c.json({ ok: true, undoUntil: m.deletedAt + 30 * 24 * 3600 * 1000 });
  } catch (e) { console.error('[delmsg]', e); throw wrapUnexpected(e, 'Delete failed. Please try again.'); }
});

app.post('/api/messages/restore', requireAuth, async (c) => {
  try {
    const { messageId } = await vbody(c, S.MessageIdBody);
    const db = await fetchDatabase();
    const m = db.messages.find(x => x.id === messageId);
    if (!m) return c.json({ error: 'Not found' }, 404);
    if (m.userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
    delete m.deletedAt;
    await saveDatabase(db, false, { skipSecondarySync: true });
    if (isTursoConfigured()) {
      await tursoUpsertMessages([m]);
      if (typeof m.roomId === 'string' && m.roomId.startsWith('dm:')) await tursoRefreshDmIndexForOwners(db, m.roomId.slice(3).split(':').filter(Boolean));
    }
    return c.json({ ok: true });
  } catch (e) { console.error('[restoremsg]', e); throw wrapUnexpected(e, 'Restore failed. Please try again.'); }
});

// Scheduled
app.post('/api/messages/schedule', requireAuth, async (c) => {
  try {
    const body = await vbody(c, S.MessageSendBody);
    const { roomId: raw, targetUserId, text, imageUrl, deliverAt, replyTo } = body;
    const myId = c.get('userId');
    let roomId = raw;
    if (!roomId && targetUserId) roomId = dmRoomFor(myId, targetUserId);
    roomId = normalizeRoomId(roomId || 'general-group', myId);
    const ts = Number(deliverAt);
    if (!ts || isNaN(ts) || ts < nowMs() + 5000) return c.json({ error: 'deliverAt must be at least 5s in future' }, 400);
    const ct = sanitizeText(text, 4000);
    const ci = isSafeMediaUrl(imageUrl) ? String(imageUrl).trim() : null;
    if (!ct && !ci) return c.json({ error: 'Empty message' }, 400);
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      if (!parts.includes(myId)) return c.json({ error: 'Forbidden' }, 403);
    }
    const db = await fetchDatabase();
    let replyRef = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.id) {
      replyRef = {
        id: replyTo.id,
        text: typeof replyTo.text === 'string' ? replyTo.text.slice(0, 200) : '',
        username: typeof replyTo.username === 'string' ? replyTo.username.slice(0, 60) : '',
        imageUrl: isSafeMediaUrl(replyTo.imageUrl) ? String(replyTo.imageUrl).trim().slice(0, 2048) : null,
      };
    }
    const author = db.users.find(u => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
    const sm = { id: uid('sched'), roomId, userId: myId, text: ct, imageUrl: ci, replyTo: replyRef, authorSnapshot: snap, deliverAt: ts, createdAt: nowMs() };
    db.scheduledMessages.push(sm);
    await saveDatabase(db, false);
    return c.json({ scheduled: sm });
  } catch (e) { throw wrapUnexpected(e, 'Schedule failed. Please try again.'); }
});

app.get('/api/messages/scheduled', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const list = db.scheduledMessages.filter(s => s.userId === c.get('userId')).sort((a, b) => a.deliverAt - b.deliverAt);
  return c.json({ scheduled: list });
});

app.post('/api/messages/scheduled/cancel', requireAuth, async (c) => {
  try {
  const { id } = await vbody(c, S.MessageDeleteBody);
  if (!id) return c.json({ error: 'id required' }, 400);
  const db = await fetchDatabase();
  const idx = db.scheduledMessages.findIndex(s => s.id === id);
  if (idx === -1) return c.json({ error: 'Not found' }, 404);
  if (db.scheduledMessages[idx].userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
  db.scheduledMessages.splice(idx, 1);
  await saveDatabase(db, false);
  return c.json({ ok: true });
  } catch (e) { throw wrapUnexpected(e); }
});

// ---------- Mark a room read ----------
// Called by the client when a conversation is opened (and when a message
// arrives while that conversation is already on screen). Stamps
// ps_read_state so the room's unread count in /api/users drops to zero.
app.post('/api/messages/read', requireAuth, async (c) => {
  try {
    const myId = c.get('userId');
    const body = await vbody(c, S.MessageReadBody);
    const roomId = String(body.roomId || '').trim();
    if (!roomId) return c.json({ error: 'roomId required' }, 400);
    // Only rooms the caller is actually in: the shared group, or a dm room
    // whose id contains their user id.
    const allowed = roomId === 'general-group'
      || (roomId.startsWith('dm:') && roomId.slice(3).split(':').includes(myId));
    if (!allowed) return c.json({ error: 'Forbidden' }, 403);
    const ts = Number(body.at) > 0 ? Number(body.at) : nowMs();
    if (isTursoConfigured()) await tursoMarkRoomRead(myId, roomId, ts);
    return c.json({ ok: true, roomId, at: ts });
  } catch (e) { throw wrapUnexpected(e); }
});

// Batched, best-effort read receipts are Tier 2 in Omni. The batch keeps rapid
// room switches from generating one database/network operation per room.
app.post('/api/messages/read-batch', requireAuth, async (c) => {
  try {
    const myId = c.get('userId');
    const body = await vbody(c, S.MessageReadBatchBody);
    const receipts = (body.receipts || []).map((receipt) => ({
      roomId: String(receipt.roomId || '').trim(),
      at: Number(receipt.at) > 0 ? Number(receipt.at) : nowMs(),
    }));
    if (!receipts.length) return c.json({ ok: true, count: 0 });
    const allowed = receipts.every(({ roomId }) => roomId === 'general-group'
      || (roomId.startsWith('dm:') && roomId.slice(3).split(':').includes(myId)));
    if (!allowed) return c.json({ error: 'Forbidden' }, 403);
    if (isTursoConfigured()) await tursoMarkRoomsRead(myId, receipts);
    return c.json({ ok: true, count: receipts.length, at: nowMs() });
  } catch (e) { throw wrapUnexpected(e); }
});
