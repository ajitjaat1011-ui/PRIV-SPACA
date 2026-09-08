/**
 * PRIV SPACA — Routes — users
 *
 * Profile, users list, follow/block, notes, typing, presence, keys.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { cfg } from '../lib/config.js';
import { state } from '../lib/state.js';
import { fetchDatabase, saveDatabase } from '../lib/db.js';
import { wrapUnexpected } from '../lib/errors.js';
import { _pushEvent, pushNotification } from '../lib/events.js';
import { activeNote, canRequestFollow, canViewProfileCard, canViewerAccessPrivateProfile, clearFollowRequestPair, hasPendingFollowRequest, isSafeImageUrl, isStoryRecord, isUsername, normalizeFollowRequests, nowMs, sanitizeText, sanitizeUser } from '../lib/helpers.js';
import { cleanNoteMusic } from '../lib/media.js';
import * as S from '../lib/schemas.js';
import { body as vbody } from '../lib/validate.js';
import { requireAuth } from '../lib/middleware.js';
import { verifyPassword } from '../lib/password.js';
import { pickBody } from '../lib/validate.js';
import { sharedRateLimit } from '../lib/ratelimit.js';
import { b64url, clearSessionCookie, invalidateUserAuthCaches } from '../lib/auth.js';
import { canAccessRoom, normalizeRoomId } from '../lib/rooms.js';
import { readPresence, readTypingState, setTypingState, touchPresence } from '../lib/realtime-store.js';
import { normalizeDb } from '../lib/schema.js';
import { fetchTursoDmIndex, fetchTursoUnreadCounts, isTursoConfigured, tursoClient, tursoUpsertUser, tursoUpsertUserFeeds } from '../lib/store-turso.js';

// ---------- User update ----------
app.post('/api/user/update', requireAuth, async (c) => {
  try {
    const body = await vbody(c, S.UserUpdateBody);
    const { displayName, username, bio, photoUrl, dateOfBirth, cardVisibility, isPrivate } = body;
    const db = await fetchDatabase();
    const user = db.users.find(u => u.id === c.get('userId'));
    if (!user) return c.json({ error: 'Not found' }, 404);
    const previousUsername = user.username;
    const previousEmail = user.email;
    if (typeof username === 'string' && username !== user.username) {
      if (!isUsername(username)) return c.json({ error: 'Invalid username' }, 400);
      if (db.users.some(u => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase())) return c.json({ error: 'Username taken' }, 409);
      user.username = username;
    }
    if (typeof displayName === 'string') {
      const dn = sanitizeText(displayName, 60).trim();
      if (dn.length >= 1) user.displayName = dn;
    }
    if (typeof bio === 'string') user.bio = sanitizeText(bio, 280);
    if (typeof photoUrl === 'string') {
      const cleanPhoto = photoUrl.trim();
      if (cleanPhoto === '' || isSafeImageUrl(cleanPhoto)) user.photoUrl = cleanPhoto;
    }
    if (typeof dateOfBirth === 'string') {
      const dob = dateOfBirth.trim();
      if (dob === '' || /^\d{4}-\d{2}-\d{2}$/.test(dob)) user.dateOfBirth = dob;
    }
    if (typeof cardVisibility === 'string') {
      const cv = cardVisibility.trim();
      if (['everyone','close_friends','private'].includes(cv)) user.cardVisibility = cv;
    }
    if (typeof isPrivate === 'boolean') user.isPrivate = isPrivate;
    if (isTursoConfigured()) {
      try { await tursoUpsertUser(user); }
      catch (e) {
        if (/unique|constraint/i.test(String(e && e.message))) return c.json({ error: 'Username taken' }, 409);
        throw e;
      }
    }
    await saveDatabase(db, false);
    invalidateUserAuthCaches(user, previousUsername, previousEmail);
    return c.json({ user: sanitizeUser(user, true) });
  } catch (e) { console.error('[user/update]', e); throw wrapUnexpected(e, 'Update failed. Please try again.'); }
});

app.post('/api/user/vip/redeem', requireAuth, async (c) => {
  try {
    const body = await vbody(c, S.VipRedeemBody);
    const key = sanitizeText(String(body.key || ''), 80).trim();
    if (!cfg.VIP_UNLOCK_KEY) return c.json({ error: 'VIP unlock is not configured' }, 503);
    if (!key || key !== cfg.VIP_UNLOCK_KEY) return c.json({ error: 'Invalid VIP key' }, 403);
    const db = await fetchDatabase({ fresh: true });
    const user = db.users.find(u => u.id === c.get('userId'));
    if (!user) return c.json({ error: 'Not found' }, 404);
    user.verified = true;
    user.verifiedAt = user.verifiedAt || nowMs();
    await saveDatabase(db, false);
    if (isTursoConfigured()) await tursoUpsertUser(user);
    return c.json({ ok: true, user: sanitizeUser(user, true) });
  } catch (e) { console.error('[vip/redeem]', e); throw wrapUnexpected(e, 'VIP activation failed. Please try again.'); }
});

app.get('/api/user/close-friends', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === c.get('userId'));
  if (!me) return c.json({ error: 'Not found' }, 404);
  const ids = Array.isArray(me.closeFriends) ? me.closeFriends : [];
  return c.json({ ids });
});

app.post('/api/user/close-friends', requireAuth, async (c) => {
  try {
    const { targetId, action } = await vbody(c, S.CloseFriendsBody);
    const myId = c.get('userId');
    if (!targetId) return c.json({ error: 'targetId required' }, 400);
    if (targetId === myId) return c.json({ error: 'You cannot add yourself' }, 400);
    const db = await fetchDatabase();
    const me = db.users.find(u => u.id === myId);
    const target = db.users.find(u => u.id === targetId);
    if (!me || !target) return c.json({ error: 'Not found' }, 404);
    me.closeFriends = Array.isArray(me.closeFriends) ? me.closeFriends : [];
    const set = new Set(me.closeFriends);
    const mode = String(action || 'toggle');
    if (mode === 'add') set.add(targetId);
    else if (mode === 'remove') set.delete(targetId);
    else if (set.has(targetId)) set.delete(targetId);
    else set.add(targetId);
    me.closeFriends = Array.from(set).slice(0, 500);
    await saveDatabase(db, false);
    if (isTursoConfigured()) await tursoUpsertUser(me);
    return c.json({ ids: me.closeFriends, added: me.closeFriends.includes(targetId) });
  } catch (e) { console.error('[close-friends]', e); throw wrapUnexpected(e, 'Update failed. Please try again.'); }
});

// ---------- Users list ----------
app.get('/api/users', requireAuth, async (c) => {
  const myId = c.get('userId');
  // perf: fetchDatabase() already reads ps_users + ps_posts fresh from Turso
  // (via a single batched read alongside ps_kv) and populates db.users /
  // db.posts from those exact same structured tables — no need for a
  // separate fetchTursoMirror() re-read (removed; see below). The DM-index
  // fetch (fetchTursoDmIndex) only needs myId, not db, so it's fully
  // independent of the db fetch — run both concurrently instead of
  // sequentially to avoid paying two round trips back-to-back.
  // unreadByRoom is independent of both other fetches, so it joins the same
  // Promise.all rather than adding a third round trip.
  const [db, tursoLastByPeer, unreadByRoom] = await Promise.all([
    fetchDatabase(),
    isTursoConfigured() ? fetchTursoDmIndex(myId) : Promise.resolve(null),
    isTursoConfigured() ? fetchTursoUnreadCounts(myId) : Promise.resolve({}),
  ]);
  const dmRoomId = (peerId) => 'dm:' + [myId, peerId].sort().join(':');
  const sourceUsers = db.users || [];
  const me = sourceUsers.find(u => u.id === myId);
  const myBlocked = new Set((me && me.blocked) || []);
  const blockedMe = new Set();
  sourceUsers.forEach(u => {
    if (u.id !== myId && Array.isArray(u.blocked) && u.blocked.includes(myId)) blockedMe.add(u.id);
  });
  const now = nowMs();
  const myFollowing = new Set((me && me.following) || []);
  const myOutgoingRequests = new Set((me && Array.isArray(me.sentFollowRequests) ? me.sentFollowRequests : []));
  const myIncomingRequests = new Set((me && Array.isArray(me.followRequests) ? me.followRequests : []));
  let lastByPeer = {};
  if (isTursoConfigured()) {
    lastByPeer = tursoLastByPeer;
  } else {
    for (const m of (db.messages || [])) {
      if (typeof m.roomId !== 'string' || !m.roomId.startsWith('dm:')) continue;
      const parts = m.roomId.slice(3).split(':');
      if (!parts.includes(myId)) continue;
      const peer = parts.find(id => id !== myId);
      if (!peer) continue;
      if (!lastByPeer[peer] || (m.createdAt || 0) > (lastByPeer[peer].createdAt || 0)) {
        let preview;
        if (m.encrypted) preview = '🔒 Encrypted message';
        else if (m.storyReply) preview = 'Replied to a story';
        else if (m.imageUrl) preview = '📷 Photo';
        else preview = String(m.text || '').slice(0, 60);
        lastByPeer[peer] = { text: preview, createdAt: m.createdAt || 0, fromMe: m.userId === myId };
      }
    }
  }
  const presenceRows = isTursoConfigured() ? await readPresence(sourceUsers.map(u => u.id), now - 45_000) : [];
  const presenceByUser = new Map(presenceRows.map(p => [p.userId, p.at]));
  const list = sourceUsers
    .filter(u => !myBlocked.has(u.id) && !blockedMe.has(u.id))
    .map(u => ({
      ...sanitizeUser(u),
      online: now - (presenceByUser.get(u.id) || ((db.heartbeat && db.heartbeat[u.id]) || 0)) < 45000,
      lastSeen: presenceByUser.get(u.id) || ((db.heartbeat && db.heartbeat[u.id]) || 0),
      iFollow: myFollowing.has(u.id),
      followsMe: Array.isArray(u.following) && u.following.includes(myId),
      requestedByMe: myOutgoingRequests.has(u.id),
      requestedMe: myIncomingRequests.has(u.id),
      lastMessage: lastByPeer[u.id] || null,
      unreadCount: (unreadByRoom && unreadByRoom[dmRoomId(u.id)]) || 0,
      conversationPrefs: (me && me.conversationPrefs && me.conversationPrefs[u.id]) || {},
    }));
  return c.json({
    users: list,
    unreadByRoom: unreadByRoom || {},
    groupUnread: (unreadByRoom && unreadByRoom['general-group']) || 0,
  });
});

// ---------- E2E public key (Part 3) ----------
// Each user uploads their ECDH P-256 public key (base64url, raw 65 bytes uncompressed)
// once on first login. Private key stays in the browser's IndexedDB.
app.post('/api/user/public-key', requireAuth, async (c) => {
  try {
    const { publicKey } = await vbody(c, S.PublicKeyBody);
    if (typeof publicKey !== 'string' || publicKey.length < 32 || publicKey.length > 256) {
      return c.json({ error: 'Invalid key' }, 400);
    }
    // Basic charset check (base64url)
    if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) return c.json({ error: 'Invalid key format' }, 400);
    const db = await fetchDatabase();
    const u = db.users.find(x => x.id === c.get('userId'));
    if (!u) return c.json({ error: 'Not found' }, 404);
    u.publicKey = publicKey;
    u.publicKeyUpdatedAt = nowMs();
    await saveDatabase(db, false);
    return c.json({ ok: true });
  } catch (e) { console.error('[public-key]', e); throw wrapUnexpected(e, 'Save failed. Please try again.'); }
});

app.get('/api/user/public-key', requireAuth, async (c) => {
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'userId required' }, 400);
  let db = await fetchDatabase();
  let u = db.users.find(x => x.id === userId);
  // Cross-isolate consistency: if user has no key yet (or user not found),
  // force a fresh read from GitHub in case the upload just happened elsewhere.
  if (!u || !u.publicKey) {
    state.cacheTimestamp = 0;
    db = await fetchDatabase();
    u = db.users.find(x => x.id === userId);
  }
  if (!u) return c.json({ error: 'Not found' }, 404);
  return c.json({ userId: u.id, publicKey: u.publicKey || null });
});

async function makeRecoveryCodes() {
  const codes = Array.from({ length: 8 }, () => {
    const raw = b64url(crypto.getRandomValues(new Uint8Array(9))).toUpperCase();
    return raw.slice(0, 6) + '-' + raw.slice(6, 12);
  });
  const hashes = await Promise.all(codes.map(async code => {
    const normalized = code.replace(/[^A-Z0-9]/g, '');
    return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))));
  }));
  return { codes, hashes };
}

app.post('/api/user/recovery-codes', requireAuth, async (c) => {
  const myId = c.get('userId');
  const rate = await sharedRateLimit({ key: 'recovery-codes:' + myId, limit: 3, windowMs: 60 * 60_000 });
  if (!rate.allowed) return c.json({ error: 'Too many attempts. Try again later.' }, 429);
  const { password } = await pickBody(c, ['password']);
  const db = await fetchDatabase({ fresh: true });
  const me = db.users.find(u => u.id === myId);
  if (!me || !(await verifyPassword(String(password || ''), me.passwordHash))) return c.json({ error: 'Password verification failed' }, 401);
  const recovery = await makeRecoveryCodes();
  me.recoveryCodeHashes = recovery.hashes;
  me.recoveryCodesGeneratedAt = nowMs();
  if (isTursoConfigured()) await tursoUpsertUser(me);
  if (!(await saveDatabase(db, false))) return c.json({ error: 'Storage temporarily unavailable' }, 503);
  return c.json({ recoveryCodes: recovery.codes });
});

// ---------- Data portability and account deletion ----------
app.post('/api/user/export', requireAuth, async (c) => {
  const myId = c.get('userId');
  const db = await fetchDatabase({ fresh: true });
  const me = db.users.find(u => u.id === myId);
  if (!me) return c.json({ error: 'Not found' }, 404);
  const user = { ...me };
  for (const key of ['passwordHash','pinHash','recoveryCodeHashes','tokenVersion','passkeyPublicKey','passkeyPublicKeyJwk','pushSubs']) delete user[key];
  const payload = {
    exportedAt: new Date().toISOString(),
    format: 'priv-spaca-user-export-v1',
    user,
    posts: (db.posts || []).filter(p => p.userId === myId),
    messages: (db.messages || []).filter(m => m.userId === myId),
    scheduledMessages: (db.scheduledMessages || []).filter(m => m.userId === myId),
    notifications: (db.notifications || []).filter(n => n.userId === myId || n.fromUserId === myId),
  };
  c.header('Content-Disposition', `attachment; filename="priv-spaca-export-${myId}.json"`);
  c.header('Cache-Control', 'no-store');
  return c.json(payload);
});

app.post('/api/user/delete', requireAuth, async (c) => {
  const myId = c.get('userId');
  const limit = await sharedRateLimit({ key: 'account-delete:' + myId, limit: 3, windowMs: 60 * 60_000 });
  if (!limit.allowed) return c.json({ error: 'Too many deletion attempts. Try again later.' }, 429);
  const body = await pickBody(c, ['password', 'pin', 'confirmation']);
  if (body.confirmation !== 'DELETE' || typeof body.password !== 'string' || typeof body.pin !== 'string') {
    return c.json({ error: 'Password, recovery PIN, and DELETE confirmation are required.' }, 400);
  }
  const db = await fetchDatabase({ fresh: true });
  const me = db.users.find(u => u.id === myId);
  if (!me || !(await verifyPassword(body.password, me.passwordHash)) || !(await verifyPassword(body.pin, me.pinHash))) {
    return c.json({ error: 'Account deletion verification failed.' }, 401);
  }
  const usersWithReferences = new Set(db.users.filter(u => u.id !== myId && [
    ...(u.followers || []), ...(u.following || []), ...(u.blocked || []),
    ...(u.closeFriends || []), ...(u.followRequests || []), ...(u.sentFollowRequests || []),
  ].includes(myId)).map(u => u.id));
  db.users = db.users.filter(u => u.id !== myId).map(u => ({
    ...u,
    followers: (u.followers || []).filter(id => id !== myId),
    following: (u.following || []).filter(id => id !== myId),
    blocked: (u.blocked || []).filter(id => id !== myId),
    closeFriends: (u.closeFriends || []).filter(id => id !== myId),
    followRequests: (u.followRequests || []).filter(id => id !== myId),
    sentFollowRequests: (u.sentFollowRequests || []).filter(id => id !== myId),
  }));
  const deletedPostIds = new Set((db.posts || []).filter(p => p.userId === myId).map(p => p.id));
  const deletedMessageIds = new Set((db.messages || []).filter(m => m.userId === myId).map(m => m.id));
  const postsWithUserReferences = new Set((db.posts || []).filter(p =>
    p.userId !== myId && ((p.likes || []).some(like => (typeof like === 'string' ? like : like?.userId) === myId)
      || (p.comments || []).some(comment => comment?.userId === myId))
  ).map(p => p.id));
  const messagesWithUserReferences = new Set((db.messages || []).filter(m =>
    m.userId !== myId && ((m.reactions || []).some(reaction => reaction?.userId === myId)
      || Object.prototype.hasOwnProperty.call(m.receipts || {}, myId))
  ).map(m => m.id));
  // Remove authored records and references embedded in other users' records.
  // This matters because likes/comments/reactions live inside JSON as well as
  // in structured side tables; deleting only ps_users would leave PII behind.
  db.posts = (db.posts || []).filter(p => p.userId !== myId).map(p => ({
    ...p,
    likes: (p.likes || []).filter(like => (typeof like === 'string' ? like : like?.userId) !== myId),
    comments: (p.comments || []).filter(comment => comment?.userId !== myId),
  }));
  db.messages = (db.messages || []).filter(m => m.userId !== myId).map(m => ({
    ...m,
    reactions: (m.reactions || []).filter(reaction => reaction?.userId !== myId),
    receipts: Object.fromEntries(Object.entries(m.receipts || {}).filter(([userId]) => userId !== myId)),
  }));
  db.scheduledMessages = (db.scheduledMessages || []).filter(m => m.userId !== myId);
  db.notifications = (db.notifications || []).filter(n => n.userId !== myId && n.fromUserId !== myId);
  db.rtcSignals = (db.rtcSignals || []).filter(signal => signal?.targetId !== myId && signal?.payload?.fromId !== myId);
  delete db.heartbeat[myId];
  for (const room of Object.keys(db.typing || {})) delete db.typing[room][myId];
  const saved = await saveDatabase(db, false);
  if (!saved) return c.json({ error: 'Storage temporarily unavailable' }, 503);
  if (isTursoConfigured()) {
    const postIds = [...deletedPostIds];
    const statements = [
      { sql: 'DELETE FROM ps_users WHERE id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_posts WHERE user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_messages WHERE user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_notifications WHERE user_id = ? OR from_user_id = ?', args: [myId, myId] },
      { sql: 'DELETE FROM ps_user_feeds WHERE user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_dm_index WHERE owner_user_id = ? OR peer_user_id = ?', args: [myId, myId] },
      { sql: 'DELETE FROM ps_conversation_state WHERE owner_user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_read_state WHERE owner_user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_message_reactions WHERE user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_message_receipts WHERE user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_presence WHERE user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_typing_state WHERE user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_webauthn_challenges WHERE user_id = ?', args: [myId] },
      { sql: 'DELETE FROM ps_events WHERE user_id = ? OR instr(data, ?) > 0', args: [myId, myId] },
    ];
    if (postIds.length) {
      const marks = postIds.map(() => '?').join(',');
      statements.push({ sql: `DELETE FROM ps_user_feeds WHERE post_id IN (${marks})`, args: postIds });
    }
    const messageIds = [...deletedMessageIds];
    if (messageIds.length) {
      const marks = messageIds.map(() => '?').join(',');
      statements.push(
        { sql: `DELETE FROM ps_message_reactions WHERE message_id IN (${marks})`, args: messageIds },
        { sql: `DELETE FROM ps_message_receipts WHERE message_id IN (${marks})`, args: messageIds },
      );
    }
    const rewriteAt = nowMs();
    for (const post of db.posts.filter(p => postsWithUserReferences.has(p.id))) {
      statements.push({ sql: 'UPDATE ps_posts SET data_json = ?, updated_at = ? WHERE id = ?', args: [JSON.stringify(post), rewriteAt, post.id] });
    }
    for (const message of db.messages.filter(m => messagesWithUserReferences.has(m.id))) {
      statements.push({ sql: 'UPDATE ps_messages SET data_json = ?, updated_at = ? WHERE id = ?', args: [JSON.stringify(message), rewriteAt, message.id] });
    }
    for (let offset = 0; offset < statements.length; offset += 50) {
      await tursoClient().batch(statements.slice(offset, offset + 50), 'write');
    }
    await Promise.all(db.users.filter(u => usersWithReferences.has(u.id)).map(u => tursoUpsertUser(u)));
  }
  invalidateUserAuthCaches(me);
  clearSessionCookie(c);
  return c.json({ ok: true, deleted: true });
});

// ---------- Heartbeat & typing ----------
app.post('/api/user/heartbeat', requireAuth, async (c) => {
  const myId = c.get('userId');
  const at = nowMs();
  if (isTursoConfigured()) await touchPresence(myId, at);
  return c.json({ ok: true, at });
});

// ---------- Notes: short 24h status shown on the DM inbox rail ----------
app.post('/api/user/note', requireAuth, async (c) => {
  try {
  const body = await vbody(c, S.NoteBody);
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!u) return c.json({ error: 'Not found' }, 404);
  const text = sanitizeText(body.text || '', 60).trim();
  const music = cleanNoteMusic(body.music);
  // A note needs at least text OR a song; otherwise it's cleared.
  if (!text && !music) { u.note = null; }
  else { u.note = { text, music, createdAt: nowMs(), expiresAt: nowMs() + 24 * 3600 * 1000 }; }
  await saveDatabase(db, false);
  return c.json({ ok: true, note: activeNote(u) });
  } catch (e) { throw wrapUnexpected(e); }
});

app.post('/api/user/typing', requireAuth, async (c) => {
  const body = await vbody(c, S.TypingBody);
  if (!body.roomId) return c.json({ error: 'roomId required' }, 400);
  const myId = c.get('userId');
  const roomId = normalizeRoomId(body.roomId, myId);
  const db = await fetchDatabase();
  if (!canAccessRoom(roomId, myId, db)) return c.json({ error: 'Forbidden' }, 403);
  if (isTursoConfigured()) await setTypingState(roomId, myId, true, 5000);
  const payload = { roomId, userId: myId, user: sanitizeUser(db.users.find(u => u.id === myId)) };
  const recipients = roomId.startsWith('dm:')
    ? roomId.slice(3).split(':').filter(id => id && id !== myId)
    : (db.users || []).map(u => u.id).filter(id => id && id !== myId);
  recipients.slice(0, 250).forEach(id => _pushEvent(id, 'typing', payload, { persist: false }));
  return c.json({ ok: true, expiresInMs: 5000 });
});

app.get('/api/user/typing', requireAuth, async (c) => {
  const myId = c.get('userId');
  const roomId = normalizeRoomId(c.req.query('roomId'), myId);
  if (!roomId) return c.json({ error: 'roomId required' }, 400);
  const db = await fetchDatabase();
  if (!canAccessRoom(roomId, myId, db)) return c.json({ error: 'Forbidden' }, 403);
  const rows = isTursoConfigured() ? await readTypingState(roomId) : [];
  const typing = rows.filter(row => row.userId !== myId)
    .map(row => {
      const u = db.users.find(x => x.id === row.userId);
      return u ? { id: u.id, username: u.username, displayName: u.displayName } : null;
    }).filter(Boolean);
  return c.json({ typing });
});

// ---------- Per-user conversation controls (pin/mute/archive/delete/unread) ----------
app.post('/api/user/conversation', requireAuth, async (c) => {
  try {
    const body = await vbody(c, S.ConversationActionBody);
    const myId = c.get('userId');
    const db = await fetchDatabase();
    const me = db.users.find(u => u.id === myId);
    const peer = db.users.find(u => u.id === body.peerId);
    if (!me || !peer || peer.id === myId) return c.json({ error: 'Conversation not found' }, 404);
    const allowed = new Set(['pin', 'mute', 'archive', 'delete', 'unread']);
    if (!allowed.has(body.action)) return c.json({ error: 'Unsupported action' }, 400);
    me.conversationPrefs = me.conversationPrefs && typeof me.conversationPrefs === 'object' ? me.conversationPrefs : {};
    const prefs = { ...(me.conversationPrefs[peer.id] || {}) };
    const enabled = body.value === undefined ? !prefs[body.action] : !!body.value;
    if (body.action === 'delete') {
      prefs.archived = true;
      prefs.deletedBefore = enabled ? nowMs() : 0;
    } else if (body.action !== 'unread') {
      prefs[body.action === 'archive' ? 'archived' : body.action === 'pin' ? 'pinned' : 'muted'] = enabled;
    }
    prefs.updatedAt = nowMs();
    me.conversationPrefs[peer.id] = prefs;
    await saveDatabase(db, false, { skipSecondarySync: true });
    if (isTursoConfigured()) {
      await tursoUpsertUser(me);
      if (body.action === 'unread' && enabled) {
        const roomId = 'dm:' + [myId, peer.id].sort().join(':');
        await tursoClient().execute({
          sql: `INSERT INTO ps_conversation_state (owner_user_id, room_id, unread_count, last_message_at, last_read_at, updated_at)
                VALUES (?, ?, 1, 0, 0, ?)
                ON CONFLICT(owner_user_id, room_id) DO UPDATE SET unread_count=MAX(1, ps_conversation_state.unread_count), updated_at=excluded.updated_at`,
          args: [myId, roomId, nowMs()],
        });
      }
    }
    return c.json({ ok: true, peerId: peer.id, action: body.action, enabled, prefs });
  } catch (e) { throw wrapUnexpected(e); }
});

// ---------- Follow / Block ----------
app.post('/api/user/follow', requireAuth, async (c) => {
  try {
  const { targetId } = await vbody(c, S.TargetIdBody);
  const myId = c.get('userId');
  if (!targetId || targetId === myId) return c.json({ error: 'Invalid target' }, 400);
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === myId);
  const target = db.users.find(u => u.id === targetId);
  if (!me || !target) return c.json({ error: 'User not found' }, 404);
  if (Array.isArray(target.blocked) && target.blocked.includes(myId)) return c.json({ error: 'Cannot follow this user' }, 403);
  if (Array.isArray(me.blocked) && me.blocked.includes(targetId)) return c.json({ error: 'Unblock this user first' }, 403);
  me.following = me.following || [];
  target.followers = target.followers || [];
  normalizeFollowRequests(me);
  normalizeFollowRequests(target);

  if (canRequestFollow(target, myId) && !me.following.includes(targetId) && !target.followers.includes(myId)) {
    if (!target.followRequests.includes(myId)) target.followRequests.push(myId);
    if (!me.sentFollowRequests.includes(targetId)) me.sentFollowRequests.push(targetId);
    await saveDatabase(db, false);
    if (isTursoConfigured()) {
      await tursoUpsertUser(me);
      await tursoUpsertUser(target);
    }
    _pushEvent(targetId, 'follow_request', { fromUserId: myId, fromSnapshot: sanitizeUser(me) });
    return c.json({ ok: true, requested: true, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers, followRequestIds: target.followRequests });
  }

  clearFollowRequestPair(me, target);
  if (!me.following.includes(targetId)) me.following.push(targetId);
  if (!target.followers.includes(myId)) target.followers.push(myId);
  pushNotification(db, targetId, 'follow', myId);
  await saveDatabase(db, false);
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(target);
    // Fan-out on follow: backfill the followed user's recent posts
    // into the follower's feed table so they see content immediately.
    try {
      const tc = tursoClient();
      const recentPosts = await tc.execute({
        sql: `SELECT id, created_at FROM ps_posts WHERE user_id = ? AND (story IS NULL OR story = 0) ORDER BY created_at DESC LIMIT 50`,
        args: [targetId]
      }).catch(() => ({ rows: [] }));
      if (recentPosts.rows?.length) {
        const feedRows = recentPosts.rows.map(r => ({
          userId: myId, postId: r.id, createdAt: Number(r.created_at) || nowMs()
        }));
        await tursoUpsertUserFeeds(feedRows);
      }
    } catch (_) { /* best-effort; don't fail the follow */ }
  }
  return c.json({ ok: true, requested: false, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers });
  } catch (e) { throw wrapUnexpected(e); }
});

app.post('/api/user/unfollow', requireAuth, async (c) => {
  const { targetId } = await vbody(c, S.TargetIdBody);
  if (!targetId) return c.json({ error: 'targetId required' }, 400);
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === c.get('userId'));
  const target = db.users.find(u => u.id === targetId);
  if (!me || !target) return c.json({ error: 'User not found' }, 404);
  normalizeFollowRequests(me);
  normalizeFollowRequests(target);
  const cancelledRequest = hasPendingFollowRequest(me, target);
  clearFollowRequestPair(me, target);
  me.following = (me.following || []).filter(id => id !== targetId);
  target.followers = (target.followers || []).filter(id => id !== c.get('userId'));
  await saveDatabase(db, false);
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(target);
  }
  return c.json({ ok: true, requested: false, cancelledRequest, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers });
});

app.get('/api/user/follow-requests', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === c.get('userId'));
  if (!me) return c.json({ error: 'Not found' }, 404);
  normalizeFollowRequests(me);
  const incoming = me.followRequests
    .map(id => db.users.find(u => u.id === id))
    .filter(Boolean)
    .map(u => sanitizeUser(u));
  return c.json({ incoming, count: incoming.length, isPrivate: !!me.isPrivate });
});

app.post('/api/user/follow-requests/respond', requireAuth, async (c) => {
  const { requesterId, action } = await vbody(c, S.FollowRespondBody);
  if (!requesterId || !['accept', 'reject'].includes(String(action || ''))) {
    return c.json({ error: 'requesterId and valid action required' }, 400);
  }
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === c.get('userId'));
  const requester = db.users.find(u => u.id === requesterId);
  if (!me || !requester) return c.json({ error: 'User not found' }, 404);
  normalizeFollowRequests(me);
  normalizeFollowRequests(requester);
  if (!me.followRequests.includes(requesterId)) return c.json({ error: 'Request not found' }, 404);
  clearFollowRequestPair(requester, me);
  if (action === 'accept') {
    me.followers = Array.isArray(me.followers) ? me.followers : [];
    requester.following = Array.isArray(requester.following) ? requester.following : [];
    if (!me.followers.includes(requesterId)) me.followers.push(requesterId);
    if (!requester.following.includes(me.id)) requester.following.push(me.id);
  }
  await saveDatabase(db, false);
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(requester);
    if (action === 'accept') {
      try {
        const tc = tursoClient();
        const recentPosts = await tc.execute({
          sql: `SELECT id, created_at FROM ps_posts WHERE user_id = ? AND (story IS NULL OR story = 0) ORDER BY created_at DESC LIMIT 50`,
          args: [me.id]
        }).catch(() => ({ rows: [] }));
        if (recentPosts.rows?.length) {
          const feedRows = recentPosts.rows.map(r => ({
            userId: requesterId, postId: r.id, createdAt: Number(r.created_at) || nowMs()
          }));
          await tursoUpsertUserFeeds(feedRows);
        }
      } catch (_) {}
    }
  }
  _pushEvent(requesterId, 'follow_request_updated', { targetId: me.id, action, targetSnapshot: sanitizeUser(me) });
  return c.json({ ok: true, action, incoming: me.followRequests.map(id => db.users.find(u => u.id === id)).filter(Boolean).map(u => sanitizeUser(u)) });
});

app.post('/api/user/block', requireAuth, async (c) => {
  try {
  const { targetId } = await vbody(c, S.TargetIdBody);
  const myId = c.get('userId');
  if (!targetId || targetId === myId) return c.json({ error: 'Invalid target' }, 400);
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === myId);
  const target = db.users.find(u => u.id === targetId);
  if (!me || !target) return c.json({ error: 'User not found' }, 404);
  me.blocked = me.blocked || [];
  if (!me.blocked.includes(targetId)) me.blocked.push(targetId);
  normalizeFollowRequests(me);
  normalizeFollowRequests(target);
  clearFollowRequestPair(me, target);
  clearFollowRequestPair(target, me);
  me.following = (me.following || []).filter(id => id !== targetId);
  target.followers = (target.followers || []).filter(id => id !== myId);
  target.following = (target.following || []).filter(id => id !== myId);
  me.followers = (me.followers || []).filter(id => id !== targetId);
  db.notifications = (db.notifications || []).filter(n => !((n.userId === myId && n.fromUserId === targetId) || (n.userId === targetId && n.fromUserId === myId)));
  await saveDatabase(db, false);
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(target);
  }
  return c.json({ ok: true });
  } catch (e) { throw wrapUnexpected(e); }
});

app.post('/api/user/unblock', requireAuth, async (c) => {
  const { targetId } = await vbody(c, S.TargetIdBody);
  if (!targetId) return c.json({ error: 'targetId required' }, 400);
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === c.get('userId'));
  if (!me) return c.json({ error: 'Not found' }, 404);
  me.blocked = (me.blocked || []).filter(id => id !== targetId);
  await saveDatabase(db, false);
  if (isTursoConfigured()) await tursoUpsertUser(me);
  return c.json({ ok: true });
});

app.get('/api/user/:id/profile', requireAuth, async (c) => {
  const targetId = c.req.param('id');
  const myId = c.get('userId');
  const sdb = await fetchDatabase();
  const sourceUsers = sdb.users || [];
  const sourcePosts = sdb.posts || [];
  const structuredDb = normalizeDb({ users: sourceUsers, posts: sourcePosts });
  const target = sourceUsers.find(u => u.id === targetId);
  if (!target) return c.json({ error: 'Not found' }, 404);
  const me = sourceUsers.find(u => u.id === myId);
  const blockedMe = Array.isArray(target.blocked) && target.blocked.includes(myId);
  const iBlocked = me && Array.isArray(me.blocked) && me.blocked.includes(targetId);
  if (blockedMe) return c.json({ error: 'Profile unavailable' }, 403);
  const allPosts = sourcePosts.filter(p => p.userId === targetId && !p.deletedAt && !isStoryRecord(p))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => ({ id: p.id, userId: p.userId, imageUrl: p.imageUrl || (Array.isArray(p.images) ? p.images[0] : null), images: Array.isArray(p.images) ? p.images : [], videoUrl: p.videoUrl || null, text: p.text, createdAt: p.createdAt, likeCount: (p.likes || []).length, commentCount: (p.comments || []).length, authorSnapshot: p.authorSnapshot || null }));
  const followerIds = Array.from(new Set([
    ...(Array.isArray(target.followers) ? target.followers : []),
    ...sourceUsers.filter(u => Array.isArray(u.following) && u.following.includes(targetId)).map(u => u.id),
  ])).filter(id => id && id !== targetId);
  const followingIds = Array.from(new Set(Array.isArray(target.following) ? target.following : [])).filter(id => id && id !== targetId);
  const canViewPrivateProfile = canViewerAccessPrivateProfile(target, myId, structuredDb);
  const profileLocked = !!target.isPrivate && !canViewPrivateProfile && targetId !== myId;
  const posts = profileLocked ? [] : allPosts;
  const canViewCard = !profileLocked && canViewProfileCard(target, myId);
  const cardVisibility = ['everyone','close_friends','private'].includes(target.cardVisibility) ? target.cardVisibility : 'everyone';
  const profileUser = { ...sanitizeUser(target, targetId === myId), followers: followerIds.length, following: followingIds.length, followerIds: profileLocked ? [] : followerIds, followingIds: profileLocked ? [] : followingIds, postsCount: allPosts.length, profileLocked };
  profileUser.card = canViewCard ? {
    canView: true, visibility: cardVisibility, dateOfBirth: target.dateOfBirth || '',
    postsCount: allPosts.length, followers: followerIds.length, following: followingIds.length
  } : { canView: false, visibility: cardVisibility };
  return c.json({
    user: profileUser,
    posts,
    relationship: {
      isMe: targetId === myId,
      iFollow: !!(me && (me.following || []).includes(targetId)),
      followsMe: Array.isArray(target.following) && target.following.includes(myId),
      requestedByMe: !!(me && Array.isArray(me.sentFollowRequests) && me.sentFollowRequests.includes(targetId)),
      requestedMe: Array.isArray(target.sentFollowRequests) && target.sentFollowRequests.includes(myId),
      iBlocked,
      profileLocked,
    },
  });
});
