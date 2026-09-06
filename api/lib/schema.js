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

export const DATABASE_BASE_SNAPSHOT = Symbol('priv-spaca-database-base');

function cloneJson(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function databaseWorkingCopy(database) {
  const normalized = normalizeDb(database);
  const base = cloneJson(normalized);
  const working = cloneJson(normalized);
  Object.defineProperty(working, DATABASE_BASE_SNAPSHOT, { value: base, enumerable: false, configurable: false });
  return working;
}

function sameValue(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
}

function arrayItemKey(value) {
  if (value === null || typeof value !== 'object') return `${typeof value}:${String(value)}`;
  if (value.id != null) return `id:${value.id}`;
  if (value.endpoint != null) return `endpoint:${value.endpoint}`;
  if (value.userId != null && value.emoji != null) return `reaction:${value.userId}:${value.emoji}`;
  if (value.userId != null && value.roomId != null) return `user-room:${value.userId}:${value.roomId}`;
  if (value.postId != null && value.userId != null) return `post-user:${value.postId}:${value.userId}`;
  return `json:${JSON.stringify(value)}`;
}

function mergeArrayThreeWay(remote, base, local) {
  if (sameValue(local, base)) return cloneJson(Array.isArray(remote) ? remote : []);
  const r = new Map((Array.isArray(remote) ? remote : []).map(v => [arrayItemKey(v), v]));
  const b = new Map((Array.isArray(base) ? base : []).map(v => [arrayItemKey(v), v]));
  const l = new Map((Array.isArray(local) ? local : []).map(v => [arrayItemKey(v), v]));
  const ordered = [...r.keys(), ...l.keys().filter(k => !r.has(k))];
  const out = [];
  for (const key of ordered) {
    const hasR = r.has(key), hasB = b.has(key), hasL = l.has(key);
    if (hasB && !hasL) continue;
    if (!hasL) { if (hasR) out.push(cloneJson(r.get(key))); continue; }
    if (!hasR) {
      if (!hasB || !sameValue(l.get(key), b.get(key))) out.push(cloneJson(l.get(key)));
      continue;
    }
    out.push(mergeValueThreeWay(r.get(key), hasB ? b.get(key) : undefined, l.get(key)));
  }
  return out;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeValueThreeWay(remote, base, local) {
  if (sameValue(local, base)) return cloneJson(remote);
  if (Array.isArray(local) && Array.isArray(base)) return mergeArrayThreeWay(remote, base, local);
  if (isPlainObject(local) && isPlainObject(base) && isPlainObject(remote)) {
    const out = {};
    const keys = new Set([...Object.keys(remote), ...Object.keys(base), ...Object.keys(local)]);
    for (const key of keys) {
      const hasR = Object.prototype.hasOwnProperty.call(remote, key);
      const hasB = Object.prototype.hasOwnProperty.call(base, key);
      const hasL = Object.prototype.hasOwnProperty.call(local, key);
      if (hasB && !hasL) continue;
      if (!hasL) { if (hasR) out[key] = cloneJson(remote[key]); continue; }
      if (!hasR) {
        if (!hasB || !sameValue(local[key], base[key])) out[key] = cloneJson(local[key]);
        continue;
      }
      out[key] = mergeValueThreeWay(remote[key], hasB ? base[key] : undefined, local[key]);
    }
    return out;
  }
  return cloneJson(local);
}

function mergeEntitiesThreeWay(remote, base, local) {
  const r = new Map((remote || []).filter(x => x && x.id).map(x => [x.id, x]));
  const b = new Map((base || []).filter(x => x && x.id).map(x => [x.id, x]));
  const l = new Map((local || []).filter(x => x && x.id).map(x => [x.id, x]));
  const keys = new Set([...r.keys(), ...b.keys(), ...l.keys()]);
  const out = [];
  for (const key of keys) {
    const hasR = r.has(key), hasB = b.has(key), hasL = l.has(key);
    if (hasB && !hasL) continue;
    if (!hasL) { if (hasR) out.push(cloneJson(r.get(key))); continue; }
    if (!hasR) {
      if (!hasB || !sameValue(l.get(key), b.get(key))) out.push(cloneJson(l.get(key)));
      continue;
    }
    out.push(mergeValueThreeWay(r.get(key), hasB ? b.get(key) : {}, l.get(key)));
  }
  return out.sort((a, b2) => Number(a.createdAt || 0) - Number(b2.createdAt || 0));
}

/** Preserve independent concurrent field/array mutations after a CAS retry. */
export function mergeDatabaseThreeWay(remoteRaw, baseRaw, localRaw) {
  const remote = normalizeDb(remoteRaw), base = normalizeDb(baseRaw), local = normalizeDb(localRaw);
  return {
    users: mergeEntitiesThreeWay(remote.users, base.users, local.users),
    messages: mergeEntitiesThreeWay(remote.messages, base.messages, local.messages),
    scheduledMessages: mergeEntitiesThreeWay(remote.scheduledMessages, base.scheduledMessages, local.scheduledMessages),
    posts: mergeEntitiesThreeWay(remote.posts, base.posts, local.posts),
    notifications: mergeEntitiesThreeWay(remote.notifications, base.notifications, local.notifications),
    rtcSignals: mergeEntitiesThreeWay(remote.rtcSignals, base.rtcSignals, local.rtcSignals).slice(-200),
    typing: mergeValueThreeWay(remote.typing, base.typing, local.typing),
    heartbeat: mergeValueThreeWay(remote.heartbeat, base.heartbeat, local.heartbeat),
    meta: { ...remote.meta, ...local.meta, updatedAt: nowMs(), storage: 'turso-three-way-v1' },
  };
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
