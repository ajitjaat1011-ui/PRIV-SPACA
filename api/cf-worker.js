/**
 * PRIV SPACA — Cloudflare Pages / Workers entry.
 *
 * Hono-based reimplementation of the Express API in api/index.js.
 * Same routes, same input/output, same JWT, same DB layout, same persistence.
 * The Express version (api/index.js) remains for Netlify / local Node.
 *
 * Required compatibility: nodejs_compat (Buffer + crypto + process.env).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Buffer } from 'node:buffer';
import { neon } from '@neondatabase/serverless';

const app = new Hono();
app.use('*', cors());

// ---------- Config (refreshed on every request from c.env) ----------
let JWT_SECRET = 'priv-spaca-dev-secret-change-me';
let GITHUB_PAT = '';
let DATABASE_URL = '';
let GH_REPO    = 'ajitjaat1011-ui/PRIV-SPACA';
let GH_BRANCH  = 'data';
let GH_FILE    = 'db.json';
let VAPID_PUBLIC  = '';
let VAPID_PRIVATE = '';
let VAPID_SUBJECT = 'mailto:admin@priv-spaca.app';
let ADMIN_USERS = 'Arvindjaat1011,ajitjaat1011@gmail.com,arvindjaat1011@gmail.com';
let OWNER_EMAIL = 'ajitjaat1011@gmail.com';
let OWNER_USERNAME = 'Arvindjaat1011';
function loadConfig(env) {
  if (!env) return;
  // Always overwrite — values can change per-deploy
  if (env.JWT_SECRET) JWT_SECRET = env.JWT_SECRET;
  if (env.GITHUB_PAT) GITHUB_PAT = env.GITHUB_PAT;
  if (env.DATABASE_URL) DATABASE_URL = String(env.DATABASE_URL).replace(/&amp;/g, '&');
  if (env.GH_REPO) GH_REPO = env.GH_REPO;
  if (env.GH_BRANCH) GH_BRANCH = env.GH_BRANCH;
  if (env.GH_FILE) GH_FILE = env.GH_FILE;
  if (env.VAPID_PUBLIC_KEY) VAPID_PUBLIC = env.VAPID_PUBLIC_KEY;
  if (env.VAPID_PRIVATE_KEY) VAPID_PRIVATE = env.VAPID_PRIVATE_KEY;
  if (env.VAPID_SUBJECT) VAPID_SUBJECT = env.VAPID_SUBJECT;
  if (env.ADMIN_USERS) ADMIN_USERS = env.ADMIN_USERS;
  if (env.OWNER_EMAIL) OWNER_EMAIL = env.OWNER_EMAIL;
  if (env.OWNER_USERNAME) OWNER_USERNAME = env.OWNER_USERNAME;
}

const JWT_EXPIRES_DAYS = 7;
const PASSWORD_HASH_ROUNDS = 8; // Cloudflare Worker CPU-safe bcrypt cost
// Lower cache TTL on Cloudflare since each request can hit a different isolate
// (no shared memory). Faster TTL = better consistency across concurrent users.
const CACHE_TTL_MS = 500;
const EPHEMERAL_WRITE_INTERVAL_MS = 30000;

// ---------- In-memory cache + DB ----------
let localCache = {
  users: [], messages: [], scheduledMessages: [], posts: [], notifications: [],
  typing: {}, heartbeat: {}, rtcSignals: [],
};
let cacheTimestamp = 0;
let lastEphemeralWrite = 0;
let ghFileSha = null;

// ---------- Helpers ----------
const nowMs = () => Date.now();
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
const uid = (p = 'id') => p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
const safeJson = (s, f) => { try { return JSON.parse(s); } catch (_) { return f; } };
const isRepo = () => !!(GITHUB_PAT && GH_REPO && GH_BRANCH);
const isPersist = () => isRepo();
const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isUsername = s => typeof s === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(s);
const isPin = s => typeof s === 'string' && /^\d{4}$/.test(s);
function sanitizeText(s, max = 4000) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
          .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '')
          .slice(0, max);
}
function isStoryRecord(post) {
  if (!post) return false;
  return !!(post.story === true || post.kind === 'story' || post.storyExpiresAt || post.style || post.music);
}
function storyExpiresAt(post) {
  return Number(post && post.storyExpiresAt) || ((post && post.createdAt) ? (post.createdAt + 24 * 60 * 60 * 1000) : 0);
}
function canViewerSeeStory(post, viewerId, db) {
  if (!isStoryRecord(post)) return true;
  if (!post || post.deletedAt) return false;
  if (storyExpiresAt(post) <= nowMs()) return false;
  if (post.userId === viewerId) return true;
  if ((post.audience || 'all') !== 'close_friends') return true;
  const author = (db.users || []).find(u => u.id === post.userId);
  const closeFriends = Array.isArray(author && author.closeFriends) ? author.closeFriends : [];
  return closeFriends.includes(viewerId);
}
function sanitizeUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, username: u.username, displayName: u.displayName,
           bio: u.bio || '', photoUrl: u.photoUrl || '', createdAt: u.createdAt,
           publicKey: u.publicKey || null };
}

function adminSet() {
  return new Set(String(ADMIN_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
}
function isAdminUser(u) {
  if (!u) return false;
  const set = adminSet();
  return set.has(String(u.username || '').toLowerCase()) || set.has(String(u.email || '').toLowerCase()) || set.has(String(u.id || '').toLowerCase());
}
async function requireAdmin(c, next) {
  const auth = await requireAuth(c, async () => {});
  if (auth instanceof Response) return auth;
  const db = await fetchDatabase({ fresh: true });
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!isAdminUser(u)) return c.json({ error: 'Admin only' }, 403);
  c.set('adminUser', u);
  c.set('adminDb', db);
  await next();
}


// ---------- Neon PostgreSQL JSON storage (primary) ----------
let _neonSql = null;
let _neonReady = false;
function isNeonConfigured() { return !!DATABASE_URL; }
function neonClient() {
  if (!_neonSql) _neonSql = neon(DATABASE_URL);
  return _neonSql;
}
async function neonEnsure() {
  if (!isNeonConfigured()) return false;
  if (_neonReady) return true;
  const sql = neonClient();
  await sql`CREATE TABLE IF NOT EXISTS priv_spaca_kv (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  const rows = await sql`SELECT value FROM priv_spaca_kv WHERE key = 'db'`;
  if (rows.length === 0) {
    const empty = normalizeDb({ users: [], messages: [], scheduledMessages: [], posts: [], notifications: [], typing: {}, heartbeat: {}, rtcSignals: [], meta: { storage: 'neon-json-v1', createdAt: Date.now() } });
    await sql`INSERT INTO priv_spaca_kv (key, value) VALUES ('db', ${JSON.stringify(empty)}::jsonb)`;
  }
  _neonReady = true;
  return true;
}
async function neonReadDb() {
  if (!isNeonConfigured()) return null;
  await neonEnsure();
  const rows = await neonClient()`SELECT value FROM priv_spaca_kv WHERE key = 'db'`;
  if (!rows || rows.length === 0) return normalizeDb({});
  const val = rows[0].value;
  return typeof val === 'string' ? safeJson(val, normalizeDb({})) : val;
}
async function neonWriteDb(dbObj) {
  if (!isNeonConfigured()) return false;
  await neonEnsure();
  const db = normalizeDb(dbObj);
  db.meta = { ...(db.meta || {}), storage: 'neon-json-v1', updatedAt: Date.now() };
  await neonClient()`INSERT INTO priv_spaca_kv (key, value, updated_at)
    VALUES ('db', ${JSON.stringify(db)}::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
  return true;
}
async function neonResetDb() {
  if (!isNeonConfigured()) return false;
  await neonEnsure();
  const empty = normalizeDb({ users: [], messages: [], scheduledMessages: [], posts: [], notifications: [], typing: {}, heartbeat: {}, rtcSignals: [], meta: { storage: 'neon-json-v1', resetAt: Date.now() } });
  await neonWriteDb(empty);
  localCache = empty;
  cacheTimestamp = Date.now();
  return true;
}

// ---------- GitHub repo persistence ----------

async function repoRead() {
  if (isNeonConfigured()) return await neonReadDb();
  if (!isRepo()) return null;
  try {
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${encodeURIComponent(GH_BRANCH)}&_=${Date.now()}`;
    
    // Read JSON directly from GitHub Contents API. Avoid raw.githubusercontent/raw
    // responses because they can be stale and caused login to say account not found.
    const rSha = await fetch(url, {
      headers: { Authorization: 'token ' + GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json', 'Cache-Control': 'no-cache' },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!rSha.ok) return { _httpError: rSha.status, txt: await rSha.text() };
    const dSha = await rSha.json();
    if (dSha && dSha.sha) ghFileSha = dSha.sha;
    if (!dSha || !dSha.content) return null;
    const b64 = String(dSha.content || '').replace(/\n/g, '');
    const text = Buffer.from(b64, dSha.encoding || 'base64').toString('utf8');
    return safeJson(text, { _err: 'Invalid JSON', _textPreview: text.slice(0, 100) });
  } catch (e) {
    return { _err: e.message, _stack: e.stack };
  }
}
async function repoWrite(dbObj) {
  if (isNeonConfigured()) return await neonWriteDb(dbObj);
  if (!isRepo()) return false;
  try {
    if (!ghFileSha) await repoRead();
    const str = JSON.stringify(dbObj); const bytes = new TextEncoder().encode(str); let binStr = ''; for(let i=0; i<bytes.byteLength; i++) binStr += String.fromCharCode(bytes[i]); const content = btoa(binStr);
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}`;
    const doPut = async (sha) => {
      const body = { message: 'priv-spaca sync ' + new Date().toISOString(), content, branch: GH_BRANCH };
      if (sha) body.sha = sha;
      return fetch(url, {
        method: 'PUT',
        headers: { Authorization: 'token ' + GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    };
    let r = await doPut(ghFileSha);
    // Do NOT retry conflicts here with the same stale content. Return false so
    // saveDatabase() can re-read, merge, and then retry with unioned data.
    if (r.status === 409 || r.status === 422) {
      const t = await r.text().catch(() => '');
      console.warn('[repoWrite conflict]', r.status, t.slice(0, 120));
      ghFileSha = null;
      return false;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[repoWrite]', r.status, t.slice(0, 200));
      return false;
    }
    const j = await r.json();
    if (j && j.content && j.content.sha) ghFileSha = j.content.sha;
    return true;
  } catch (e) { console.error('[repoWrite]', e.message); return false; }
}

function runScheduler(db) {
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

function normalizeDb(remote) {
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

function mergeById(remoteArr, localArr) {
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
function mergeMaps(remoteObj, localObj) {
  return { ...(remoteObj && typeof remoteObj === 'object' ? remoteObj : {}), ...(localObj && typeof localObj === 'object' ? localObj : {}) };
}
function mergeDatabase(remoteRaw, localRaw) {
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

async function ensureOwnerAccount(db) { return false; }


async function fetchDatabase({ fresh = false } = {}) {
  const now = nowMs();
  if (!fresh && now - cacheTimestamp < CACHE_TTL_MS && cacheTimestamp !== 0) {
    runScheduler(localCache);
    return localCache;
  }
  const remote = await repoRead();
  if (remote && typeof remote === 'object' && !remote._httpError && !remote._err) {
    localCache = normalizeDb(remote);
  }
  const ownerSeeded = await ensureOwnerAccount(localCache);
  cacheTimestamp = now;
  const changed = runScheduler(localCache) || ownerSeeded;
  if (changed) await saveDatabase(localCache, false);
  return localCache;
}

async function saveDatabase(data, isEphemeral = false) {
  localCache = data;
  cacheTimestamp = nowMs();
  if (!isPersist()) return true;
  // The 30s ephemeral-write throttle exists to protect GitHub API rate limits.
  // Neon Postgres has no such constraint, so skip the throttle when Neon is
  // the active backend — otherwise heartbeat/typing indicators are silently
  // dropped almost all the time (they still report {ok:true} to the client,
  // which is misleading and breaks the "who's typing" / online-status UI).
  if (isEphemeral && !isNeonConfigured()) {
    const now = nowMs();
    if (now - lastEphemeralWrite < EPHEMERAL_WRITE_INTERVAL_MS) return true;
    lastEphemeralWrite = now;
    repoWrite(data).catch(() => {});
    return true;
  }
  if (isEphemeral && isNeonConfigured()) {
    // Write directly to Neon and await it. We intentionally do NOT use a
    // fire-and-forget pattern here: Cloudflare Workers can terminate
    // un-awaited promises as soon as the HTTP response is sent, which was
    // silently dropping heartbeat/typing writes. Neon writes are fast
    // (single UPSERT), so awaiting adds negligible latency.
    try {
      await neonWriteDb(data);
    } catch (_) { /* best-effort; ephemeral data, ok to lose occasionally */ }
    return true;
  }
  // Merge with the newest remote DB before writing. This prevents a later request
  // from overwriting a user/message/post created by an earlier request.
  let toWrite = data;
  const remoteBeforeWrite = await repoRead();
  if (remoteBeforeWrite && typeof remoteBeforeWrite === 'object' && !remoteBeforeWrite._httpError && !remoteBeforeWrite._err) {
    toWrite = mergeDatabase(remoteBeforeWrite, data);
  }
  let ok = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await sleepMs(250 + attempt * 350);
      ghFileSha = null;
      const latest = await repoRead();
      if (latest && typeof latest === 'object' && !latest._httpError && !latest._err) {
        toWrite = mergeDatabase(latest, toWrite);
      }
    }
    ok = await repoWrite(toWrite);
    if (ok) break;
  }
  if (ok) { localCache = normalizeDb(toWrite); cacheTimestamp = nowMs(); }
  return ok;
}

async function saveDatabaseVerified(data, verifyFn, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const ok = await saveDatabase(data, false);
    if (ok) {
      await sleepMs(300 + i * 350);
      cacheTimestamp = 0;
      const fresh = await repoRead();
      if (fresh && typeof fresh === 'object' && !fresh._httpError && !fresh._err && (!verifyFn || verifyFn(normalizeDb(fresh)))) {
        localCache = normalizeDb(fresh);
        cacheTimestamp = nowMs();
        return true;
      }
      // Re-merge local data with whatever remote currently has, then try again.
      if (fresh && typeof fresh === 'object' && !fresh._httpError && !fresh._err) data = mergeDatabase(fresh, data);
    }
    await sleepMs(500 + i * 500);
  }
  return false;
}

// ---------- Bcrypt + JWT (using pure-JS for Workers compat) ----------
// bcryptjs works natively in Workers (pure JS, no native bindings).
import bcrypt from 'bcryptjs';

// Manual JWT (HS256) — avoids jsonwebtoken which uses Node-specific bits
async function hmacSha256(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function b64url(buf) {
  let s = '';
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}
function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}
async function signToken(user) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + JWT_EXPIRES_DAYS * 24 * 3600;
  const payload = { uid: user.id, username: user.username, iat, exp };
  const head = b64urlJson(header);
  const body = b64urlJson(payload);
  const sig = b64url(await hmacSha256(JWT_SECRET, head + '.' + body));
  return head + '.' + body + '.' + sig;
}
async function verifyToken(token) {
  if (!token || typeof token !== 'string') throw new Error('No token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Bad token');
  const [head, body, sig] = parts;
  const expected = b64url(await hmacSha256(JWT_SECRET, head + '.' + body));
  if (expected !== sig) throw new Error('Bad signature');
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch (_) { throw new Error('Bad payload'); }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) throw new Error('Expired');
  return payload;
}

async function authFromRequest(c) {
  const auth = c.req.header('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try { return await verifyToken(token); } catch (_) { return null; }
}

// Hono middleware
async function requireAuth(c, next) {
  const p = await authFromRequest(c);
  if (!p) return c.json({ error: 'Missing or invalid token' }, 401);
  c.set('userId', p.uid);
  c.set('username', p.username);
  await next();
}

// ---------- Rate limiting ----------
const _rateBuckets = new Map();
function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let b = _rateBuckets.get(key);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + windowMs }; _rateBuckets.set(key, b); }
  b.count++;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}
function clientIp(c) {
  return c.req.header('cf-connecting-ip')
      || (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
      || c.req.header('x-real-ip') || '0.0.0.0';
}
async function authRateLimit(c, next) {
  const ip = clientIp(c);
  const r = rateLimit({ key: 'auth:' + ip + ':' + c.req.path, limit: 10, windowMs: 15 * 60_000 });
  if (!r.allowed) {
    c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
    return c.json({ error: 'Too many auth attempts. Try again in 15 minutes.' }, 429);
  }
  await next();
}
async function globalRateLimit(c, next) {
  const ip = clientIp(c);
  const r = rateLimit({ key: 'global:' + ip, limit: 120, windowMs: 60_000 });
  c.header('X-RateLimit-Limit', '120');
  c.header('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) {
    c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
    return c.json({ error: 'Too many requests. Please slow down.' }, 429);
  }
  await next();
}

// Brute-force lockout
const _loginFails = new Map();
function checkAccountLock(userId) {
  const rec = _loginFails.get(userId);
  if (!rec) return { locked: false };
  const now = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > now) return { locked: true, remaining: rec.lockedUntil - now };
  return { locked: false };
}
function recordLoginFail(userId) {
  const now = Date.now();
  let rec = _loginFails.get(userId);
  if (!rec || (now - rec.firstAt) > 5 * 60_000) { rec = { count: 0, firstAt: now }; _loginFails.set(userId, rec); }
  rec.count++;
  if (rec.count >= 5) rec.lockedUntil = now + 15 * 60_000;
}
function clearLoginFails(userId) { _loginFails.delete(userId); }

// ---------- Real-time events (in-memory; SSE per-request) ----------
const _eventQueues = new Map();
const _eventSubscribers = new Map();
function _pushEvent(userId, kind, data) {
  if (!userId) return;
  const evt = { id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), ts: Date.now(), kind, data };
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
  return evt;
}
function _broadcastEvent(kind, data, excludeUserId) {
  for (const userId of new Set([..._eventSubscribers.keys(), ..._eventQueues.keys()])) {
    if (userId === excludeUserId) continue;
    _pushEvent(userId, kind, data);
  }
}

// ---------- Notifications + Web Push ----------
function pushNotification(db, recipientId, kind, fromUserId, extra = {}) {
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
  if (body) sendWebPush(db, recipientId, { title, body, tag: 'priv-spaca-' + notif.id, url: '/', kind, notifId: notif.id }).catch(() => {});
  return notif;
}

// ============================================================
// Web Push via VAPID — native WebCrypto implementation
// Implements:
//   - VAPID JWT (ES256) signing using the existing P-256 keys
//   - aes128gcm payload encryption per RFC 8291
//   - HTTP POST to the subscription endpoint (FCM/Mozilla/etc.)
// No npm deps; runs on Cloudflare Workers.
// ============================================================

// ---- Base64URL helpers (work on Uint8Array or string) ----
function _b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function _concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---- VAPID ES256 JWT signing using the configured P-256 private key ----
// VAPID_PRIVATE is the raw 32-byte d (base64url). Public is uncompressed 65-byte point.
async function _importVapidKey() {
  const d = _b64urlDecode(VAPID_PRIVATE);
  const pub = _b64urlDecode(VAPID_PUBLIC); // 0x04 || X(32) || Y(32)
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('Bad VAPID public key');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: _b64urlEncode(d),
    x: _b64urlEncode(pub.slice(1, 33)),
    y: _b64urlEncode(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function _signVapidJwt(audience, expSeconds) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: expSeconds, sub: VAPID_SUBJECT };
  const enc = new TextEncoder();
  const headerB64 = _b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = _b64urlEncode(enc.encode(JSON.stringify(payload)));
  const data = enc.encode(headerB64 + '.' + payloadB64);
  const key = await _importVapidKey();
  // WebCrypto ECDSA produces raw r||s (64 bytes), which is what VAPID expects.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return headerB64 + '.' + payloadB64 + '.' + _b64urlEncode(new Uint8Array(sig));
}

// ---- aes128gcm Web Push encryption per RFC 8291 ----
async function _hkdf(salt, ikm, info, length) {
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    length * 8
  ));
}

async function _encryptPushPayload(subscription, payloadBytes) {
  // Receiver keys from the subscription
  const ua_public = _b64urlDecode(subscription.keys.p256dh); // 65 bytes uncompressed
  const auth_secret = _b64urlDecode(subscription.keys.auth); // 16 bytes

  // Ephemeral sender keypair (ES = sender)
  const esKeypair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const esPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', esKeypair.publicKey)); // 65 bytes

  // Import receiver public key for ECDH
  const uaPubKey = await crypto.subtle.importKey(
    'raw',
    ua_public,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPubKey },
    esKeypair.privateKey,
    256
  ));

  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || es_public, 32)
  const enc = new TextEncoder();
  const keyInfo = _concatBytes(
    enc.encode('WebPush: info\0'),
    ua_public,
    esPublicRaw
  );
  const ikm = await _hkdf(auth_secret, sharedSecret, keyInfo, 32);

  // Random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // CEK = HKDF(salt, IKM, "Content-Encoding: aes128gcm\0", 16)
  const cek = await _hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  // Nonce = HKDF(salt, IKM, "Content-Encoding: nonce\0", 12)
  const nonce = await _hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Padded plaintext: payload || 0x02 (delimiter for last record) + zero pad to record size
  // (We send a single record; the 0x02 byte marks "last").
  const padded = _concatBytes(payloadBytes, new Uint8Array([0x02]));

  // AES-128-GCM encrypt
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    padded
  ));

  // Build aes128gcm content-coding header:
  //   salt(16) || rs(4 big-endian) || idlen(1) || keyid(idlen) || ciphertext
  // For Web Push, keyid = es_public_raw (65 bytes), so idlen = 65.
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  // record size as 4-byte big-endian uint32
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>>  8) & 0xff;
  header[19] = (rs       ) & 0xff;
  header[20] = 65;
  header.set(esPublicRaw, 21);

  return _concatBytes(header, ciphertext);
}

async function sendWebPush(db, recipientId, payload) {
  try {
    if (!VAPID_PRIVATE || !VAPID_PUBLIC) return;
    const user = (db && db.users || []).find(u => u.id === recipientId);
    if (!user || !user.pushSubs || user.pushSubs.length === 0) return;

    const bodyStr = JSON.stringify(payload || {});
    const bodyBytes = new TextEncoder().encode(bodyStr);

    // Process each subscription in parallel; prune expired ones (404/410)
    const dead = [];
    await Promise.all(user.pushSubs.map(async (sub) => {
      try {
        if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return;
        const url = new URL(sub.endpoint);
        const audience = url.origin;
        const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12h
        const jwt = await _signVapidJwt(audience, exp);

        const cipher = await _encryptPushPayload(sub, bodyBytes);

        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            'TTL': '86400',
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
            'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
            'Urgency': 'normal',
          },
          body: cipher,
        });
        if (res.status === 404 || res.status === 410) {
          dead.push(sub.endpoint);
        } else if (!res.ok && res.status >= 400) {
          // Log but don't fail
          console.warn('[push] non-OK', res.status, sub.endpoint.slice(0, 60));
        }
      } catch (e) {
        console.warn('[push] err', e && e.message);
      }
    }));

    // Prune expired subscriptions (best-effort write; don't block)
    if (dead.length) {
      try {
        const fresh = await fetchDatabase();
        const u = fresh.users.find(x => x.id === recipientId);
        if (u && u.pushSubs) {
          u.pushSubs = u.pushSubs.filter(s => !dead.includes(s.endpoint));
          await saveDatabase(fresh, false);
        }
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[sendWebPush] outer err', e && e.message);
  }
}

// ---------- Rooms ----------
function normalizeRoomId(roomId, currentUserId) {
  if (!roomId) return 'general-group';
  if (roomId === 'general-group' || roomId.startsWith('group:')) return roomId;
  if (roomId.startsWith('dm:')) {
    const parts = roomId.slice(3).split(':');
    if (parts.length === 2) return 'dm:' + [...parts].sort().join(':');
  }
  return roomId;
}
function dmRoomFor(a, b) { return 'dm:' + [a, b].sort().join(':'); }

// ---------- Middleware: load config + security headers + global rate limit ----------
app.use('*', async (c, next) => {
  loadConfig(c.env);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  await next();
});
app.use('/api/*', globalRateLimit);

// =====================================================================
// ROUTES
// =====================================================================

// ---------- Health & diag ----------
app.get('/api/health', (c) => c.json({
  ok: true, name: 'PRIV SPACA',
  persistence: isNeonConfigured() ? 'neon-postgres' : (isRepo() ? 'github-repo' : 'in-memory'),
  runtime: 'cloudflare-workers',
  time: nowMs(), version: 'phase1-neon-json-storage',
}));

app.get('/api/diag', async (c) => {
  const out = {
    persistence: isNeonConfigured() ? 'neon-postgres' : (isRepo() ? 'github-repo' : 'in-memory'),
    repoConfigured: isRepo(), gistConfigured: false,
    repo: GH_REPO, branch: GH_BRANCH, file: GH_FILE,
    canRead: false, canWrite: false, userCount: 0, error: null,
    runtime: 'cloudflare-workers',
  };
  try {
    const db = await repoRead();
    if (db && typeof db === 'object' && !db._err && !db._httpError) {
      out.canRead = true;
      out.userCount = (db.users || []).length;
      // Do not perform a real write in diagnostics; it can conflict with signup/message saves.
      out.canWrite = !!GITHUB_PAT;
    } else if (!isPersist()) {
      out.canRead = true; out.canWrite = true;
      out.userCount = (localCache.users || []).length;
    } else out.error = db ? (db._err || db._httpError || 'Read returned no data (not an array)') : 'Read returned no data';
  } catch (e) { out.error = e.message; }
  return c.json(out);
});

// ---------- Auth: signup ----------
app.post('/api/auth/signup', authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { email, username, displayName, password, pin, termsAccepted, termsVersion } = body;
    if (!isEmail(email)) return c.json({ error: 'Invalid email' }, 400);
    if (!isUsername(username)) return c.json({ error: 'Username must be 3-24 chars (letters, numbers, _)' }, 400);
    const cleanDN = sanitizeText(displayName || '', 60).trim();
    if (!cleanDN) return c.json({ error: 'Display name required' }, 400);
    if (!password || password.length < 6) return c.json({ error: 'Password must be at least 6 characters' }, 400);
    if (password.length > 128) return c.json({ error: 'Password too long (max 128)' }, 400);
    if (!isPin(pin)) return c.json({ error: 'PIN must be 4 digits' }, 400);
    const weak = new Set(['0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321','0123','2580','1212','1313','1010','0101','1122','1221','2024','2025','2026','2027','0007','1357','2468','9876','6789']);
    if (weak.has(pin)) return c.json({ error: 'Please choose a less obvious PIN' }, 400);
    if (termsAccepted !== true) return c.json({ error: 'You must accept the Terms & Community Guidelines.' }, 400);

    const db = await fetchDatabase({ fresh: true });
    const emailLower = email.toLowerCase();
    const usernameLower = username.toLowerCase();
    if (db.users.some(u => u.email.toLowerCase() === emailLower)) return c.json({ error: 'Email already registered' }, 409);
    if (db.users.some(u => u.username.toLowerCase() === usernameLower)) return c.json({ error: 'Username already taken' }, 409);
    const reserved = new Set(['admin','administrator','priv-spaca','privspaca','support','system','moderator','staff','help','root']);
    if (reserved.has(usernameLower)) return c.json({ error: 'That username is reserved' }, 403);

    const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
    const pinHash = await bcrypt.hash(pin, PASSWORD_HASH_ROUNDS);
    const newUser = {
      id: uid('usr'), email: emailLower, username, displayName: cleanDN,
      bio: '', photoUrl: '', passwordHash, pinHash,
      followers: [], following: [], blocked: [], closeFriends: [],
      termsAccepted: true, termsVersion: String(termsVersion || '1.0'),
      termsAcceptedAt: nowMs(), createdAt: nowMs(),
    };
    db.users.push(newUser);
    const persisted = await saveDatabaseVerified(db, d => (d.users || []).some(u => u.id === newUser.id));
    if (isPersist() && !persisted) {
      db.users = db.users.filter(u => u.id !== newUser.id);
      return c.json({ error: 'Storage temporarily unavailable. Please try again in a moment.' }, 503);
    }
    const token = await signToken(newUser);
    return c.json({ token, user: sanitizeUser(newUser) });
  } catch (e) {
    console.error('[signup]', e);
    return c.json({ error: 'Signup failed: ' + (e.message || 'unknown') }, 500);
  }
});

// ---------- Auth: login ----------
app.post('/api/auth/login', authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { identifier, password } = body;
    if (!identifier || !password) return c.json({ error: 'Missing credentials' }, 400);
    if (typeof password !== 'string' || password.length > 128) return c.json({ error: 'Invalid credentials' }, 400);
    const db = await fetchDatabase({ fresh: true });
    const idLower = String(identifier).toLowerCase().trim();
    const user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    if (!user) {
      await new Promise(r => setTimeout(r, 200 + Math.random() * 100));
      return c.json({ error: 'Account not found. Check username/email or sign up again.' }, 404);
    }
    const lock = checkAccountLock(user.id);
    if (lock.locked) {
      const mins = Math.ceil(lock.remaining / 60_000);
      return c.json({ error: `Account temporarily locked due to failed attempts. Try again in ${mins} minute(s).` }, 423);
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) { recordLoginFail(user.id); return c.json({ error: 'Wrong password. Use Forgot with your 4-digit PIN to reset it.' }, 401); }
    clearLoginFails(user.id);
    const token = await signToken(user);
    return c.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    console.error('[login]', e);
    return c.json({ error: 'Login failed' }, 500);
  }
});

// ---------- Auth: reset by PIN ----------
app.post('/api/auth/reset-by-pin', authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { identifier, pin, newPassword } = body;
    if (!identifier || !isPin(pin) || !newPassword || newPassword.length < 6) {
      return c.json({ error: 'Invalid reset payload' }, 400);
    }
    const db = await fetchDatabase({ fresh: true });
    const idLower = String(identifier).toLowerCase().trim();
    const user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    if (!user) return c.json({ error: 'Account not found' }, 404);
    const pinOk = await bcrypt.compare(pin, user.pinHash);
    if (!pinOk) return c.json({ error: 'Incorrect PIN' }, 401);
    const oldHash = user.passwordHash;
    user.passwordHash = await bcrypt.hash(newPassword, PASSWORD_HASH_ROUNDS);
    const persisted = await saveDatabaseVerified(db, d => {
      const u2 = (d.users || []).find(u => u.id === user.id);
      return !!u2 && u2.passwordHash === user.passwordHash;
    });
    if (isPersist() && !persisted) { user.passwordHash = oldHash; return c.json({ error: 'Storage temporarily unavailable' }, 503); }
    const token = await signToken(user);
    return c.json({ ok: true, token, user: sanitizeUser(user) });
  } catch (e) {
    console.error('[reset]', e);
    return c.json({ error: 'Reset failed: ' + (e.message || 'unknown') }, 500);
  }
});

// ---------- Auth: me ----------
app.get('/api/auth/me', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!u) return c.json({ error: 'Not found' }, 404);
  return c.json({ user: sanitizeUser(u) });
});

// ---------- Upload photo (to GitHub CDN) ----------
app.post('/api/upload-photo', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { dataUrl, kind } = body;
    if (typeof dataUrl !== 'string' || (!dataUrl.startsWith('data:image/') && !dataUrl.startsWith('data:audio/') && !dataUrl.startsWith('data:video/'))) {
      return c.json({ error: 'Send a data URL: data:image/... , data:audio/... or data:video/...' }, 400);
    }
    const m = dataUrl.match(/^data:(image|audio|video)\/(jpeg|jpg|png|webp|gif|webm|mp3|mp4|quicktime|mov);base64,(.+)$/);
    if (!m) return c.json({ error: 'Unsupported media type' }, 400);
    const isVideo = m[1] === 'video';
    let ext = m[2] === 'jpeg' ? 'jpg' : (m[2] === 'quicktime' ? 'mov' : m[2]);
    const b64 = m[3];
    const size = Math.floor(b64.length * 3 / 4);
    // Videos get a larger cap (short story clips); images/audio stay at 5 MB.
    const maxBytes = isVideo ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (size > maxBytes) return c.json({ error: (isVideo ? 'Video too large (max 10 MB)' : 'Image too large (max 5 MB)') }, 413);
    const userId = c.get('userId');
    const safeKind = (kind === 'post' || kind === 'avatar') ? kind : 'media';
    const folder = safeKind === 'avatar' ? 'avatars' : (safeKind === 'post' ? 'posts' : 'media');
    const id = safeKind === 'avatar' ? userId : uid(isVideo ? 'vid' : 'img');
    const path = `media/${folder}/${id}.${ext}`;
    if (!isRepo()) return c.json({ url: dataUrl, persisted: false });
    let priorSha = null;
    try {
      const h = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`, {
        headers: { Authorization: 'token ' + GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json' },
      });
      if (h.ok) { const j = await h.json(); priorSha = j.sha || null; }
    } catch (_) {}
    const putBody = { message: `upload ${safeKind} ${id}`, content: b64, branch: GH_BRANCH };
    if (priorSha) putBody.sha = priorSha;
    const put = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { Authorization: 'token ' + GITHUB_PAT, 'User-Agent': 'PRIV-SPACA', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });
    if (!put.ok) {
      const t = await put.text().catch(() => '');
      console.error('[upload]', put.status, t.slice(0, 200));
      return c.json({ url: dataUrl, persisted: false, warning: 'GitHub upload failed; using inline data URL.' });
    }
    const cdn = `https://raw.githubusercontent.com/${GH_REPO}/${encodeURIComponent(GH_BRANCH)}/${path}?t=${Date.now()}`;
    return c.json({ url: cdn, persisted: true });
  } catch (e) {
    console.error('[upload]', e);
    return c.json({ error: 'Upload failed: ' + (e.message || 'unknown') }, 500);
  }
});

// ---------- User update ----------
app.post('/api/user/update', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { displayName, username, bio, photoUrl } = body;
    const db = await fetchDatabase();
    const user = db.users.find(u => u.id === c.get('userId'));
    if (!user) return c.json({ error: 'Not found' }, 404);
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
    if (typeof photoUrl === 'string' && photoUrl.length <= 4096) {
      if (photoUrl === '' || /^(https?:|data:image\/)/i.test(photoUrl)) user.photoUrl = photoUrl;
    }
    await saveDatabase(db, false);
    return c.json({ user: sanitizeUser(user) });
  } catch (e) { console.error('[user/update]', e); return c.json({ error: 'Update failed' }, 500); }
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
    const { targetId, action } = await c.req.json().catch(() => ({}));
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
    return c.json({ ids: me.closeFriends, added: me.closeFriends.includes(targetId) });
  } catch (e) { console.error('[close-friends]', e); return c.json({ error: 'Update failed' }, 500); }
});

// ---------- Users list ----------
app.get('/api/users', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const myId = c.get('userId');
  const me = db.users.find(u => u.id === myId);
  const myBlocked = new Set((me && me.blocked) || []);
  const blockedMe = new Set();
  db.users.forEach(u => {
    if (u.id !== myId && Array.isArray(u.blocked) && u.blocked.includes(myId)) blockedMe.add(u.id);
  });
  const now = nowMs();
  const list = db.users
    .filter(u => !myBlocked.has(u.id) && !blockedMe.has(u.id))
    .map(u => ({ ...sanitizeUser(u), online: now - (db.heartbeat[u.id] || 0) < 45000, lastSeen: db.heartbeat[u.id] || 0 }));
  return c.json({ users: list });
});

// ---------- E2E public key (Part 3) ----------
// Each user uploads their ECDH P-256 public key (base64url, raw 65 bytes uncompressed)
// once on first login. Private key stays in the browser's IndexedDB.
app.post('/api/user/public-key', requireAuth, async (c) => {
  try {
    const { publicKey } = await c.req.json().catch(() => ({}));
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
  } catch (e) { console.error('[public-key]', e); return c.json({ error: 'Save failed' }, 500); }
});

app.get('/api/user/public-key', requireAuth, async (c) => {
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'userId required' }, 400);
  let db = await fetchDatabase();
  let u = db.users.find(x => x.id === userId);
  // Cross-isolate consistency: if user has no key yet (or user not found),
  // force a fresh read from GitHub in case the upload just happened elsewhere.
  if (!u || !u.publicKey) {
    cacheTimestamp = 0;
    db = await fetchDatabase();
    u = db.users.find(x => x.id === userId);
  }
  if (!u) return c.json({ error: 'Not found' }, 404);
  return c.json({ userId: u.id, publicKey: u.publicKey || null });
});

// ---------- Heartbeat & typing ----------
app.post('/api/user/heartbeat', requireAuth, async (c) => {
  const db = await fetchDatabase();
  db.heartbeat[c.get('userId')] = nowMs();
  await saveDatabase(db, true);
  return c.json({ ok: true });
});
app.post('/api/user/typing', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.roomId) return c.json({ error: 'roomId required' }, 400);
  const db = await fetchDatabase();
  if (!db.typing[body.roomId]) db.typing[body.roomId] = {};
  db.typing[body.roomId][c.get('userId')] = nowMs();
  await saveDatabase(db, true);
  return c.json({ ok: true });
});
app.get('/api/user/typing', requireAuth, async (c) => {
  const roomId = c.req.query('roomId');
  if (!roomId) return c.json({ error: 'roomId required' }, 400);
  const db = await fetchDatabase();
  const map = db.typing[roomId] || {};
  const now = nowMs();
  const myId = c.get('userId');
  const typing = Object.keys(map).filter(uid2 => uid2 !== myId && now - map[uid2] < 4000)
    .map(id => {
      const u = db.users.find(x => x.id === id);
      return u ? { id: u.id, username: u.username, displayName: u.displayName } : null;
    }).filter(Boolean);
  return c.json({ typing });
});

// ---------- Messages ----------
app.get('/api/messages', requireAuth, async (c) => {
  cacheTimestamp = 0; // force fresh GitHub read for chat reliability across Cloudflare isolates
  const roomId = normalizeRoomId(c.req.query('roomId') || 'general-group', c.get('userId'));
  if (roomId.startsWith('dm:')) {
    const parts = roomId.slice(3).split(':');
    if (!parts.includes(c.get('userId'))) return c.json({ error: 'Forbidden' }, 403);
  }
  let db = await fetchDatabase({ fresh: true });
  let now = nowMs();
  let list = db.messages
    .filter(m => m.roomId === roomId && !m.deletedAt && !(m.disappearAt && m.disappearAt <= now))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-200);
  // GitHub contents can be briefly eventually-consistent across isolates. For chat,
  // do a short fresh retry instead of returning an empty room right after send.
  if (list.length === 0 && roomId.startsWith('dm:')) {
    await sleepMs(900); cacheTimestamp = 0; db = await fetchDatabase({ fresh: true }); now = nowMs();
    list = db.messages
      .filter(m => m.roomId === roomId && !m.deletedAt && !(m.disappearAt && m.disappearAt <= now))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-200);
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
    const body = await c.req.json().catch(() => ({}));
    const {
      roomId: raw, text, imageUrl, replyTo, targetUserId,
      encrypted, cipher, iv,                  // E2E payload (Part 3)
      disappearAfterMs,                       // disappearing messages (Part 3)
    } = body;
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
    const ci = typeof imageUrl === 'string' && imageUrl.length <= 4096 ? imageUrl : null;
    if (!ct && !ci && !isEncrypted) return c.json({ error: 'Empty message' }, 400);

    // Disappearing TTL (clamp to 10s..24h)
    let disappearAt = null;
    if (typeof disappearAfterMs === 'number' && disappearAfterMs > 0) {
      const ms = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, disappearAfterMs));
      disappearAt = nowMs() + ms;
    }

    const db = await fetchDatabase();
    let replyRef = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.id) {
      replyRef = {
        id: replyTo.id,
        text: typeof replyTo.text === 'string' ? replyTo.text.slice(0, 200) : '',
        username: typeof replyTo.username === 'string' ? replyTo.username.slice(0, 60) : '',
        imageUrl: typeof replyTo.imageUrl === 'string' ? replyTo.imageUrl.slice(0, 2048) : null,
      };
    }
    const author = db.users.find(u => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
    const msg = {
      id: uid('msg'), roomId, userId: myId,
      text: ct, imageUrl: ci, replyTo: replyRef, authorSnapshot: snap, createdAt: nowMs(),
    };
    if (isEncrypted) { msg.encrypted = true; msg.cipher = cipher; msg.iv = iv; }
    if (disappearAt) { msg.disappearAt = disappearAt; msg.disappearAfterMs = disappearAfterMs; }
    db.messages.push(msg);

    const enriched = { ...msg, author: snap || { id: myId, displayName: 'Member', username: 'member' } };
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      parts.filter(uid2 => uid2 !== myId).forEach(recip => {
        _pushEvent(recip, 'new_message', { roomId, message: enriched });
        // For E2E messages, server never sees plaintext → push preview is generic
        const previewText = isEncrypted ? '🔒 Encrypted message' : (ct || (ci ? '📷 Photo' : ''));
        pushNotification(db, recip, 'message', myId, { text: previewText.slice(0, 80) });
      });
    } else {
      _broadcastEvent('new_message', { roomId, message: enriched }, myId);
    }
    const persisted = await saveDatabaseVerified(db, d => (d.messages || []).some(m => m.id === msg.id));
    if (isPersist() && !persisted) return c.json({ error: 'Message storage unavailable. Please retry.' }, 503);
    return c.json({ message: enriched });
  } catch (e) { console.error('[send]', e); return c.json({ error: 'Send failed' }, 500); }
});

app.post('/api/messages/delete', requireAuth, async (c) => {
  try {
    const { messageId } = await c.req.json().catch(() => ({}));
    if (!messageId) return c.json({ error: 'messageId required' }, 400);
    const db = await fetchDatabase();
    const m = db.messages.find(x => x.id === messageId);
    if (!m) return c.json({ error: 'Not found' }, 404);
    if (m.userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
    m.deletedAt = nowMs();
    await saveDatabase(db, false);
    return c.json({ ok: true, undoUntil: m.deletedAt + 30 * 24 * 3600 * 1000 });
  } catch (e) { console.error('[delmsg]', e); return c.json({ error: 'Delete failed' }, 500); }
});
app.post('/api/messages/restore', requireAuth, async (c) => {
  try {
    const { messageId } = await c.req.json().catch(() => ({}));
    const db = await fetchDatabase();
    const m = db.messages.find(x => x.id === messageId);
    if (!m) return c.json({ error: 'Not found' }, 404);
    if (m.userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
    delete m.deletedAt;
    await saveDatabase(db, false);
    return c.json({ ok: true });
  } catch (e) { console.error('[restoremsg]', e); return c.json({ error: 'Restore failed' }, 500); }
});

// Scheduled
app.post('/api/messages/schedule', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { roomId: raw, targetUserId, text, imageUrl, deliverAt, replyTo } = body;
    const myId = c.get('userId');
    let roomId = raw;
    if (!roomId && targetUserId) roomId = dmRoomFor(myId, targetUserId);
    roomId = normalizeRoomId(roomId || 'general-group', myId);
    const ts = Number(deliverAt);
    if (!ts || isNaN(ts) || ts < nowMs() + 5000) return c.json({ error: 'deliverAt must be at least 5s in future' }, 400);
    const ct = sanitizeText(text, 4000);
    const ci = typeof imageUrl === 'string' && imageUrl.length <= 4096 ? imageUrl : null;
    if (!ct && !ci) return c.json({ error: 'Empty message' }, 400);
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      if (!parts.includes(myId)) return c.json({ error: 'Forbidden' }, 403);
    }
    const db = await fetchDatabase();
    let replyRef = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.id) {
      replyRef = { id: replyTo.id, text: (replyTo.text || '').slice(0, 200), username: (replyTo.username || '').slice(0, 60), imageUrl: (replyTo.imageUrl || '').slice(0, 2048) || null };
    }
    const author = db.users.find(u => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
    const sm = { id: uid('sched'), roomId, userId: myId, text: ct, imageUrl: ci, replyTo: replyRef, authorSnapshot: snap, deliverAt: ts, createdAt: nowMs() };
    db.scheduledMessages.push(sm);
    await saveDatabase(db, false);
    return c.json({ scheduled: sm });
  } catch (e) { return c.json({ error: 'Schedule failed' }, 500); }
});
app.get('/api/messages/scheduled', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const list = db.scheduledMessages.filter(s => s.userId === c.get('userId')).sort((a, b) => a.deliverAt - b.deliverAt);
  return c.json({ scheduled: list });
});
app.post('/api/messages/scheduled/cancel', requireAuth, async (c) => {
  const { id } = await c.req.json().catch(() => ({}));
  if (!id) return c.json({ error: 'id required' }, 400);
  const db = await fetchDatabase();
  const idx = db.scheduledMessages.findIndex(s => s.id === id);
  if (idx === -1) return c.json({ error: 'Not found' }, 404);
  if (db.scheduledMessages[idx].userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
  db.scheduledMessages.splice(idx, 1);
  await saveDatabase(db, false);
  return c.json({ ok: true });
});

// ---------- Notifications ----------
app.get('/api/notifications', requireAuth, async (c) => {
  cacheTimestamp = 0; // force fresh read so badges/notifications appear immediately
  const db = await fetchDatabase();
  const myId = c.get('userId');
  const mine = (db.notifications || []).filter(n => n.userId === myId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  const enriched = mine.map(n => {
    const author = db.users.find(u => u.id === n.fromUserId);
    return { ...n, from: author ? sanitizeUser(author) : (n.fromSnapshot || { id: n.fromUserId, displayName: 'Member', username: 'member' }) };
  });
  return c.json({ notifications: enriched, unread: enriched.filter(n => !n.seenAt).length });
});
app.post('/api/notifications/seen', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const now = nowMs();
  let n = 0;
  (db.notifications || []).forEach(x => { if (x.userId === c.get('userId') && !x.seenAt) { x.seenAt = now; n++; } });
  if (n) await saveDatabase(db, true);
  return c.json({ ok: true, updated: n });
});
app.post('/api/notifications/clear', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const before = (db.notifications || []).length;
  db.notifications = (db.notifications || []).filter(n => n.userId !== c.get('userId'));
  if (before !== db.notifications.length) await saveDatabase(db, false);
  return c.json({ ok: true, removed: before - db.notifications.length });
});

// ---------- Follow / Block ----------
app.post('/api/user/follow', requireAuth, async (c) => {
  const { targetId } = await c.req.json().catch(() => ({}));
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
  if (!me.following.includes(targetId)) me.following.push(targetId);
  if (!target.followers.includes(myId)) target.followers.push(myId);
  pushNotification(db, targetId, 'follow', myId);
  await saveDatabase(db, false);
  return c.json({ ok: true, following: me.following.length, followers: target.followers.length });
});
app.post('/api/user/unfollow', requireAuth, async (c) => {
  const { targetId } = await c.req.json().catch(() => ({}));
  if (!targetId) return c.json({ error: 'targetId required' }, 400);
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === c.get('userId'));
  const target = db.users.find(u => u.id === targetId);
  if (!me || !target) return c.json({ error: 'User not found' }, 404);
  me.following = (me.following || []).filter(id => id !== targetId);
  target.followers = (target.followers || []).filter(id => id !== c.get('userId'));
  await saveDatabase(db, false);
  return c.json({ ok: true });
});
app.post('/api/user/block', requireAuth, async (c) => {
  const { targetId } = await c.req.json().catch(() => ({}));
  const myId = c.get('userId');
  if (!targetId || targetId === myId) return c.json({ error: 'Invalid target' }, 400);
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === myId);
  const target = db.users.find(u => u.id === targetId);
  if (!me || !target) return c.json({ error: 'User not found' }, 404);
  me.blocked = me.blocked || [];
  if (!me.blocked.includes(targetId)) me.blocked.push(targetId);
  me.following = (me.following || []).filter(id => id !== targetId);
  target.followers = (target.followers || []).filter(id => id !== myId);
  target.following = (target.following || []).filter(id => id !== myId);
  me.followers = (me.followers || []).filter(id => id !== targetId);
  db.notifications = (db.notifications || []).filter(n => !((n.userId === myId && n.fromUserId === targetId) || (n.userId === targetId && n.fromUserId === myId)));
  await saveDatabase(db, false);
  return c.json({ ok: true });
});
app.post('/api/user/unblock', requireAuth, async (c) => {
  const { targetId } = await c.req.json().catch(() => ({}));
  if (!targetId) return c.json({ error: 'targetId required' }, 400);
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === c.get('userId'));
  if (!me) return c.json({ error: 'Not found' }, 404);
  me.blocked = (me.blocked || []).filter(id => id !== targetId);
  await saveDatabase(db, false);
  return c.json({ ok: true });
});
app.get('/api/user/:id/profile', requireAuth, async (c) => {
  const targetId = c.req.param('id');
  const myId = c.get('userId');
  const db = await fetchDatabase();
  const target = db.users.find(u => u.id === targetId);
  if (!target) return c.json({ error: 'Not found' }, 404);
  const me = db.users.find(u => u.id === myId);
  const blockedMe = Array.isArray(target.blocked) && target.blocked.includes(myId);
  const iBlocked = me && Array.isArray(me.blocked) && me.blocked.includes(targetId);
  if (blockedMe) return c.json({ error: 'Profile unavailable' }, 403);
  const posts = (db.posts || []).filter(p => p.userId === targetId && !p.deletedAt && !isStoryRecord(p))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => ({ id: p.id, imageUrl: p.imageUrl, text: p.text, createdAt: p.createdAt, likeCount: (p.likes || []).length, commentCount: (p.comments || []).length }));
  return c.json({
    user: { ...sanitizeUser(target), followers: (target.followers || []).length, following: (target.following || []).length, postsCount: posts.length },
    posts,
    relationship: {
      isMe: targetId === myId,
      iFollow: !!(me && (me.following || []).includes(targetId)),
      followsMe: Array.isArray(target.following) && target.following.includes(myId),
      iBlocked,
    },
  });
});

// ---------- Posts ----------
app.get('/api/posts', requireAuth, async (c) => {
  cacheTimestamp = 0; // force fresh feed read after posts/likes/comments
  const db = await fetchDatabase();
  const myId = c.get('userId');
  const me = db.users.find(u => u.id === myId);
  const myBlocked = new Set((me && me.blocked) || []);
  const blockedMe = new Set();
  db.users.forEach(u => { if (u.id !== myId && Array.isArray(u.blocked) && u.blocked.includes(myId)) blockedMe.add(u.id); });
  const list = db.posts
    .filter(p => !p.deletedAt && !myBlocked.has(p.userId) && !blockedMe.has(p.userId) && canViewerSeeStory(p, myId, db))
    .slice().sort((a, b) => b.createdAt - a.createdAt)
    .map(p => {
      const author = db.users.find(u => u.id === p.userId);
      const comments = (p.comments || []).map(cm => {
        const cu = db.users.find(u => u.id === cm.userId);
        const ca = cu ? sanitizeUser(cu) : (cm.authorSnapshot || { id: cm.userId, displayName: 'Member', username: (cm.userId || 'm').slice(-6) });
        return { ...cm, author: ca };
      });
      const pa = author ? sanitizeUser(author) : (p.authorSnapshot || { id: p.userId, displayName: 'Member', username: (p.userId || 'm').slice(-6) });
      const images = Array.isArray(p.images) && p.images.length > 0 ? p.images : (p.imageUrl ? [p.imageUrl] : []);
      // Only the author receives the raw viewer list; everyone else just gets
      // the count stripped out entirely (privacy: don't leak who saw a story).
      const isOwner = p.userId === myId;
      const viewCount = Array.isArray(p.views) ? p.views.length : 0;
      const base = { ...p, imageUrl: images[0] || null, images, music: p.music || null, isScratch: !!p.isScratch, likes: p.likes || [], likeCount: (p.likes || []).length, comments, commentCount: comments.length, author: pa };
      if (!isOwner) delete base.views;
      if (isStoryRecord(p)) base.viewCount = isOwner ? viewCount : undefined;
      return base;
    });
  return c.json({ posts: list });
});

app.post('/api/posts/create', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { text, imageUrl, images, videoUrl, isScratch, music, style, story, storyExpiresAt, audience } = body;
    const ct = sanitizeText(text, 2000);
    const ci = typeof imageUrl === 'string' && imageUrl.length <= 4096 ? imageUrl : null;
    const cimgs = Array.isArray(images) ? images.filter(u => typeof u === 'string' && u.length <= 4096).slice(0, 3) : (ci ? [ci] : []);
    const mainImg = cimgs[0] || ci || null;
    const cvid = typeof videoUrl === 'string' && videoUrl.length <= 4096 && /^(https?:|data:video\/)/i.test(videoUrl) ? videoUrl : null;
    if (!ct && !mainImg && cimgs.length === 0 && !cvid) return c.json({ error: 'Empty post' }, 400);
    const myId = c.get('userId');
    const db = await fetchDatabase();
    const author = db.users.find(u => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
    const cleanMusic = music && typeof music === 'object' && music.title ? {
      id: music.id,
      title: String(music.title).slice(0,60),
      artist: String(music.artist).slice(0,60),
      audio: String(music.audio).slice(0,1024),
      art: String(music.art).slice(0,1024),
      posX: Math.max(0, Math.min(100, Number(music.posX) || 50)),
      posY: Math.max(0, Math.min(100, Number(music.posY) || 32)),
      startTime: Math.max(0, Math.min(180, Number(music.startTime) || 0)),
      clipDur: Math.max(10, Math.min(30, Number(music.clipDur) || 30)),
      scale: Math.max(0.5, Math.min(2.5, Number(music.scale) || 1)),
      layout: ['pill','card','minimal'].includes(music.layout) ? music.layout : 'pill',
    } : null;
    const cleanStyle = style && typeof style === 'object' ? {
      font: String(style.font || 'modern').slice(0,32),
      color: String(style.color || '#ffffff').slice(0,32),
      bg: !!style.bg,
      bgMode: ['none','solid','soft','outline'].includes(style.bgMode) ? style.bgMode : (style.bg ? 'solid' : 'none'),
      align: ['left','center','right'].includes(style.align) ? style.align : 'center',
      size: Math.max(16, Math.min(52, Number(style.size) || 28)),
      posX: Math.max(0, Math.min(100, Number(style.posX) || 50)),
      posY: Math.max(0, Math.min(100, Number(style.posY) || 68)),
      scale: Math.max(0.5, Math.min(2.5, Number(style.scale) || 1)),
    } : null;
    const isStory = story === true;
    const expiresAt = isStory
      ? Math.max(nowMs() + 60_000, Math.min(nowMs() + (7 * 24 * 3600 * 1000), Number(storyExpiresAt) || (nowMs() + 24 * 3600 * 1000)))
      : null;
    const post = {
      id: uid('post'), userId: myId, text: ct, imageUrl: mainImg,
      images: cimgs.length > 0 ? cimgs : (mainImg ? [mainImg] : []),
      videoUrl: cvid,
      music: cleanMusic, style: cleanStyle, story: isStory, storyExpiresAt: expiresAt,
      audience: isStory ? (audience === 'close_friends' ? 'close_friends' : 'all') : null,
      isScratch: !!isScratch, likes: [], comments: [], authorSnapshot: snap, createdAt: nowMs()
    };
    db.posts.push(post);
    const enriched = { ...post, likeCount: 0, commentCount: 0, author: snap || { id: myId, displayName: 'Member', username: 'member' } };
    _broadcastEvent('new_post', { post: enriched }, myId);
    const persisted = await saveDatabaseVerified(db, d => (d.posts || []).some(p => p.id === post.id));
    if (isPersist() && !persisted) return c.json({ error: 'Post storage unavailable. Please retry.' }, 503);
    return c.json({ post: enriched });
  } catch (e) { return c.json({ error: 'Create post failed' }, 500); }
});

app.post('/api/posts/like', requireAuth, async (c) => {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: 'postId required' }, 400);
  let db = await fetchDatabase();
  let post = db.posts.find(p => p.id === postId);
  // Cross-isolate consistency: if cache misses, force-refresh from GitHub
  if (!post) {
    cacheTimestamp = 0;
    db = await fetchDatabase();
    post = db.posts.find(p => p.id === postId);
  }
  if (!post) return c.json({ error: 'Not found' }, 404);
  post.likes = post.likes || [];
  const myId = c.get('userId');
  const idx = post.likes.indexOf(myId);
  let liked;
  if (idx === -1) { post.likes.push(myId); liked = true; } else { post.likes.splice(idx, 1); liked = false; }
  if (liked) pushNotification(db, post.userId, 'like', myId, { postId: post.id });
  await saveDatabase(db, false);
  return c.json({ liked, likeCount: post.likes.length });
});

app.post('/api/rtc/signal', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { targetId, signal } = body;
  if (!targetId || !signal) return c.json({ error: 'Missing data' }, 400);
  const myId = c.get('userId');
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === myId);
  const author = me ? { id: me.id, username: me.username, displayName: me.displayName, photoUrl: me.photoUrl || '' } : { id: myId, displayName: 'Member', username: 'member' };
  const payload = { fromId: myId, author, signal };
  db.rtcSignals = Array.isArray(db.rtcSignals) ? db.rtcSignals : [];
  if (signal.type === 'end' || signal.type === 'reject' || signal.type === 'busy') {
    db.rtcSignals = db.rtcSignals.filter(x => !( (x.targetId === targetId && x.payload?.fromId === myId) || (x.targetId === myId && x.payload?.fromId === targetId) ));
  }
  const expiresAt = nowMs() + (signal.type === 'offer' ? 20000 : 60000);
  db.rtcSignals.push({ id: uid('rtc'), targetId, payload, createdAt: nowMs(), expiresAt });
  if (db.rtcSignals.length > 200) db.rtcSignals = db.rtcSignals.slice(-200);
  _pushEvent(targetId, 'rtc_signal', payload);
  const persisted = await saveDatabaseVerified(db, d => (d.rtcSignals || []).some(x => x.id === db.rtcSignals[db.rtcSignals.length - 1].id));
  if (isPersist() && !persisted) return c.json({ error: 'Call signal storage unavailable. Please retry.' }, 503);
  return c.json({ ok: true });
});

app.get('/api/rtc/signals', requireAuth, async (c) => {
  cacheTimestamp = 0; // call signaling must be immediate
  const since = Number(c.req.query('since') || 0) || 0;
  const myId = c.get('userId');
  const db = await fetchDatabase();
  const now = nowMs();
  db.rtcSignals = Array.isArray(db.rtcSignals) ? db.rtcSignals.filter(x => !x.expiresAt || x.expiresAt > now) : [];
  let signals = db.rtcSignals
    .filter(x => x.targetId === myId && (x.createdAt || 0) > since && (now - (x.createdAt || 0) <= 20000))
    .sort((a,b) => (a.createdAt||0) - (b.createdAt||0))
    .slice(-30)
    .map(x => ({ id: x.id, createdAt: x.createdAt, ...x.payload }));
  if (signals.length === 0) {
    await sleepMs(900); cacheTimestamp = 0;
    const db2 = await fetchDatabase({ fresh: true });
    const now2 = nowMs();
    db2.rtcSignals = Array.isArray(db2.rtcSignals) ? db2.rtcSignals.filter(x => !x.expiresAt || x.expiresAt > now2) : [];
    signals = db2.rtcSignals
      .filter(x => x.targetId === myId && (x.createdAt || 0) > since && (now2 - (x.createdAt || 0) <= 20000))
      .sort((a,b) => (a.createdAt||0) - (b.createdAt||0))
      .slice(-30)
      .map(x => ({ id: x.id, createdAt: x.createdAt, ...x.payload }));
  }
  return c.json({ signals, now });
});

app.post('/api/posts/comment', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { postId, text } = body;
  if (!postId) return c.json({ error: 'postId required' }, 400);
  const ct = sanitizeText(text, 600).trim();
  if (!ct) return c.json({ error: 'Empty comment' }, 400);
  let db = await fetchDatabase();
  let post = db.posts.find(p => p.id === postId);
  if (!post) { cacheTimestamp = 0; db = await fetchDatabase(); post = db.posts.find(p => p.id === postId); }
  if (!post) return c.json({ error: 'Not found' }, 404);
  post.comments = post.comments || [];
  const myId = c.get('userId');
  const author = db.users.find(u => u.id === myId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
  const comment = { id: uid('cmt'), userId: myId, text: ct, authorSnapshot: snap, createdAt: nowMs() };
  post.comments.push(comment);
  pushNotification(db, post.userId, 'comment', myId, { postId: post.id, commentId: comment.id, text: ct.slice(0, 140) });
  await saveDatabase(db, false);
  return c.json({ comment: { ...comment, author: snap || { id: myId, displayName: 'Member', username: 'member' } } });
});

app.post('/api/posts/delete', requireAuth, async (c) => {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: 'postId required' }, 400);
  let db = await fetchDatabase();
  let p = db.posts.find(x => x.id === postId);
  if (!p) { cacheTimestamp = 0; db = await fetchDatabase(); p = db.posts.find(x => x.id === postId); }
  if (!p) return c.json({ error: 'Not found' }, 404);
  if (p.userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
  p.deletedAt = nowMs();
  await saveDatabase(db, false);
  return c.json({ ok: true, undoUntil: p.deletedAt + 30 * 24 * 3600 * 1000 });
});
app.post('/api/posts/restore', requireAuth, async (c) => {
  const { postId } = await c.req.json().catch(() => ({}));
  if (!postId) return c.json({ error: 'postId required' }, 400);
  let db = await fetchDatabase();
  let p = db.posts.find(x => x.id === postId);
  if (!p) { cacheTimestamp = 0; db = await fetchDatabase(); p = db.posts.find(x => x.id === postId); }
  if (!p) return c.json({ error: 'Not found' }, 404);
  if (p.userId !== c.get('userId')) return c.json({ error: 'Forbidden' }, 403);
  delete p.deletedAt;
  await saveDatabase(db, false);
  return c.json({ ok: true });
});

// ---------- Story analytics: "Seen by" ----------
// Record that the current user viewed a story item. Idempotent per viewer.
// Author never counts as a viewer of their own story.
app.post('/api/stories/:id/view', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const myId = c.get('userId');
  let db = await fetchDatabase();
  let p = db.posts.find(x => x.id === postId);
  if (!p) { cacheTimestamp = 0; db = await fetchDatabase(); p = db.posts.find(x => x.id === postId); }
  if (!p || !isStoryRecord(p)) return c.json({ error: 'Story not found' }, 404);
  // Only record views the viewer is actually allowed to see.
  if (!canViewerSeeStory(p, myId, db)) return c.json({ error: 'Forbidden' }, 403);
  if (p.userId === myId) return c.json({ ok: true, viewCount: (p.views || []).length }); // owner self-view ignored
  p.views = Array.isArray(p.views) ? p.views : [];
  const existing = p.views.find(v => v.userId === myId);
  if (existing) { existing.at = nowMs(); }
  else { p.views.push({ userId: myId, at: nowMs() }); }
  await saveDatabase(db, true); // ephemeral: high-frequency, low-criticality
  return c.json({ ok: true, viewCount: p.views.length });
});

// Owner-only viewer list for a story item (Instagram "Seen by").
app.get('/api/stories/:id/viewers', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const myId = c.get('userId');
  const db = await fetchDatabase();
  const p = db.posts.find(x => x.id === postId);
  if (!p || !isStoryRecord(p)) return c.json({ error: 'Story not found' }, 404);
  if (p.userId !== myId) return c.json({ error: 'Forbidden' }, 403); // only the author sees viewers
  const views = (Array.isArray(p.views) ? p.views : []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const viewers = views.map(v => {
    const u = db.users.find(x => x.id === v.userId);
    const su = u ? sanitizeUser(u) : { id: v.userId, displayName: 'Member', username: (v.userId || 'm').slice(-6), photoUrl: '' };
    return { ...su, at: v.at || 0 };
  });
  return c.json({ viewers, viewCount: viewers.length });
});

// ---------- Reply to a story (delivered into DMs) ----------
app.post('/api/stories/:id/reply', requireAuth, async (c) => {
  const postId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const myId = c.get('userId');
  const emoji = typeof body.emoji === 'string' ? body.emoji.slice(0, 8) : '';
  const text = sanitizeText(body.text || '', 500).trim();
  if (!emoji && !text) return c.json({ error: 'Empty reply' }, 400);
  let db = await fetchDatabase();
  let p = db.posts.find(x => x.id === postId);
  if (!p) { cacheTimestamp = 0; db = await fetchDatabase(); p = db.posts.find(x => x.id === postId); }
  if (!p || !isStoryRecord(p)) return c.json({ error: 'Story not found' }, 404);
  if (p.userId === myId) return c.json({ error: 'Cannot reply to your own story' }, 400);
  if (!canViewerSeeStory(p, myId, db)) return c.json({ error: 'Forbidden' }, 403);
  const roomId = dmRoomFor(myId, p.userId);
  const author = db.users.find(u => u.id === myId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
  // A compact reference to the story so the DM bubble can show context.
  const storyRef = {
    id: p.id, kind: 'story',
    imageUrl: (Array.isArray(p.images) && p.images[0]) || p.imageUrl || null,
    text: typeof p.text === 'string' ? p.text.slice(0, 120) : '',
    username: (p.authorSnapshot && p.authorSnapshot.username) || '',
  };
  const bodyText = emoji ? (text ? emoji + ' ' + text : emoji) : text;
  const msg = {
    id: uid('msg'), roomId, userId: myId, text: bodyText, imageUrl: null,
    storyReply: storyRef, replyTo: null, authorSnapshot: snap, createdAt: nowMs(),
  };
  db.messages.push(msg);
  const enriched = { ...msg, author: snap || { id: myId, displayName: 'Member', username: 'member' } };
  _pushEvent(p.userId, 'new_message', { roomId, message: enriched });
  pushNotification(db, p.userId, 'story_reply', myId, { text: bodyText.slice(0, 80), postId: p.id });
  const persisted = await saveDatabaseVerified(db, d => (d.messages || []).some(m => m.id === msg.id));
  if (isPersist() && !persisted) return c.json({ error: 'Reply storage unavailable. Please retry.' }, 503);
  return c.json({ ok: true, message: enriched });
});

// ---------- Admin panel removed by owner request ----------
app.all('/api/admin/*', (c) => c.json({ error: 'Admin panel removed' }, 404));

// ---------- Push (subscribe endpoints - actual delivery is no-op for now) ----------
app.get('/api/push/vapid-public', (c) => c.json({ key: VAPID_PUBLIC }));
app.post('/api/push/subscribe', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { subscription } = body;
  if (!subscription || !subscription.endpoint) return c.json({ error: 'Invalid subscription' }, 400);
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!u) return c.json({ error: 'Not found' }, 404);
  u.pushSubs = u.pushSubs || [];
  const i = u.pushSubs.findIndex(s => s.endpoint === subscription.endpoint);
  if (i >= 0) u.pushSubs[i] = subscription; else u.pushSubs.push(subscription);
  if (u.pushSubs.length > 5) u.pushSubs = u.pushSubs.slice(-5);
  await saveDatabase(db, false);
  return c.json({ ok: true, devices: u.pushSubs.length });
});
app.post('/api/push/unsubscribe', requireAuth, async (c) => {
  const { endpoint } = await c.req.json().catch(() => ({}));
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!u) return c.json({ error: 'Not found' }, 404);
  u.pushSubs = (u.pushSubs || []).filter(s => s.endpoint !== endpoint);
  await saveDatabase(db, false);
  return c.json({ ok: true });
});

// ---------- SSE stream — real streaming on Workers using ReadableStream ----------
app.get('/api/stream', async (c) => {
  const token = c.req.query('token') || (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return c.text('', 401);
  let payload;
  try { payload = await verifyToken(token); } catch (_) { return c.text('', 401); }
  const userId = payload.uid;
  const lastEventId = c.req.header('last-event-id') || c.req.query('lastEventId') || null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (text) => { try { controller.enqueue(encoder.encode(text)); } catch (_) {} };
      send(': connected\n\n');
      // Flush any queued events
      const queue = _eventQueues.get(userId) || [];
      let startIdx = 0;
      if (lastEventId) {
        const i = queue.findIndex(e => e.id === lastEventId);
        if (i >= 0) startIdx = i + 1;
      }
      for (let i = startIdx; i < queue.length; i++) {
        const e = queue[i];
        send(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      // Register as live subscriber
      const sub = { closed: false, write: send };
      if (!_eventSubscribers.has(userId)) _eventSubscribers.set(userId, new Set());
      _eventSubscribers.get(userId).add(sub);
      const heartbeat = setInterval(() => { try { send(': ping\n\n'); } catch (_) {} }, 10000);
      const autoclose = setTimeout(() => cleanup(), 24000);
      function cleanup() {
        if (sub.closed) return;
        sub.closed = true;
        clearInterval(heartbeat);
        clearTimeout(autoclose);
        const set = _eventSubscribers.get(userId);
        if (set) { set.delete(sub); if (set.size === 0) _eventSubscribers.delete(userId); }
        try { controller.close(); } catch (_) {}
      }
      c.req.raw.signal.addEventListener('abort', cleanup);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// ---------- 404 ----------
app.all('/api/*', (c) => c.json({ error: 'Route not found', path: c.req.path }, 404));

// ---------- Export for Cloudflare ----------
export default app;
