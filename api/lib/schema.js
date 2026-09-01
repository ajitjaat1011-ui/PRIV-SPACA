/**
 * PRIV SPACA — Library — schema
 *
 * DB shape normalisation, record merging and the retention scheduler.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { nowMs, uid } from './helpers.js';

export function runScheduler(db) {
  const now = nowMs();
  let changed = false;
  const PURGE = 30 * 24 * 3600 * 1000;
  const bp = (db.posts || []).length;
  db.posts = (db.posts || []).filter(p => !p.deletedAt || (now - p.deletedAt) < PURGE);
  if (db.posts.length !== bp) changed = true;
  const bm = (db.messages || []).length;
  // Soft-delete disappearing messages whose TTL elapsed (so they no longer ship to GET /messages)
  for (const m of db.messages || []) {
    if (m.disappearAt && m.disappearAt <= now && !m.deletedAt) {
      m.deletedAt = now;
      m.disappeared = true;
      changed = true;
    }
  }
  db.messages = (db.messages || []).filter(m => !m.deletedAt || (now - m.deletedAt) < PURGE);
  if (db.messages.length !== bm) changed = true;
  if (db.typing && typeof db.typing === 'object') {
    for (const room of Object.keys(db.typing)) {
      const map = db.typing[room];
      if (!map || typeof map !== 'object') { delete db.typing[room]; continue; }
      for (const u of Object.keys(map)) if (now - (map[u] || 0) > 10000) delete map[u];
      if (Object.keys(map).length === 0) delete db.typing[room];
    }
  }
  if (Array.isArray(db.rtcSignals)) {
    const beforeRtc = db.rtcSignals.length;
    db.rtcSignals = db.rtcSignals.filter(x => x && (!x.expiresAt || x.expiresAt > now));
    if (db.rtcSignals.length !== beforeRtc) changed = true;
  } else { db.rtcSignals = []; changed = true; }
  if (!Array.isArray(db.scheduledMessages) || db.scheduledMessages.length === 0) return changed;
  const due = [], remaining = [];
  for (const sm of db.scheduledMessages) {
    if (sm && typeof sm.deliverAt === 'number' && sm.deliverAt <= now) due.push(sm);
    else remaining.push(sm);
  }
  if (due.length === 0) return changed;
  for (const sm of due) {
    const author = db.users.find(u => u.id === sm.userId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : (sm.authorSnapshot || null);
    db.messages.push({
      id: sm.id || uid('msg'), roomId: sm.roomId, userId: sm.userId,
      text: sm.text || '', imageUrl: sm.imageUrl || null,
      replyTo: sm.replyTo || null, authorSnapshot: snap,
      createdAt: now, scheduledOriginally: true,
    });
  }
  db.scheduledMessages = remaining;
  return true;
}

export function normalizeDb(remote) {
  const r = remote && typeof remote === 'object' ? remote : {};
  return {
    users: Array.isArray(r.users) ? r.users : [],
    messages: Array.isArray(r.messages) ? r.messages : [],
    scheduledMessages: Array.isArray(r.scheduledMessages) ? r.scheduledMessages : [],
    posts: Array.isArray(r.posts) ? r.posts : [],
    notifications: Array.isArray(r.notifications) ? r.notifications : [],
    typing: r.typing && typeof r.typing === 'object' ? r.typing : {},
    heartbeat: r.heartbeat && typeof r.heartbeat === 'object' ? r.heartbeat : {},
    rtcSignals: Array.isArray(r.rtcSignals) ? r.rtcSignals : [],
    meta: r.meta && typeof r.meta === 'object' ? r.meta : {},
  };
}

export function mergeById(remoteArr, localArr) {
  const map = new Map();
  for (const x of Array.isArray(remoteArr) ? remoteArr : []) if (x && x.id) map.set(x.id, x);
  for (const x of Array.isArray(localArr) ? localArr : []) if (x && x.id) {
    const prev = map.get(x.id) || {};
    // Local wins, but preserve soft-delete/seen metadata if either side has it.
    const merged = { ...prev, ...x };
    if (prev.deletedAt && !merged.deletedAt) merged.deletedAt = prev.deletedAt;
    if (prev.seenAt && !merged.seenAt) merged.seenAt = prev.seenAt;
    map.set(x.id, merged);
  }
  return Array.from(map.values()).sort((a,b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export function mergeMaps(remoteObj, localObj) {
  return { ...(remoteObj && typeof remoteObj === 'object' ? remoteObj : {}), ...(localObj && typeof localObj === 'object' ? localObj : {}) };
}

export function mergeDatabase(remoteRaw, localRaw) {
  const remote = normalizeDb(remoteRaw);
  const local = normalizeDb(localRaw);
  return {
    users: mergeById(remote.users, local.users),
    messages: mergeById(remote.messages, local.messages),
    scheduledMessages: mergeById(remote.scheduledMessages, local.scheduledMessages),
    posts: mergeById(remote.posts, local.posts),
    notifications: mergeById(remote.notifications, local.notifications),
    rtcSignals: mergeById(remote.rtcSignals, local.rtcSignals).slice(-200),
    typing: mergeMaps(remote.typing, local.typing),
    heartbeat: mergeMaps(remote.heartbeat, local.heartbeat),
    meta: { ...remote.meta, ...local.meta, updatedAt: nowMs(), storage: 'github-merge-v3' },
  };
}
