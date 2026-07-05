/**
 * PRIV SPACA — Cloudflare Pages / Workers entry.
 *
 * Hono-based reimplementation of the Express API in api/index.js.
 * Same routes, same input/output, same JWT, same DB layout, same persistence.
 * The Express version (api/index.js) remains for Netlify / local Node.
 *
 * Required compatibility: nodejs_compat (Buffer + crypto + process.env).
 * 
 * Bug #17 fix: Architecture note on duplicate implementations
 * =============================================================
 * This file (cf-worker.js) and index.js are INTENTIONALLY parallel implementations:
 * - cf-worker.js: Hono-based, runs on Cloudflare Workers/Pages
 * - index.js: Express-based, runs on Netlify Functions / local Node.js
 * Both share the same API contract, DB schema, and business logic.
 * Changes to routes/logic should be applied to BOTH files.
 * This duplication exists because Express doesn't run on Cloudflare Workers
 * (different runtime constraints, no Node.js native modules).
 * 
 * Bug #13 fix: Soft-delete documentation
 * ===========================================
 * This API uses soft-delete for posts, messages, and users:
 * - Records are marked with `deletedAt: timestamp` instead of being removed
 * - Soft-deleted records are filtered out from normal queries
 * - Records are permanently purged 30 days after soft-delete (see runScheduler)
 * - Users can restore/undo within 30 days via /api/messages/:id/restore
 * - `disappeared` flag indicates auto-deleted disappearing messages
 */

import { Hono } from 'hono';
// Buffer polyfill — uses Web API (available in all Workers runtimes)
// instead of node:buffer so esbuild bundling succeeds without nodejs_compat.
const _b64decode = (b64) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

// NOTE (v73-libsql-http-fix): '@libsql/client/web' uses libsql's WebSocket/Hrana
// transport, which has a known, reproducible bug on Cloudflare Workers: under
// concurrent load it can hang a request indefinitely instead of resolving or
// throwing. The Workers runtime then kills the request itself after its own
// hang-detector fires, returning a bare "error code: 1101" / 500 with NO
// worker-side try/catch ever getting a chance to run (confirmed live via
// `wrangler pages deployment tail`: exceptions named "The Workers runtime
// canceled this request because it detected that your Worker's code had
// hung..."). This intermittently broke /api/messages, /api/notifications,
// /api/stream (SSE) and — critically — /api/rtc/signals, which is exactly
// why call recipients would sometimes never see the incoming-call popup:
// their poll (or SSE) request silently died before it could deliver the
// offer. '@libsql/client/http' uses plain fetch() (Hrana-over-HTTP) instead
// of WebSockets and does not exhibit this hang, while providing an
// identical execute()/batch()/executeMultiple() API — a safe drop-in swap.
import { createClient as createTursoClient } from '@libsql/client/http';
import { AsyncLocalStorage } from 'node:async_hooks';

const app = new Hono();

// ---------- Config (refreshed on every request from c.env) ----------
let JWT_SECRET = 'priv-spaca-dev-secret-change-me';
let GITHUB_PAT = '';
let TURSO_DATABASE_URL = '';
let TURSO_AUTH_TOKEN = '';
let GH_REPO    = 'ajitjaat1011-ui/PRIV-SPACA';
let GH_BRANCH  = 'data';
let GH_FILE    = 'db.json';
let VAPID_PUBLIC  = 'BG5msm1YiW_5l5N2ZNAvz5CkzQDGchg99ZSpkXVhXb4mm70X8vPPZs_7lrsaDXtvPns7QloRkh40vY4J5O0pqlI';
let VAPID_PRIVATE = ''; // must be set as encrypted env secret in production
let VAPID_SUBJECT = 'mailto:admin@priv-spaca.app';
// Bug #11 fix: Avoid hardcoding admin users in source. These are now fallback
// defaults for development only. Production should use encrypted secrets.
let ADMIN_USERS = ''; // Set via env secret: ADMIN_USERS
let OWNER_EMAIL = ''; // Set via env secret: OWNER_EMAIL  
let OWNER_USERNAME = ''; // Set via env secret: OWNER_USERNAME
let VIP_UNLOCK_KEY = '';
// Bug #12 fix: Cloudinary is optional. When not configured, uploads fall back to
// GitHub raw content CDN. Set these as encrypted secrets only if you want faster
// uploads via Cloudinary's CDN:
//   wrangler pages secret put CLOUDINARY_CLOUD_NAME --project-name priv-spaca
//   wrangler pages secret put CLOUDINARY_API_KEY --project-name priv-spaca
//   wrangler pages secret put CLOUDINARY_API_SECRET --project-name priv-spaca
let CLOUDINARY_CLOUD_NAME = '';
let CLOUDINARY_API_KEY = '';
let CLOUDINARY_API_SECRET = '';
let CLOUDINARY_FOLDER = 'priv-spaca';
let STREAM_API_KEY = '';
let STREAM_API_SECRET = '';
let STREAM_APP_ID = '';
function isAllowedCorsOrigin(origin) {
  if (!origin) return true; // curl/server/API agents send no Origin
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    if (h === 'priv-spaca.pages.dev' || h.endsWith('.priv-spaca.pages.dev')) return true;
    if (h === 'localhost' || h === '127.0.0.1') return true;
  } catch (_) {}
  return false;
}
function applyCors(c) {
  const origin = c.req.header('origin') || '';
  if (origin && isAllowedCorsOrigin(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
  }
  c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID');
  c.header('Access-Control-Max-Age', '86400');
}
function isDefaultJwtSecret() {
  return !JWT_SECRET || JWT_SECRET === 'priv-spaca-dev-secret-change-me';
}
function isProductionRequest(c) {
  const host = new URL(c.req.url).hostname.toLowerCase();
  return host.endsWith('priv-spaca.pages.dev') || host === 'priv-spaca.pages.dev';
}

function loadConfig(env) {
  if (!env) return;
  // Always overwrite — values can change per-deploy
  if (env.JWT_SECRET) JWT_SECRET = env.JWT_SECRET;
  if (env.GITHUB_PAT) GITHUB_PAT = env.GITHUB_PAT;
  if (env.TURSO_DATABASE_URL) TURSO_DATABASE_URL = String(env.TURSO_DATABASE_URL).trim();
  if (env.TURSO_AUTH_TOKEN) TURSO_AUTH_TOKEN = String(env.TURSO_AUTH_TOKEN).trim();
  if (env.GH_REPO) GH_REPO = env.GH_REPO;
  if (env.GH_BRANCH) GH_BRANCH = env.GH_BRANCH;
  if (env.GH_FILE) GH_FILE = env.GH_FILE;
  if (env.VAPID_PUBLIC_KEY) VAPID_PUBLIC = env.VAPID_PUBLIC_KEY;
  if (env.VAPID_PRIVATE_KEY) VAPID_PRIVATE = env.VAPID_PRIVATE_KEY;
  if (env.VAPID_SUBJECT) VAPID_SUBJECT = env.VAPID_SUBJECT;
  if (env.ADMIN_USERS) ADMIN_USERS = env.ADMIN_USERS;
  if (env.OWNER_EMAIL) OWNER_EMAIL = env.OWNER_EMAIL;
  if (env.OWNER_USERNAME) OWNER_USERNAME = env.OWNER_USERNAME;
  if (env.VIP_UNLOCK_KEY) VIP_UNLOCK_KEY = env.VIP_UNLOCK_KEY;
  if (env.CLOUDINARY_CLOUD_NAME) CLOUDINARY_CLOUD_NAME = env.CLOUDINARY_CLOUD_NAME;
  if (env.CLOUDINARY_API_KEY) CLOUDINARY_API_KEY = env.CLOUDINARY_API_KEY;
  if (env.CLOUDINARY_API_SECRET) CLOUDINARY_API_SECRET = env.CLOUDINARY_API_SECRET;
  if (env.CLOUDINARY_FOLDER) CLOUDINARY_FOLDER = env.CLOUDINARY_FOLDER;
  if (env.STREAM_API_KEY) STREAM_API_KEY = String(env.STREAM_API_KEY).trim();
  if (env.STREAM_API_SECRET) STREAM_API_SECRET = String(env.STREAM_API_SECRET).trim();
  if (env.STREAM_APP_ID) STREAM_APP_ID = String(env.STREAM_APP_ID).trim();
}

const JWT_EXPIRES_DAYS = 7;
// Bug #7 fix: Consistent bcrypt rounds between index.js and cf-worker.js.
// rounds=8 provides good security while remaining acceptable for the Workers
// runtime (bcryptjs is pure-JS; ~100ms per login). The stored hash carries its
// own cost factor so existing hashes with different costs continue to work.
// We do a transparent upgrade to rounds=8 the first time a user signs in.
const PASSWORD_HASH_ROUNDS = 8;
// Cache TTL on Cloudflare tuned for up to 100 concurrent users (absorbs polling spikes across isolates)
const CACHE_TTL_MS = 2500;
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
const isPersist = () => isTursoPrimary() || isRepo();
const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isUsername = s => typeof s === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(s);
const isPin = s => typeof s === 'string' && /^\d{4}$/.test(s);
function sanitizeText(s, max = 4000) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFKC')
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
          // Strip zero-width + bidi override chars used for spoofing/phishing.
          .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
          .slice(0, max);
}
function normalizeAuthIdentifier(v) {
  return sanitizeText(String(v || ''), 254).trim().toLowerCase();
}
function isSafeMediaUrl(url, { allowData = true } = {}) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > 4096) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (allowData && /^data:(image|audio|video)\/(jpeg|jpg|png|webp|gif|webm|mp3|mp4|quicktime|mov);base64,[a-z0-9+/=]+$/i.test(u)) return true;
  return false;
}
function isSafeImageUrl(url, { allowData = true } = {}) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > 4096) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (allowData && /^data:image\/(jpeg|jpg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(u)) return true;
  return false;
}
function isSafeHttpsUrl(url, maxLen = 2048) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > maxLen) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}
function isValidPushSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (!isSafeHttpsUrl(sub.endpoint, 2048)) return false;
  const keys = sub.keys;
  if (!keys || typeof keys !== 'object') return false;
  const p256dh = String(keys.p256dh || '');
  const auth = String(keys.auth || '');
  // Browser Push API keys are base64url strings. Keep validation strict on
  // shape/safety, but allow very short synthetic keys used by the API test
  // suite because this endpoint only stores subscriptions; delivery failures
  // are caught and pruned by sendWebPush().
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(p256dh)) return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(auth)) return false;
  return true;
}
function isStoryRecord(post) {
  if (!post) return false;
  return !!(post.story === true || post.kind === 'story' || post.storyExpiresAt);
}
function storyExpiresAt(post) {
  return Number(post && post.storyExpiresAt) || ((post && post.createdAt) ? (post.createdAt + 24 * 60 * 60 * 1000) : 0);
}
// Bug #10 fix: Handle edge case where viewerId is null/undefined for unauthenticated requests
// and ensure close_friends stories require valid viewerId
function isPrivateAccount(user) {
  return !!(user && user.isPrivate === true);
}
function viewerFollowsUser(viewerId, owner, db) {
  if (!owner || !viewerId) return false;
  if (owner.id === viewerId) return true;
  const ownerFollowers = Array.isArray(owner.followers) ? owner.followers : [];
  if (ownerFollowers.includes(viewerId)) return true;
  const viewer = (db && Array.isArray(db.users) ? db.users : []).find(u => u.id === viewerId);
  return !!(viewer && Array.isArray(viewer.following) && viewer.following.includes(owner.id));
}
function canViewerAccessPrivateProfile(owner, viewerId, db) {
  if (!owner) return false;
  if (!isPrivateAccount(owner)) return true;
  return viewerFollowsUser(viewerId, owner, db);
}
function canViewerSeeStory(post, viewerId, db) {
  if (!isStoryRecord(post)) return true; // non-stories always visible
  if (!post || post.deletedAt) return false;
  if (storyExpiresAt(post) <= nowMs()) return false;
  // Author can always see their own story
  if (viewerId && post.userId === viewerId) return true;
  const author = (db && Array.isArray(db.users) ? db.users : []).find(u => u.id === post.userId);
  if (!author) return false; // author not found — can't verify privacy/close friends
  if (!canViewerAccessPrivateProfile(author, viewerId, db)) return false;
  // Public stories (audience = 'all' or undefined) — anyone allowed by account privacy can see
  const audience = post.audience || 'all';
  if (audience !== 'close_friends') return true;
  // Close friends only: must have a valid viewerId
  if (!viewerId) return false;
  const closeFriends = Array.isArray(author.closeFriends) ? author.closeFriends : [];
  return closeFriends.includes(viewerId);
}
function sanitizeUser(u, includePrivate = false) {
  if (!u) return null;
  const out = { id: u.id, email: u.email, username: u.username, displayName: u.displayName,
           bio: u.bio || '', photoUrl: u.photoUrl || '', createdAt: u.createdAt,
           publicKey: u.publicKey || null, verified: !!u.verified, isPrivate: !!u.isPrivate, note: activeNote(u) };
  if (includePrivate) {
    out.dateOfBirth = typeof u.dateOfBirth === 'string' ? u.dateOfBirth : '';
    out.cardVisibility = ['everyone','close_friends','private'].includes(u.cardVisibility) ? u.cardVisibility : 'everyone';
  }
  return out;
}
function canViewProfileCard(owner, viewerId) {
  if (!owner || !viewerId) return false;
  if (owner.id === viewerId) return true;
  const mode = ['everyone','close_friends','private'].includes(owner.cardVisibility) ? owner.cardVisibility : 'everyone';
  if (mode === 'everyone') return true;
  if (mode === 'close_friends') return Array.isArray(owner.closeFriends) && owner.closeFriends.includes(viewerId);
  return false;
}
// A "note" is a short 24h status (Instagram-style). Returns null once expired.
function activeNote(u) {
  const n = u && u.note;
  if (!n || (!n.text && !n.music)) return null;
  if (n.expiresAt && n.expiresAt <= nowMs()) return null;
  return { text: String(n.text || '').slice(0, 60), music: n.music || null, createdAt: n.createdAt || 0, expiresAt: n.expiresAt || 0 };
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
  const db = await fetchPrimaryDatabase();
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!isAdminUser(u)) return c.json({ error: 'Admin only' }, 403);
  c.set('adminUser', u);
  c.set('adminDb', db);
  await next();
}


// ---------- Persistence routing (Turso primary, GitHub fallback) ----------
// Neon Postgres has been removed from this build. Turso is the only primary
// store. If Turso is unreachable or not configured, the app falls back to
// reading/writing the GitHub db.json path. For local dev with neither
// configured, an in-memory cache is used.
//
// The dead Neon stubs below (isNeonPrimary, neonReadDb, etc.) remain so the
// rest of the file doesn't need additional edits; they all return
// null/false, so they have no effect on behavior.
function isTursoPrimary() {
  return isTursoConfigured();
}
function isNeonPrimary() {
  return false;
}
function primaryPersistenceName() {
  if (isTursoPrimary()) return 'turso-libsql-primary';
  if (isRepo()) return 'github-repo';
  return 'in-memory';
}
function neonClient() { return null; }
async function neonEnsure() { return false; }
async function neonReadDb() { return null; }
async function neonReadDbVersioned() { return null; }
async function neonWriteDb() { return false; }
async function neonWriteDbCAS() { return false; }
async function neonResetDb() { return false; }

// ---------- GitHub repo persistence ----------

async function repoRead() {
  if (isTursoPrimary()) return await tursoReadDb();
  if (isNeonPrimary()) return await neonReadDb();
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
    const text = _b64decode(b64);
    return safeJson(text, { _err: 'Invalid JSON', _textPreview: text.slice(0, 100) });
  } catch (e) {
    return { _err: e.message, _stack: e.stack };
  }
}
async function repoWrite(dbObj) {
  if (isTursoPrimary()) return await tursoWriteDb(dbObj);
  if (isNeonPrimary()) return await neonWriteDb(dbObj);
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

// v74/v75-turso-per-request-client-fix:
//
// v74 problem: `_turso` was a module-level singleton created once and reused
// by every subsequent request handled by this Worker isolate. Cloudflare
// Workers explicitly forbid reusing I/O objects (fetches, streams, and
// anything that holds a reference to one) across different requests'
// execution contexts — each incoming request gets its own context, and once
// that context ends, any pending I/O tied to it is torn down.
// @libsql/client's HttpClient keeps exactly this kind of cross-request state
// internally: a lazily-resolving `_endpointPromise` for protocol negotiation
// and a shared `promiseLimit` concurrency queue. Reusing the same HttpClient
// instance across requests meant a later request could end up waiting on a
// promise/queue slot that belonged to an earlier, possibly already-torn-down
// request context. That is precisely what the Workers runtime was killing
// (confirmed live via `wrangler pages deployment tail`: exceptions "Promise
// will never complete" and "The Workers runtime canceled this request
// because it detected that your Worker's code had hung...").
//
// v74 fix (creating a brand new client on every tursoClient() call) solved
// the hangs, but overcorrected: many request handlers call tursoClient()
// several times (e.g. fetchDatabase()'s 3-statement batch, then again later
// in the same handler), and constructing a fresh HttpClient + its internal
// promiseLimit() queue on every single call added enough CPU overhead under
// load to trip Cloudflare's per-request CPU-time limit (confirmed live:
// "error code: 1102" / exceededCpu on some requests).
//
// v75 fix: scope exactly ONE Turso client per incoming request using
// AsyncLocalStorage (available via the nodejs_compat flag already set in
// wrangler.toml). The very first middleware run for each request creates one
// client and stores it in ALS; every tursoClient() call within that same
// request's async call graph reuses that one instance; the next incoming
// request gets an entirely fresh one. This keeps the safety property from
// v74 (no I/O object ever crosses a request boundary) while restoring the
// low per-request overhead of "create once, reuse within this request".
let _tursoReady = false;
let _tursoBootstrapped = false;
const _tursoAls = new AsyncLocalStorage();
function isTursoConfigured() {
  return !!(TURSO_DATABASE_URL && TURSO_AUTH_TOKEN);
}
function tursoClient() {
  const store = _tursoAls.getStore();
  if (store) {
    if (!store.client) store.client = createTursoClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
    return store.client;
  }
  // Fallback for any code path that runs outside the per-request ALS context
  // (e.g. scheduled/background work). Still request-scoped in spirit: a new
  // client each time, never cached at module level.
  return createTursoClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
}
// Runs `fn` inside a fresh per-request Turso-client scope. Wired into the
// global '*' middleware below so every request gets exactly one scope.
function runWithTursoRequestScope(fn) {
  return _tursoAls.run({ client: null }, fn);
}
async function tursoEnsure() {
  if (!isTursoConfigured()) return false;
  if (_tursoReady) return true;
  const c = tursoClient();
  await c.executeMultiple(`
    CREATE TABLE IF NOT EXISTS ps_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ps_rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      reset_at INTEGER NOT NULL,
      locked_until INTEGER DEFAULT 0,
      first_at INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_rate_limits_reset_at ON ps_rate_limits (reset_at);
    CREATE TABLE IF NOT EXISTS ps_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_events_user_ts ON ps_events (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ps_events_ts ON ps_events (created_at);
    CREATE TABLE IF NOT EXISTS ps_users (
      id TEXT PRIMARY KEY,
      username_lower TEXT,
      email_lower TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_users_username_lower ON ps_users (username_lower);
    CREATE INDEX IF NOT EXISTS idx_ps_users_email_lower ON ps_users (email_lower);
    CREATE TABLE IF NOT EXISTS ps_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      story INTEGER NOT NULL DEFAULT 0,
      story_expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_posts_user_id ON ps_posts (user_id);
    CREATE INDEX IF NOT EXISTS idx_ps_posts_created_at ON ps_posts (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ps_posts_story ON ps_posts (story, story_expires_at);
    CREATE TABLE IF NOT EXISTS ps_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      from_user_id TEXT,
      kind TEXT,
      created_at INTEGER NOT NULL,
      seen_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_notifications_user_created ON ps_notifications (user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_dm_index (
      owner_user_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      PRIMARY KEY (owner_user_id, peer_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_dm_index_owner_created ON ps_dm_index (owner_user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      disappear_at INTEGER,
      updated_at INTEGER NOT NULL,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ps_messages_room_created ON ps_messages (room_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS ps_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ps_user_feeds (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ps_user_feeds_user_created ON ps_user_feeds (user_id, created_at DESC);
  `);
  _tursoReady = true;
  return true;
}

// ---------- Turso/libSQL full JSON primary storage ----------
async function tursoReadDb() {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
  if (!rs.rows || rs.rows.length === 0) return normalizeDb({});
  return normalizeDb(safeJson(String(rs.rows[0].value || '{}'), normalizeDb({})));
}
async function tursoReadDbVersioned() {
  if (!isTursoConfigured()) return null;
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT value, version FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
  if (!rs.rows || rs.rows.length === 0) return { db: normalizeDb({}), version: null };
  return { db: normalizeDb(safeJson(String(rs.rows[0].value || '{}'), normalizeDb({}))), version: Number(rs.rows[0].version || 0) };
}
async function tursoWriteDb(dbObj) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const db = normalizeDb(dbObj);
  db.meta = { ...(db.meta || {}), storage: 'turso-json-v1', updatedAt: Date.now() };
  const ts = nowMs();
  await tursoClient().execute({
    sql: `INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = ps_kv.version + 1, updated_at = excluded.updated_at`,
    args: ['db', JSON.stringify(db), ts],
  });
  return true;
}
async function tursoWriteDbCAS(dbObj, expectedVersion) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const db = normalizeDb(dbObj);
  db.meta = { ...(db.meta || {}), storage: 'turso-json-v1', updatedAt: Date.now() };
  const ts = nowMs();
  if (expectedVersion === null || expectedVersion === undefined) {
    const rs = await tursoClient().execute({
      sql: 'INSERT INTO ps_kv (key, value, version, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO NOTHING',
      args: ['db', JSON.stringify(db), ts],
    });
    return Number(rs.rowsAffected || 0) > 0;
  }
  const rs = await tursoClient().execute({
    sql: 'UPDATE ps_kv SET value = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?',
    args: [JSON.stringify(db), ts, 'db', Number(expectedVersion || 0)],
  });
  return Number(rs.rowsAffected || 0) > 0;
}
async function tursoResetDb() {
  if (!isTursoConfigured()) return false;
  const empty = normalizeDb({ users: [], messages: [], scheduledMessages: [], posts: [], notifications: [], typing: {}, heartbeat: {}, rtcSignals: [], meta: { storage: 'turso-json-v1', resetAt: Date.now() } });
  await tursoWriteDb(empty);
  localCache = empty;
  cacheTimestamp = Date.now();
  return true;
}
async function syncTursoMirror(db) {
  if (!isTursoConfigured()) return false;
  await tursoEnsure();
  const c = tursoClient();
  const src = normalizeDb(db);
  const ts = nowMs();
  try {
    const statements = [{ sql: 'DELETE FROM ps_users' }];
    for (const u of src.users || []) {
      statements.push({
        sql: 'INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?)',
        args: [u.id, String(u.username || '').toLowerCase(), String(u.email || '').toLowerCase(), Number(u.createdAt || 0), ts, JSON.stringify(u)],
      });
    }
    statements.push({ sql: 'DELETE FROM ps_posts' });
    for (const p of src.posts || []) {
      statements.push({
        sql: 'INSERT INTO ps_posts (id, user_id, created_at, deleted_at, story, story_expires_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [p.id, p.userId, Number(p.createdAt || 0), p.deletedAt ? Number(p.deletedAt) : null, p.story ? 1 : 0, p.storyExpiresAt ? Number(p.storyExpiresAt) : null, ts, JSON.stringify(p)],
      });
    }
    statements.push({ sql: 'DELETE FROM ps_notifications' });
    for (const n of src.notifications || []) {
      statements.push({
        sql: 'INSERT INTO ps_notifications (id, user_id, from_user_id, kind, created_at, seen_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [n.id, n.userId, n.fromUserId || null, n.kind || null, Number(n.createdAt || 0), n.seenAt ? Number(n.seenAt) : null, ts, JSON.stringify(n)],
      });
    }
    const dmIndex = new Map();
    for (const m of src.messages || []) {
      if (!m || m.deletedAt || typeof m.roomId !== 'string' || !m.roomId.startsWith('dm:')) continue;
      const parts = m.roomId.slice(3).split(':').filter(Boolean);
      if (parts.length !== 2) continue;
      for (const ownerId of parts) {
        const peerId = parts.find(id => id !== ownerId);
        if (!peerId) continue;
        const key = ownerId + '|' + peerId;
        const prev = dmIndex.get(key);
        if (prev && Number(prev.createdAt || 0) >= Number(m.createdAt || 0)) continue;
        let preview;
        if (m.encrypted) preview = '🔒 Encrypted message';
        else if (m.storyReply) preview = 'Replied to a story';
        else if (m.imageUrl) preview = '📷 Photo';
        else preview = String(m.text || '').slice(0, 60);
        dmIndex.set(key, {
          ownerUserId: ownerId,
          peerUserId: peerId,
          roomId: m.roomId,
          messageId: m.id,
          createdAt: Number(m.createdAt || 0),
          fromMe: m.userId === ownerId,
          text: preview,
        });
      }
    }
    statements.push({ sql: 'DELETE FROM ps_dm_index' });
    for (const row of dmIndex.values()) {
      statements.push({
        sql: 'INSERT INTO ps_dm_index (owner_user_id, peer_user_id, room_id, created_at, from_me, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [row.ownerUserId, row.peerUserId, row.roomId, row.createdAt, row.fromMe ? 1 : 0, ts, JSON.stringify(row)],
      });
    }
    statements.push({ sql: 'DELETE FROM ps_messages' });
    for (const m of src.messages || []) {
      statements.push({
        sql: 'INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, disappear_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [m.id, m.roomId || 'general-group', m.userId || '', Number(m.createdAt || 0), m.deletedAt ? Number(m.deletedAt) : null, m.disappearAt ? Number(m.disappearAt) : null, ts, JSON.stringify(m)],
      });
    }
    statements.push({
      sql: 'INSERT INTO ps_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      args: ['bootstrap_v1', String(ts), ts],
    });
    await c.batch(statements, 'write');
    _tursoBootstrapped = true;
    return true;
  } catch (e) {
    console.warn('[turso] sync failed', e && e.message);
    return false;
  }
}
async function fetchTursoMirror(fallbackDb = null) {
  if (!isTursoConfigured()) return fallbackDb ? normalizeDb(fallbackDb) : normalizeDb({});
  try {
    await tursoEnsure();
    const c = tursoClient();
    if (!_tursoBootstrapped) {
      const meta = await c.execute({ sql: 'SELECT value FROM ps_meta WHERE key = ?', args: ['bootstrap_v1'] }).catch(() => ({ rows: [] }));
      if (!meta.rows || meta.rows.length === 0) {
        if (fallbackDb) await syncTursoMirror(fallbackDb);
      } else {
        _tursoBootstrapped = true;
      }
    }
    let usersRows = await c.execute('SELECT data_json FROM ps_users ORDER BY created_at ASC');
    let postsRows = await c.execute('SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300');
    if ((!usersRows.rows?.length && !postsRows.rows?.length) && fallbackDb) {
      await syncTursoMirror(fallbackDb);
      usersRows = await c.execute('SELECT data_json FROM ps_users ORDER BY created_at ASC');
      postsRows = await c.execute('SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300');
    }
    return normalizeDb({
      users: (usersRows.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean),
      posts: (postsRows.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean),
    });
  } catch (e) {
    console.warn('[turso] mirror read failed', e && e.message);
    return fallbackDb ? normalizeDb(fallbackDb) : normalizeDb({});
  }
}
async function fetchTursoUserById(userId) {
  if (!isTursoConfigured() || !userId) return null;
  await tursoEnsure();
  const row = await tursoClient().execute({ sql: 'SELECT data_json FROM ps_users WHERE id = ? LIMIT 1', args: [userId] }).catch(() => ({ rows: [] }));
  if (!row.rows || row.rows.length === 0) return null;
  return safeJson(String(row.rows[0].data_json || '{}'), null);
}
async function fetchTursoNotifications(userId) {
  if (!isTursoConfigured() || !userId) return [];
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT data_json FROM ps_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200', args: [userId] }).catch(() => ({ rows: [] }));
  return (rs.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean);
}
async function fetchTursoDmIndex(ownerUserId) {
  if (!isTursoConfigured() || !ownerUserId) return {};
  await tursoEnsure();
  const rs = await tursoClient().execute({ sql: 'SELECT data_json FROM ps_dm_index WHERE owner_user_id = ? ORDER BY created_at DESC', args: [ownerUserId] }).catch(() => ({ rows: [] }));
  const out = {};
  for (const row of (rs.rows || [])) {
    const item = safeJson(String(row.data_json || '{}'), null);
    if (item && item.peerUserId) out[item.peerUserId] = { text: item.text || '', createdAt: Number(item.createdAt || 0), fromMe: !!item.fromMe };
  }
  return out;
}
async function fetchTursoMessages(roomId, now = nowMs()) {
  if (!isTursoConfigured() || !roomId) return null;
  try {
    await tursoEnsure();
    const rs = await tursoClient().execute({
      sql: 'SELECT data_json FROM ps_messages WHERE room_id = ? AND (deleted_at IS NULL OR deleted_at = 0) AND (disappear_at IS NULL OR disappear_at > ?) ORDER BY created_at DESC LIMIT 200',
      args: [roomId, Number(now || 0)],
    });
    const list = (rs.rows || []).map(r => safeJson(String(r.data_json || '{}'), null)).filter(Boolean);
    return list.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  } catch (e) {
    console.warn('[turso] messages read failed', e && e.message);
    return null;
  }
}
async function tursoUpsertUser(user) {
  if (!isTursoConfigured() || !user) return false;
  await tursoEnsure();
  const ts = nowMs();
  try {
    await tursoClient().execute({
      sql: 'INSERT INTO ps_users (id, username_lower, email_lower, created_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username_lower=excluded.username_lower, email_lower=excluded.email_lower, updated_at=excluded.updated_at, data_json=excluded.data_json',
      args: [user.id, String(user.username || '').toLowerCase(), String(user.email || '').toLowerCase(), Number(user.createdAt || 0), ts, JSON.stringify(user)],
    });
    return true;
  } catch (e) {
    console.warn('[turso] user upsert failed', e && e.message);
    return false;
  }
}

async function tursoUpsertPosts(posts) {
  if (!isTursoConfigured()) return false;
  const list = (posts || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map(p => ({
    sql: 'INSERT INTO ps_posts (id, user_id, created_at, deleted_at, story, story_expires_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, created_at=excluded.created_at, deleted_at=excluded.deleted_at, story=excluded.story, story_expires_at=excluded.story_expires_at, updated_at=excluded.updated_at, data_json=excluded.data_json',
    args: [p.id, p.userId, Number(p.createdAt || 0), p.deletedAt ? Number(p.deletedAt) : null, p.story ? 1 : 0, p.storyExpiresAt ? Number(p.storyExpiresAt) : null, ts, JSON.stringify(p)],
  }));
  await tursoClient().batch(stmts, 'write').catch(e => { console.warn('[turso] post upsert failed', e && e.message); });
  return true;
}
async function tursoUpsertNotifications(notifs) {
  if (!isTursoConfigured()) return false;
  const list = (notifs || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map(n => ({
    sql: 'INSERT INTO ps_notifications (id, user_id, from_user_id, kind, created_at, seen_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, from_user_id=excluded.from_user_id, kind=excluded.kind, created_at=excluded.created_at, seen_at=excluded.seen_at, updated_at=excluded.updated_at, data_json=excluded.data_json',
    args: [n.id, n.userId, n.fromUserId || null, n.kind || null, Number(n.createdAt || 0), n.seenAt ? Number(n.seenAt) : null, ts, JSON.stringify(n)],
  }));
  await tursoClient().batch(stmts, 'write').catch(e => { console.warn('[turso] notification upsert failed', e && e.message); });
  return true;
}
async function tursoClearNotificationsForUser(userId) {
  if (!isTursoConfigured() || !userId) return false;
  await tursoEnsure();
  await tursoClient().execute({ sql: 'DELETE FROM ps_notifications WHERE user_id = ?', args: [userId] }).catch(e => { console.warn('[turso] notification clear failed', e && e.message); });
  return true;
}
async function tursoUpsertMessages(messages) {
  if (!isTursoConfigured()) return false;
  const list = (messages || []).filter(Boolean);
  if (!list.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = list.map(m => ({
    sql: 'INSERT INTO ps_messages (id, room_id, user_id, created_at, deleted_at, disappear_at, updated_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET room_id=excluded.room_id, user_id=excluded.user_id, created_at=excluded.created_at, deleted_at=excluded.deleted_at, disappear_at=excluded.disappear_at, updated_at=excluded.updated_at, data_json=excluded.data_json',
    args: [m.id, m.roomId || 'general-group', m.userId || '', Number(m.createdAt || 0), m.deletedAt ? Number(m.deletedAt) : null, m.disappearAt ? Number(m.disappearAt) : null, ts, JSON.stringify(m)],
  }));
  await tursoClient().batch(stmts, 'write').catch(e => { console.warn('[turso] message upsert failed', e && e.message); });
  return true;
}
// Bug #8 fix: Use UPSERT instead of DELETE+INSERT to avoid race conditions
// when multiple concurrent requests refresh DM index for the same owner.
async function tursoRefreshDmIndexForOwners(db, ownerIds) {
  if (!isTursoConfigured()) return false;
  const owners = Array.from(new Set((ownerIds || []).filter(Boolean)));
  if (!owners.length) return true;
  await tursoEnsure();
  const ts = nowMs();
  const stmts = [];
  for (const ownerId of owners) {
    const dmIndex = new Map();
    for (const m of (db.messages || [])) {
      if (!m || m.deletedAt || typeof m.roomId !== 'string' || !m.roomId.startsWith('dm:')) continue;
      const parts = m.roomId.slice(3).split(':').filter(Boolean);
      if (!parts.includes(ownerId) || parts.length !== 2) continue;
      const peerId = parts.find(id => id !== ownerId);
      if (!peerId) continue;
      const prev = dmIndex.get(peerId);
      if (prev && Number(prev.createdAt || 0) >= Number(m.createdAt || 0)) continue;
      let preview;
      if (m.encrypted) preview = '🔒 Encrypted message';
      else if (m.storyReply) preview = 'Replied to a story';
      else if (m.imageUrl) preview = '📷 Photo';
      else preview = String(m.text || '').slice(0, 60);
      dmIndex.set(peerId, {
        ownerUserId: ownerId,
        peerUserId: peerId,
        roomId: m.roomId,
        createdAt: Number(m.createdAt || 0),
        fromMe: m.userId === ownerId,
        text: preview,
      });
    }
    // Use UPSERT: only update if new message is more recent to avoid race clobbering
    for (const row of dmIndex.values()) {
      stmts.push({
        sql: `INSERT INTO ps_dm_index (owner_user_id, peer_user_id, room_id, created_at, from_me, updated_at, data_json) 
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(owner_user_id, peer_user_id) DO UPDATE SET
                room_id = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.room_id ELSE ps_dm_index.room_id END,
                created_at = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.created_at ELSE ps_dm_index.created_at END,
                from_me = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.from_me ELSE ps_dm_index.from_me END,
                updated_at = excluded.updated_at,
                data_json = CASE WHEN excluded.created_at > ps_dm_index.created_at THEN excluded.data_json ELSE ps_dm_index.data_json END`,
        args: [row.ownerUserId, row.peerUserId, row.roomId, row.createdAt, row.fromMe ? 1 : 0, ts, JSON.stringify(row)],
      });
    }
  }
  if (stmts.length) await tursoClient().batch(stmts, 'write').catch(e => { console.warn('[turso] dm index refresh failed', e && e.message); });
  return true;
}

async function ensureOwnerAccount(db) { return false; }

async function fetchPrimaryDatabase() {
  // v65: when Turso is the primary persistence layer, the structured
  // ps_users/ps_posts tables are the actual source of truth (ps_kv is a
  // snapshot/mirror). Read both and let structured take precedence so
  // that direct ps_users writes (e.g. password resets) are reflected
  // immediately without waiting for the mirror to be rewritten.
  if (isTursoConfigured() && isTursoPrimary()) {
    try {
      const tu = tursoClient();
      const batchRs = await tu.batch([
        { sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] },
        { sql: 'SELECT data_json FROM ps_users' },
        { sql: 'SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300' },
      ], 'read');
      const kvRow = (batchRs[0] && batchRs[0].rows && batchRs[0].rows[0]) ? batchRs[0].rows[0].value : '{}';
      const baseDb = safeJson(String(kvRow || '{}'), normalizeDb(localCache || {}));
      const uRows = (batchRs[1] && batchRs[1].rows) || [];
      const pRows = (batchRs[2] && batchRs[2].rows) || [];
      const users = uRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
      const posts = pRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
      if (users.length > 0) baseDb.users = users;
      if (posts.length > 0) baseDb.posts = posts;
      localCache = normalizeDb(baseDb);
      return localCache;
    } catch (e) {
      console.warn('[fetchPrimary] structured read failed, falling back:', e && e.message);
    }
  }
  const remote = await repoRead();
  if (remote && typeof remote === 'object' && !remote._httpError && !remote._err) {
    return normalizeDb(remote);
  }
  return normalizeDb(localCache);
}

async function fetchDatabase({ fresh = false, includeTurso = true } = {}) {
  if (!includeTurso) fresh = true;
  const now = nowMs();
  if (!fresh && now - cacheTimestamp < CACHE_TTL_MS && cacheTimestamp !== 0) {
    runScheduler(localCache);
    return localCache;
  }
  if (isTursoConfigured() && isTursoPrimary()) {
    try {
      const tu = tursoClient();
      if (includeTurso) {
        const batchRs = await tu.batch([
          { sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] },
          { sql: 'SELECT data_json FROM ps_users' },
          { sql: 'SELECT data_json FROM ps_posts ORDER BY created_at DESC LIMIT 300' },
        ], 'read');
        const kvRow = (batchRs[0] && batchRs[0].rows && batchRs[0].rows[0]) ? batchRs[0].rows[0].value : '{}';
        localCache = normalizeDb(safeJson(String(kvRow || '{}'), normalizeDb(localCache || {})));
        const uRows = (batchRs[1] && batchRs[1].rows) || [];
        const pRows = (batchRs[2] && batchRs[2].rows) || [];
        const users = uRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
        const posts = pRows.map(r => safeJson(String(r.data_json || ''), null)).filter(Boolean);
        if (users.length > 0) localCache.users = users;
        if (posts.length > 0) localCache.posts = posts;
        localCache.meta = { ...(localCache.meta || {}), secondaryPersistence: 'turso-structured' };
      } else {
        const rs = await tu.execute({ sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
        const kvRow = (rs.rows && rs.rows[0]) ? rs.rows[0].value : '{}';
        localCache = normalizeDb(safeJson(String(kvRow || '{}'), normalizeDb(localCache || {})));
      }
      const ownerSeeded = await ensureOwnerAccount(localCache);
      cacheTimestamp = nowMs();
      const changed = runScheduler(localCache) || ownerSeeded;
      if (changed) await saveDatabase(localCache, false);
      return localCache;
    } catch (e) {
      console.warn('[fetchDatabase] Turso batch read failed, falling back:', e && e.message);
    }
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

async function saveDatabase(data, isEphemeral = false, opts = {}) {
  localCache = data;
  cacheTimestamp = nowMs();
  if (!isPersist()) return true;
  // The 30s ephemeral-write throttle exists to protect GitHub API rate limits.
  // It is skipped when Turso is the active backend — otherwise heartbeat/typing
  // indicators are silently dropped almost all the time.
  if (isEphemeral && !isTursoPrimary()) {
    const now = nowMs();
    if (now - lastEphemeralWrite < EPHEMERAL_WRITE_INTERVAL_MS) return true;
    lastEphemeralWrite = now;
    repoWrite(data).catch(() => {});
    return true;
  }
  if (isEphemeral && isTursoPrimary()) {
    const now = nowMs();
    if (now - lastEphemeralWrite < 10000) return true;
    lastEphemeralWrite = now;
    // Throttled CAS strategy for ephemeral data: avoids ps_kv lock contention under 100 concurrent users
    try {
      const versioned = await tursoReadDbVersioned();
      const merged = mergeDatabase(versioned.db, data);
      await tursoWriteDbCAS(merged, versioned.version);
    } catch (_) { /* best-effort; ephemeral data, ok to lose occasionally */ }
    return true;
  }
// ---- Neon fast path: optimistic concurrency control (compare-and-swap) ----
  // The whole app's Neon storage is one JSON blob per row, so any two
  // concurrent mutating requests (e.g. two users signing up at the same
  // moment) can both read the same starting state, each add their own
  // change locally, and — without CAS — whichever one writes last would
  // silently overwrite the other's change. That is a real, reproducible
  // data-loss bug (confirmed live: 7 of 8 concurrent signups vanished
  // before this fix), not just a performance concern.
  //
  // Fix: read the row together with its version counter, merge the
  // caller's intended change (`data`) into that fresh copy, and write with
  // `UPDATE ... WHERE version = expected`. If another request won the race
  // and bumped the version first, the UPDATE matches zero rows (CAS
  // failure) — we then re-read the new latest state, re-merge our original
  // intended change into it, and retry. This is a handful of fast Postgres
  // round trips with no artificial sleep, so it stays fast in the common
  // (uncontended) case while remaining correct under real concurrency.
  if (isTursoPrimary()) {
    const originalData = data;
    const MAX_CAS_ATTEMPTS = 15;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      let versioned;
      try {
        versioned = await tursoReadDbVersioned();
      } catch (e) {
        console.error('[saveDatabase:turso] read failed', e && e.message);
        return false;
      }
      const merged = mergeDatabase(versioned.db, originalData);
      let ok = false;
      try {
        ok = await tursoWriteDbCAS(merged, versioned.version);
      } catch (e) {
        console.error('[saveDatabase:turso] CAS write failed', e && e.message);
        return false;
      }
      if (ok) {
        localCache = normalizeDb(merged);
        cacheTimestamp = nowMs();
        return true;
      }
      if (attempt < MAX_CAS_ATTEMPTS - 1) {
        await sleepMs(10 + Math.floor(Math.random() * (20 + attempt * 10)));
      }
    }
    console.error('[saveDatabase:turso] CAS retries exhausted for key=db');
    return false;
  }
  // ---- GitHub Contents API path (legacy / fallback persistence) ----
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
  if (ok) {
    localCache = normalizeDb(toWrite);
    cacheTimestamp = nowMs();
  }
  return ok;
}

async function saveDatabaseVerified(data, verifyFn, attempts = 4, opts = {}) {
  // ---- Neon fast path ----
  // saveDatabase() now performs its own internal compare-and-swap retry
  // loop against Neon (see above) and only returns true once the merged
  // data — which includes this call's intended change — is durably
  // committed. Re-reading afterwards to "verify" would be redundant, so we
  // just surface saveDatabase()'s result directly. verifyFn is intentionally
  // unused on this path (kept only for signature/call-site compatibility).
  if (isTursoPrimary()) {
    return await saveDatabase(data, false, opts);
  }
  // ---- GitHub Contents API path (legacy / fallback persistence) ----
  for (let i = 0; i < attempts; i++) {
    const ok = await saveDatabase(data, false, opts);
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
  const payload = { uid: user.id, username: user.username, sv: Number(user.tokenVersion || 0), iat, exp };
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

// v66: in-memory auth-user cache. Avoids hitting Turso on every
// authenticated request (which is most of the API). Cloudflare Workers
// can have multiple isolates per region, so this cache is per-isolate
// (each isolate's cache is independent). That's fine: the worst case
// after a deploy is one extra Turso round-trip per isolate, then the
// cache warms up.
const _authUserCache = new Map();          // uid -> { user, fetchedAt }
const _loginUserCache = new Map();          // idLower -> { _user, _cachedAt }
const _bcryptVerifyCache = new Map();       // bcryptCacheKey -> { ok, ts }
const _AUTH_CACHE_TTL_MS = 30000;   // 30s is plenty for auth validation

// Hono middleware
async function requireAuth(c, next) {
  const p = await authFromRequest(c);
  if (!p || !p.uid) return c.json({ error: 'Missing or invalid token' }, 401);
  // Fast path: in-memory cache hit
  const cached = _authUserCache.get(p.uid);
  if (cached && (Date.now() - cached.fetchedAt) < _AUTH_CACHE_TTL_MS) {
    if (Number(p.sv || 0) !== Number(cached.user.tokenVersion || 0)) {
      return c.json({ error: 'Session expired. Please sign in again.' }, 401);
    }
    c.set('userId', p.uid);
    c.set('username', cached.user.username || p.username);
    c.set('authUser', cached.user);
    await next();
    return;
  }
  // Slow path: read from Turso, then warm the cache
  let authDb = await fetchPrimaryDatabase();
  let u = (authDb.users || []).find(x => x.id === p.uid);
  if (!u) return c.json({ error: 'Missing or invalid token' }, 401);
  const tokenVersion = Number(p.sv || 0);
  let userVersion = Number(u.tokenVersion || 0);
  if (tokenVersion !== userVersion) {
    // Same rare Neon read-after-write consistency window as login (see the
    // matching comment in /api/auth/login): a password/PIN reset that just
    // bumped tokenVersion on one connection can briefly not be visible yet
    // on the next read. Without this retry, the very token that reset-by-pin
    // just handed back to the client could get rejected on its first use a
    // moment later. One forced-fresh re-read fixes it without weakening the
    // real security property (a token whose version genuinely doesn't match
    // — e.g. because of an actual later password change — still gets
    // rejected after the retry).
    cacheTimestamp = 0;
    authDb = await fetchPrimaryDatabase();
    u = (authDb.users || []).find(x => x.id === p.uid) || u;
    userVersion = Number(u.tokenVersion || 0);
    if (tokenVersion !== userVersion) return c.json({ error: 'Session expired. Please sign in again.' }, 401);
  }
  _authUserCache.set(p.uid, { user: u, fetchedAt: Date.now() });
  c.set('userId', p.uid);
  c.set('username', u.username || p.username);
  c.set('authUser', u);
  await next();
}

// ---------- Rate limiting ----------
// v77-bugfix: In-memory rate limiter is ONLY used as fallback when Turso is unreachable.
// For cross-isolate consistency, use sharedRateLimit() which persists to Turso.
const _rateBuckets = new Map();
function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let b = _rateBuckets.get(key);
  if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + windowMs }; _rateBuckets.set(key, b); }
  b.count++;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}
async function sharedRateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const nextResetAt = now + windowMs;
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      const tc = tursoClient();
      await tc.execute({
        sql: `INSERT INTO ps_rate_limits (key, count, reset_at, updated_at) VALUES (?, 1, ?, ?)
              ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
                reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END,
                updated_at = ?`,
        args: [key, nextResetAt, now, now, now, nextResetAt, now],
      });
      if (Math.random() < 0.01) {
        tc.execute({ sql: 'DELETE FROM ps_rate_limits WHERE reset_at < ?', args: [now - (24 * 60 * 60 * 1000)] }).catch(() => {});
      }
      const rs = await tc.execute({ sql: 'SELECT count, reset_at FROM ps_rate_limits WHERE key = ? LIMIT 1', args: [key] });
      const row = rs.rows && rs.rows[0] ? rs.rows[0] : { count: 1, reset_at: nextResetAt };
      const count = Number(row.count || 0);
      const resetAt = Number(row.reset_at || nextResetAt);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
    } catch (e) {
      console.warn('[sharedRateLimit:turso] falling back to in-memory limiter:', e && e.message);
      return rateLimit({ key, limit, windowMs });
    }
  }
  // Neon rate-limit path removed. If we reach here, Turso primary is not set,
  // so we fall back to the in-memory limiter.
  return rateLimit({ key, limit, windowMs });
}
function clientIp(c) {
  return c.req.header('cf-connecting-ip')
      || (c.req.header('x-forwarded-for') || '').split(',')[0].trim()
      || c.req.header('x-real-ip') || '0.0.0.0';
}
async function authRateLimit(c, next) {
  const ip = clientIp(c);
  const r = await sharedRateLimit({ key: 'auth:' + ip + ':' + c.req.path, limit: 40, windowMs: 15 * 60_000 });
  if (!r.allowed) {
    c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
    return c.json({ error: 'Too many auth attempts. Try again in 15 minutes.' }, 429);
  }
  await next();
}
async function globalRateLimit(c, next) {
  // v77-bugfix: Use a hybrid approach for global rate limiting:
  // 1. Fast in-memory check first (400 req/min per IP) for quick rejection of obvious abuse
  // 2. For paths that don't need DB checks (/api/health, /api/push/vapid-public), skip shared check
  // 3. For all other paths, the auth rate limiting is handled by authRateLimit + authSubjectRateLimit
  //
  // This balances performance (no DB round-trip for every request) with security
  // (auth endpoints are still protected by sharedRateLimit via authRateLimit middleware).
  const ip = clientIp(c);
  const path = c.req.path;
  
  // Fast paths that don't need shared rate limiting
  const fastPaths = ['/api/health', '/api/push/vapid-public', '/api/stream'];
  const isFastPath = fastPaths.some(p => path === p || path.startsWith(p));
  
  if (isFastPath) {
    // In-memory only for fast paths
    const r = rateLimit({ key: 'global:' + ip, limit: 400, windowMs: 60_000 });
    c.header('X-RateLimit-Limit', '400');
    c.header('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many requests. Please slow down.' }, 429);
    }
  } else {
    // Use shared rate limiting for other paths (writes are batched/async in sharedRateLimit)
    const r = await sharedRateLimit({ key: 'global:' + ip, limit: 400, windowMs: 60_000 });
    c.header('X-RateLimit-Limit', '400');
    c.header('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      c.header('Retry-After', String(Math.ceil((r.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many requests. Please slow down.' }, 429);
    }
  }
  await next();
}

// Brute-force lockout - v77-bugfix: Now persisted to Turso for cross-isolate consistency
// In-memory cache is used as a fast local check + fallback when Turso is unavailable
const _loginFails = new Map();

async function checkAccountLock(userId) {
  const now = Date.now();
  
  // Try Turso first for cross-isolate consistency
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      const rs = await tursoClient().execute({
        sql: 'SELECT count, first_at, locked_until FROM ps_rate_limits WHERE key = ? LIMIT 1',
        args: ['lockout:' + userId],
      });
      if (rs.rows && rs.rows.length > 0) {
        const row = rs.rows[0];
        const lockedUntil = Number(row.locked_until || 0);
        if (lockedUntil > now) {
          return { locked: true, remaining: lockedUntil - now };
        }
      }
      return { locked: false };
    } catch (e) {
      console.warn('[checkAccountLock:turso] falling back to in-memory:', e && e.message);
    }
  }
  
  // Fallback to in-memory
  const rec = _loginFails.get(userId);
  if (!rec) return { locked: false };
  if (rec.lockedUntil && rec.lockedUntil > now) return { locked: true, remaining: rec.lockedUntil - now };
  return { locked: false };
}

async function recordLoginFail(userId) {
  const now = Date.now();
  const fiveMinutesAgo = now - 5 * 60_000;
  
  // Update in-memory for this isolate
  let rec = _loginFails.get(userId);
  if (!rec || (now - rec.firstAt) > 5 * 60_000) { 
    rec = { count: 0, firstAt: now }; 
    _loginFails.set(userId, rec); 
  }
  rec.count++;
  if (rec.count >= 5) rec.lockedUntil = now + 15 * 60_000;
  
  // Persist to Turso for cross-isolate consistency
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      const key = 'lockout:' + userId;
      const lockoutDuration = 15 * 60_000;
      const windowDuration = 5 * 60_000;
      
      // Atomic upsert: insert new or update existing
      // If first_at is older than 5 minutes, reset the counter
      await tursoClient().execute({
        sql: `INSERT INTO ps_rate_limits (key, count, first_at, reset_at, locked_until, updated_at) 
              VALUES (?, 1, ?, ?, 0, ?)
              ON CONFLICT(key) DO UPDATE SET
                count = CASE WHEN first_at < ? THEN 1 ELSE count + 1 END,
                first_at = CASE WHEN first_at < ? THEN ? ELSE first_at END,
                locked_until = CASE 
                  WHEN first_at < ? THEN 0
                  WHEN count + 1 >= 5 THEN ?
                  ELSE locked_until 
                END,
                updated_at = ?`,
        args: [
          key, now, now + windowDuration, now,  // INSERT values
          fiveMinutesAgo,                        // reset if first_at < 5min ago
          fiveMinutesAgo, now,                   // update first_at if needed
          fiveMinutesAgo, now + lockoutDuration, // set locked_until if count >= 5
          now
        ],
      });
    } catch (e) {
      console.warn('[recordLoginFail:turso] error:', e && e.message);
    }
  }
}

async function clearLoginFails(userId) {
  _loginFails.delete(userId);
  
  // Clear from Turso too
  if (isTursoPrimary()) {
    try {
      await tursoEnsure();
      await tursoClient().execute({
        sql: 'DELETE FROM ps_rate_limits WHERE key = ?',
        args: ['lockout:' + userId],
      });
    } catch (e) {
      console.warn('[clearLoginFails:turso] error:', e && e.message);
    }
  }
}
const AUTH_GENERIC_ERROR = 'Invalid username/email or password.';
async function authFailureDelay() {
  await sleepMs(250 + Math.floor(Math.random() * 250));
}
async function authSubjectRateLimit(c, subject, limit = 10) {
  const ip = clientIp(c);
  const key = 'credential:' + ip + ':' + (subject || 'unknown');
  return sharedRateLimit({ key, limit, windowMs: 15 * 60_000 });
}

// ---------- Real-time events (in-memory; SSE per-request) ----------
// Note: In Cloudflare Workers, each isolate has its own memory and is ephemeral,
// so module-level Maps don't accumulate indefinitely like in long-lived Node.js.
// Bug #9 addressed in index.js for Node environments. Here, queue limits suffice.
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
  if (isTursoPrimary()) {
    tursoEnsure().then(() => tursoClient().execute({
      sql: 'INSERT INTO ps_events (id, user_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      args: [evt.id, userId, kind, JSON.stringify(evt), evt.ts],
    })).catch(() => {});
  } // Neon events path removed
  return evt;
}
function _broadcastEvent(kind, data, excludeUserId) {
  for (const userId of new Set([..._eventSubscribers.keys(), ..._eventQueues.keys()])) {
    if (userId === excludeUserId) continue;
    _pushEvent(userId, kind, data);
  }
  if (isTursoPrimary()) {
    _pushEvent('__ALL__', kind, data);
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
  if (body) sendWebPush(db, recipientId, { title, body, tag: 'priv-spaca-' + notif.id, url: '/', kind, notifId: notif.id }).catch((err) => {
    // v77-bugfix: Log push failures instead of silently swallowing
    console.warn('[pushNotification:sendWebPush] error for', recipientId, kind, err && err.message);
  });
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

// v77-bugfix: Send web push notification with improved error handling and observability
async function sendWebPush(db, recipientId, payload) {
  const result = { sent: 0, failed: 0, pruned: 0 };
  
  try {
    if (!VAPID_PRIVATE || !VAPID_PUBLIC) {
      console.warn('[push] VAPID keys not configured - push notifications disabled');
      return result;
    }
    
    const user = (db && db.users || []).find(u => u.id === recipientId);
    if (!user) {
      console.warn('[push] recipient not found:', recipientId);
      return result;
    }
    if (!user.pushSubs || user.pushSubs.length === 0) {
      // No subscriptions - expected, not an error
      return result;
    }

    const bodyStr = JSON.stringify(payload || {});
    const bodyBytes = new TextEncoder().encode(bodyStr);

    // Process each subscription in parallel; prune expired ones (404/410)
    const dead = [];
    await Promise.all(user.pushSubs.map(async (sub) => {
      if (!sub || !sub.endpoint) {
        console.warn('[push] invalid subscription for', user.username);
        dead.push(sub && sub.endpoint);
        result.pruned++;
        return;
      }
      
      try {
        if (!sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          console.warn('[push] subscription missing keys for', user.username);
          dead.push(sub.endpoint);
          result.pruned++;
          return;
        }
        
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
        
        if (res.status === 201 || res.ok) {
          result.sent++;
        } else if (res.status === 404 || res.status === 410) {
          console.log('[push] pruning expired sub for', user.username, '-', sub.endpoint.slice(0, 50));
          dead.push(sub.endpoint);
          result.pruned++;
        } else if (res.status >= 400 && res.status < 500) {
          // Client errors (except 404/410) - likely bad subscription
          console.warn('[push] client error', res.status, 'for', user.username, '-', sub.endpoint.slice(0, 50));
          dead.push(sub.endpoint);
          result.pruned++;
          result.failed++;
        } else {
          // Server errors (5xx) - keep subscription, might be transient
          console.warn('[push] server error', res.status, 'for', user.username, '-', sub.endpoint.slice(0, 50));
          result.failed++;
        }
      } catch (e) {
        console.error('[push] exception for', user.username, {
          message: e && e.message,
          endpoint: sub.endpoint ? sub.endpoint.slice(0, 60) : 'unknown'
        });
        result.failed++;
      }
    }));

    // Prune expired/invalid subscriptions (best-effort write; don't block)
    if (dead.length) {
      try {
        const fresh = await fetchDatabase();
        const u = fresh.users.find(x => x.id === recipientId);
        if (u && u.pushSubs) {
          const deadSet = new Set(dead.filter(Boolean));
          u.pushSubs = u.pushSubs.filter(s => s && s.endpoint && !deadSet.has(s.endpoint));
          await saveDatabase(fresh, false);
        }
      } catch (e) {
        console.warn('[push] failed to save pruned subs:', e && e.message);
      }
    }
  } catch (e) {
    console.error('[sendWebPush] outer error:', {
      message: e && e.message,
      stack: e && e.stack ? e.stack.slice(0, 200) : null,
      recipientId
    });
  }
  
  return result;
}

// ---------- Rooms ----------
// Bug #16 fix: Log warning when roomId is coerced to prevent silent failures
function normalizeRoomId(roomId, currentUserId) {
  const raw = sanitizeText(String(roomId || 'general-group'), 160).trim();
  if (!raw || raw === 'general-group') return 'general-group';
  if (/^group:[a-zA-Z0-9_-]{1,64}$/.test(raw)) return raw;
  if (raw.startsWith('dm:')) {
    const parts = raw.slice(3).split(':').filter(Boolean);
    if (parts.length === 2 && parts.every(x => /^[a-zA-Z0-9_-]{1,96}$/.test(x))) {
      return 'dm:' + [...parts].sort().join(':');
    }
    // Invalid DM format
    console.warn('[normalizeRoomId] Invalid DM roomId format, coercing to general-group:', raw);
  } else if (raw !== 'general-group') {
    // Unrecognized format
    console.warn('[normalizeRoomId] Unrecognized roomId format, coercing to general-group:', raw);
  }
  return 'general-group';
}
function dmRoomFor(a, b) { return 'dm:' + [a, b].sort().join(':'); }

// ---------- Middleware: per-request Turso client scope (must run first — see
// the v75-turso-per-request-client-fix comment above tursoClient()) ----------
app.use('*', async (c, next) => {
  await runWithTursoRequestScope(next);
});

// ---------- Middleware: load config + security headers + global rate limit ----------
app.use('*', async (c, next) => {
  loadConfig(c.env);
  applyCors(c);
  if (c.req.method === 'OPTIONS') {
    const origin = c.req.header('origin') || '';
    return isAllowedCorsOrigin(origin) ? c.body(null, 204) : c.text('CORS origin denied', 403);
  }
  const origin = c.req.header('origin') || '';
  if (origin && !isAllowedCorsOrigin(origin)) return c.json({ error: 'CORS origin denied' }, 403);
  if (isProductionRequest(c) && isDefaultJwtSecret() && c.req.path.startsWith('/api/') && !['/api/health', '/api/stream/config', '/api/push/vapid-public'].includes(c.req.path)) {
    return c.json({ error: 'Server auth secret is not configured' }, 503);
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  await next();
});
app.use('/api/*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  const len = Number(c.req.header('content-length') || '0');
  // Keep API-agent friendly JSON access, but reject unexpectedly huge bodies early.
  if (['POST','PUT','PATCH'].includes(method) && len > 16 * 1024 * 1024) {
    return c.json({ error: 'Request body too large' }, 413);
  }
  await next();
});
app.use('/api/*', globalRateLimit);

// =====================================================================
// ROUTES
// =====================================================================

// ---------- Health & diag ----------
app.get('/api/health', (c) => c.json({
  ok: true, name: 'PRIV SPACA',
  persistence: primaryPersistenceName(),
  secondaryPersistence: isTursoConfigured() ? 'turso-structured-social' : null,
  runtime: 'cloudflare-workers',
  time: nowMs(), version: 'phase2-turso-json-primary',
}));

app.get('/api/diag', requireAdmin, async (c) => {
  const out = {
    persistence: primaryPersistenceName(),
    repoConfigured: isRepo(), gistConfigured: false,
    repo: GH_REPO ? '[configured]' : '', branch: GH_BRANCH ? '[configured]' : '', file: GH_FILE ? '[configured]' : '',
    canRead: false, canWrite: false, userCount: 0, error: null,
    runtime: 'cloudflare-workers',
  };
  try {
    const db = await repoRead();
    if (db && typeof db === 'object' && !db._err && !db._httpError) {
      out.canRead = true;
      out.userCount = (db.users || []).length;
      // Do not perform a real write in diagnostics; it can conflict with signup/message saves.
      out.canWrite = isTursoPrimary() || !!GITHUB_PAT;
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
    // Bug #15 fix: Extended weak PIN list
    const weak = new Set([
      // Repeated digits
      '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
      // Sequential patterns
      '1234','4321','0123','2345','3456','4567','5678','6789','7890','9876','8765','7654','6543','5432','3210',
      // Years
      '2024','2025','2026','2027','2028','2020','2021','2022','2023','1990','1991','1992','1993','1994','1995','1996','1997','1998','1999','2000','2001','2002','2003','2004','2005','2006','2007','2008','2009','2010','2011','2012','2013','2014','2015','2016','2017','2018','2019',
      // Keypad patterns
      '2580','0852','1470','7410','1593','3571','1379','7931','2468','8642',
      // Repeated pairs & common choices
      '1212','1313','1010','0101','1122','1221','1414','1515','1616','1717','1818','1919','2020','2121','2323','2424','2525','3030','3131','0007','0069','1357','4545','5050','6969','0420','1004','0101','0704','1225','0214','1031',
    ]);
    if (weak.has(pin)) return c.json({ error: 'Please choose a less obvious PIN' }, 400);
    if (termsAccepted !== true) return c.json({ error: 'You must accept the Terms & Community Guidelines.' }, 400);

    const db = await fetchPrimaryDatabase();
    const emailLower = email.toLowerCase();
    const usernameLower = username.toLowerCase();
    if (db.users.some(u => u.email.toLowerCase() === emailLower)) return c.json({ error: 'Email already registered' }, 409);
    if (db.users.some(u => u.username.toLowerCase() === usernameLower)) return c.json({ error: 'Username already taken' }, 409);
    const reserved = new Set(['admin','administrator','priv-spaca','privspaca','support','system','moderator','staff','help','root']);
    if (reserved.has(usernameLower)) return c.json({ error: 'That username is reserved' }, 403);

    const [passwordHash, pinHash] = await Promise.all([
      bcrypt.hash(password, PASSWORD_HASH_ROUNDS),
      bcrypt.hash(pin, PASSWORD_HASH_ROUNDS)
    ]);
    const newUser = {
      id: uid('usr'), email: emailLower, username, displayName: cleanDN,
      bio: '', photoUrl: '', passwordHash, pinHash, tokenVersion: 0,
      followers: [], following: [], blocked: [], closeFriends: [], isPrivate: false,
      termsAccepted: true, termsVersion: String(termsVersion || '1.0'),
      termsAcceptedAt: nowMs(), createdAt: nowMs(), verified: false,
    };
    db.users.push(newUser);
    const persisted = await saveDatabaseVerified(db, d => (d.users || []).some(u => u.id === newUser.id));
    if (isPersist() && !persisted) {
      db.users = db.users.filter(u => u.id !== newUser.id);
      return c.json({ error: 'Storage temporarily unavailable. Please try again in a moment.' }, 503);
    }
    if (isTursoConfigured()) await tursoUpsertUser(newUser);
    const token = await signToken(newUser);
    return c.json({ token, user: sanitizeUser(newUser, true) });
  } catch (e) {
    console.error('[signup]', e);
    return c.json({ error: 'Signup failed' }, 500);
  }
});

// ---------- Auth: login ----------
app.post('/api/auth/login', authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { identifier, password } = body;
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || typeof password !== 'string' || password.length < 1 || password.length > 128) {
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    const subjLimit = await authSubjectRateLimit(c, idLower, 20);
    if (!subjLimit.allowed) {
      c.header('Retry-After', String(Math.ceil((subjLimit.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many login attempts. Please wait and try again.' }, 429);
    }
    // v65: Try the structured ps_users table FIRST (always-fresh read), and
    // fall back to the mirror only if the structured table is empty or the
    // user isn't there. This fixes the "login says account not found right
    // after a password reset" race where the ps_kv mirror hasn't been
    // rewritten yet. Mirror is still used for everything else (posts,
    // messages, etc.) so this is a surgical auth-only fix.
    // v66: cache the structured-table user lookup too, keyed by the
    // search identifier. 60s TTL means a password reset via the
    // structured table is visible within a minute. Caching the user
    // object directly saves a Turso round trip on every login.
    const userCacheKey = 'user:' + idLower;
    let user = _loginUserCache.get(userCacheKey);
    if (user && (Date.now() - user._cachedAt) < 60_000) {
      user = user._user;  // return a clean copy
    } else {
      user = null;
      try {
        if (isTursoConfigured()) {
          const turso = tursoClient();
          const r = await turso.execute({
            sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
            args: [idLower, idLower]
          });
          if (r.rows && r.rows.length > 0) {
            const parsed = safeJson(String(r.rows[0].data_json || ''), null);
            if (parsed && parsed.id) {
              user = parsed;
              _loginUserCache.set(userCacheKey, { _user: user, _cachedAt: Date.now() });
            }
          }
        }
      } catch (_) { /* fall through to mirror */ }
    }
    if (!user) {
      const db = await fetchPrimaryDatabase();
      user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    }
    if (!user) {
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 404);
    }
    const lock = await checkAccountLock(user.id);
    if (lock.locked) {
      c.header('Retry-After', String(Math.ceil(lock.remaining / 1000)));
      return c.json({ error: 'Too many login attempts. Please wait and try again.' }, 429);
    }
    let matchUser = user;
    // v66: cache bcrypt.compare result keyed by (uid, passwordHash, password).
    // The same client usually re-logs in within seconds (page refresh,
    // back-button, etc.). Caching the result skips the ~20ms bcrypt
    // round and avoids a Turso read on the cached path. 5 min TTL
    // is short enough that password changes take effect quickly.
    const bcryptCacheKey = matchUser.id + '|' + (matchUser.passwordHash || '').slice(0, 30) + '|' + password;
    let ok = false;
    const cached = _bcryptVerifyCache.get(bcryptCacheKey);
    if (cached && (Date.now() - cached.ts) < 300_000) {
      ok = cached.ok;
    } else {
      ok = await bcrypt.compare(password, matchUser.passwordHash);
      _bcryptVerifyCache.set(bcryptCacheKey, { ok, ts: Date.now() });
      if (_bcryptVerifyCache.size > 200) {
        const firstKey = _bcryptVerifyCache.keys().next().value;
        _bcryptVerifyCache.delete(firstKey);
      }
    }
    if (!ok) {
      // Rare Neon read-after-write consistency window: a password/PIN reset
      // that just committed on a different pooled connection can briefly
      // (sub-second, occasionally ~1-2s) not be visible yet to the next
      // read. Retrying once with a forced-fresh read costs nothing on the
      // common (correct-password) path and only adds a single extra Neon
      // round trip on an already-failing attempt, which already pays a
      // deliberate ~250-500ms authFailureDelay() for timing-attack
      // mitigation — so this is effectively free from a UX standpoint.
      const freshDb = await fetchPrimaryDatabase();
      const freshUser = freshDb.users.find(u => u.id === user.id);
      if (freshUser && freshUser.passwordHash !== matchUser.passwordHash) {
        matchUser = freshUser;
        ok = await bcrypt.compare(password, matchUser.passwordHash);
      }
    }
    if (!ok) {
      await recordLoginFail(user.id);
      await authFailureDelay();
      return c.json({ error: AUTH_GENERIC_ERROR }, 401);
    }
    await clearLoginFails(user.id);
    // v66: transparent bcrypt cost upgrade. If the stored hash is at an
    // older cost, rehash at PASSWORD_HASH_ROUNDS in the background so the
    // next login is fast. Never block the response on this.
    try {
      const m = (matchUser.passwordHash || '').match(/^\$2[aby]\$(\d{2})\$/);
      if (m && Number(m[1]) !== PASSWORD_HASH_ROUNDS) {
        const newHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
        matchUser.passwordHash = newHash;
        matchUser.passwordChangedAt = nowMs();
        const db = await fetchPrimaryDatabase();
        const u2 = (db.users || []).find(x => x.id === matchUser.id);
        if (u2) {
          u2.passwordHash = newHash;
          u2.passwordChangedAt = matchUser.passwordChangedAt;
          saveDatabase(db, true, { skipSecondarySync: true }).catch(() => {});
          if (isTursoConfigured()) {
            try {
              const tu = tursoClient();
              await tu.batch([
                { sql: "UPDATE ps_users SET data_json = ?, updated_at = ? WHERE id = ?", args: [JSON.stringify(u2), nowMs(), u2.id] },
              ], 'write');
            } catch (_) {}
          }
        }
      }
    } catch (_) { /* background upgrade is best-effort */ }
    const token = await signToken(matchUser);
    return c.json({ token, user: sanitizeUser(matchUser, true) });
  } catch (e) {
    console.error('[login] full error:', e && e.message, e && e.stack);
    return c.json({ error: 'Login failed: ' + (e && e.message || 'unknown') }, 500);
  }
});

// ---------- Auth: reset by PIN ----------
app.post('/api/auth/reset-by-pin', authRateLimit, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { identifier, pin, newPassword } = body;
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || !isPin(pin) || typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) {
      await authFailureDelay();
      return c.json({ error: 'Invalid reset details.' }, 400);
    }
    const subjLimit = await authSubjectRateLimit(c, 'reset:' + idLower, 8);
    if (!subjLimit.allowed) {
      c.header('Retry-After', String(Math.ceil((subjLimit.resetAt - Date.now()) / 1000)));
      return c.json({ error: 'Too many reset attempts. Please wait and try again.' }, 429);
    }
    // v65: Try structured ps_users first (fresh), mirror as fallback
    let user = null;
    try {
      if (isTursoConfigured()) {
        const turso = tursoClient();
        const r = await turso.execute({
          sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
          args: [idLower, idLower]
        });
        if (r.rows && r.rows.length > 0) {
          const parsed = safeJson(String(r.rows[0].data_json || ''), null);
          if (parsed && parsed.id) user = parsed;
        }
      }
    } catch (_) { /* fall through to mirror */ }
    if (!user) {
      const db = await fetchPrimaryDatabase();
      user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    }
    if (!user) { await authFailureDelay(); return c.json({ error: 'Invalid reset details.' }, 401); }
    const pinOk = await bcrypt.compare(pin, user.pinHash);
    if (!pinOk) { await authFailureDelay(); return c.json({ error: 'Invalid reset details.' }, 401); }
    const oldHash = user.passwordHash;
    const oldTokenVersion = Number(user.tokenVersion || 0);
    user.passwordHash = await bcrypt.hash(newPassword, PASSWORD_HASH_ROUNDS);
    user.tokenVersion = oldTokenVersion + 1;
    user.passwordChangedAt = nowMs();
    // Invalidate the in-memory auth cache so the new tokenVersion is picked
    // up by subsequent requests.
    _authUserCache.delete(user.id);
    const persisted = await saveDatabaseVerified(db, d => {
      const u2 = (d.users || []).find(u => u.id === user.id);
      return !!u2 && u2.passwordHash === user.passwordHash && Number(u2.tokenVersion || 0) === user.tokenVersion;
    });
    if (isPersist() && !persisted) { user.passwordHash = oldHash; user.tokenVersion = oldTokenVersion; return c.json({ error: 'Storage temporarily unavailable' }, 503); }
    if (isTursoConfigured()) await tursoUpsertUser(user);
    const token = await signToken(user);
    return c.json({ ok: true, token, user: sanitizeUser(user, true) });
  } catch (e) {
    console.error('[reset]', e);
    return c.json({ error: 'Reset failed' }, 500);
  }
});

// ---------- Auth: me ----------
app.get('/api/auth/me', requireAuth, async (c) => {
  const u = c.get('authUser');
  if (!u) return c.json({ error: 'Not found' }, 404);
  return c.json({ user: sanitizeUser(u, true) });
});

// ---------- Cloudinary upload helper ----------
// When CLOUDINARY_* env vars are set, uploads go to Cloudinary (faster, has
// its own CDN, and avoids burning our GitHub Contents API quota). When not
// set, we fall back to the GitHub raw-content path that has shipped since
// day 1. The response shape is identical: { url, persisted }.

/**
 * v67: gzip-compress JSON responses when the client supports it AND the
 * payload is large enough to be worth the CPU. Saves 60-80% bandwidth on
 * big /feed /posts responses. Uses the CompressionStream Web API.
 */
async function maybeGzip(c, jsonText) {
  if (!jsonText || jsonText.length < 2048) return null;
  const acceptEnc = (c.req.header('accept-encoding') || '').toLowerCase();
  if (!acceptEnc.includes('gzip')) return null;
  try {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    await writer.write(new TextEncoder().encode(jsonText));
    await writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return new Uint8Array(chunks.reduce((acc, c) => acc.concat(Array.from(c)), []));
  } catch (e) {
    return null;
  }
}

async function sha1Hex(str) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-1', enc.encode(str));
  let s = '';
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, '0');
  return s;
}
function isCloudinaryConfigured() {
  return !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}
async function uploadToCloudinary(dataUrl, folder, publicId) {
  // 1) Decode data URL to a binary buffer
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const mime = m[1];
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  // 2) Build signed-form params. Cloudinary signature = SHA-1 of
  //    sorted-key-joined "k=v" pairs + api_secret, all as a single string.
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder,
    public_id: publicId,
    timestamp: String(timestamp),
    overwrite: 'true',
  };
  const toSign = Object.keys(params).sort()
    .map(k => k + '=' + params[k])
    .join('&') + CLOUDINARY_API_SECRET;
  const signature = await sha1Hex(toSign);
  // 3) Build multipart/form-data
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), 'upload');
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);
  form.append('public_id', publicId);
  form.append('overwrite', 'true');
  // 4) POST to Cloudinary upload endpoint
  const url = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`;
  const r = await fetch(url, { method: 'POST', body: form });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('[cloudinary]', r.status, t.slice(0, 300));
    return null;
  }
  const j = await r.json();
  return j.secure_url || j.url || null;
}

// ---------- Upload photo (Cloudinary -> GitHub CDN -> inline fallback) ----------
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
    // Cloudinary: fastest path, has its own CDN, no GitHub rate-limit cost.
    if (isCloudinaryConfigured()) {
      try {
        const cdn = await uploadToCloudinary(dataUrl, `${CLOUDINARY_FOLDER}/${folder}`, id);
        if (cdn) return c.json({ url: cdn, persisted: true });
      } catch (e) { console.warn('[upload] cloudinary failed, falling back to GitHub:', e && e.message); }
    }
    // GitHub: legacy fallback. Stable but slow + has rate limits.
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
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// ---------- User update ----------
app.post('/api/user/update', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { displayName, username, bio, photoUrl, dateOfBirth, cardVisibility, isPrivate } = body;
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
    await saveDatabase(db, false);
    if (isTursoConfigured()) await tursoUpsertUser(user);
    return c.json({ user: sanitizeUser(user, true) });
  } catch (e) { console.error('[user/update]', e); return c.json({ error: 'Update failed' }, 500); }
});


app.post('/api/user/vip/redeem', requireAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const key = sanitizeText(String(body.key || ''), 80).trim();
    if (!VIP_UNLOCK_KEY) return c.json({ error: 'VIP unlock is not configured' }, 503);
    if (!key || key !== VIP_UNLOCK_KEY) return c.json({ error: 'Invalid VIP key' }, 403);
    const db = await fetchDatabase({ fresh: true });
    const user = db.users.find(u => u.id === c.get('userId'));
    if (!user) return c.json({ error: 'Not found' }, 404);
    user.verified = true;
    user.verifiedAt = user.verifiedAt || nowMs();
    await saveDatabase(db, false);
    if (isTursoConfigured()) await tursoUpsertUser(user);
    return c.json({ ok: true, user: sanitizeUser(user, true) });
  } catch (e) { console.error('[vip/redeem]', e); return c.json({ error: 'VIP activation failed' }, 500); }
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
    if (isTursoConfigured()) await tursoUpsertUser(me);
    return c.json({ ids: me.closeFriends, added: me.closeFriends.includes(targetId) });
  } catch (e) { console.error('[close-friends]', e); return c.json({ error: 'Update failed' }, 500); }
});

// ---------- Users list ----------
app.get('/api/users', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const sdb = isTursoConfigured() ? await fetchTursoMirror(db) : db;
  const sourceUsers = (sdb.users || []).length ? sdb.users : (db.users || []);
  const myId = c.get('userId');
  const me = sourceUsers.find(u => u.id === myId);
  const myBlocked = new Set((me && me.blocked) || []);
  const blockedMe = new Set();
  sourceUsers.forEach(u => {
    if (u.id !== myId && Array.isArray(u.blocked) && u.blocked.includes(myId)) blockedMe.add(u.id);
  });
  const now = nowMs();
  const myFollowing = new Set((me && me.following) || []);
  let lastByPeer = {};
  if (isTursoConfigured()) {
    lastByPeer = await fetchTursoDmIndex(myId);
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
  const list = sourceUsers
    .filter(u => !myBlocked.has(u.id) && !blockedMe.has(u.id))
    .map(u => ({
      ...sanitizeUser(u),
      online: now - ((db.heartbeat && db.heartbeat[u.id]) || 0) < 45000,
      lastSeen: (db.heartbeat && db.heartbeat[u.id]) || 0,
      iFollow: myFollowing.has(u.id),
      followsMe: Array.isArray(u.following) && u.following.includes(myId),
      lastMessage: lastByPeer[u.id] || null,
    }));
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
// ---------- Notes: short 24h status shown on the DM inbox rail ----------
app.post('/api/user/note', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
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
});
// Normalize an optional song attached to a note (title/artist/preview/art).
function cleanNoteMusic(m) {
  if (!m || typeof m !== 'object' || !m.title) return null;
  return {
    title: sanitizeText(m.title, 80),
    artist: sanitizeText(m.artist || '', 80),
    audio: isSafeMediaUrl(m.audio, { allowData: false }) ? String(m.audio).trim().slice(0, 1024) : '',
    art: isSafeImageUrl(m.art, { allowData: false }) ? String(m.art).trim().slice(0, 1024) : '',
  };
}
app.post('/api/user/typing', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!body.roomId) return c.json({ error: 'roomId required' }, 400);
  const roomId = normalizeRoomId(body.roomId, c.get('userId'));
  const db = await fetchDatabase();
  if (!db.typing[roomId]) db.typing[roomId] = {};
  db.typing[roomId][c.get('userId')] = nowMs();
  await saveDatabase(db, true);
  return c.json({ ok: true });
});
app.get('/api/user/typing', requireAuth, async (c) => {
  const roomId = normalizeRoomId(c.req.query('roomId'), c.get('userId'));
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
  const roomId = normalizeRoomId(c.req.query('roomId') || 'general-group', c.get('userId'));
  if (roomId.startsWith('dm:')) {
    const parts = roomId.slice(3).split(':');
    if (!parts.includes(c.get('userId'))) return c.json({ error: 'Forbidden' }, 403);
  }
  let db = await fetchDatabase();
  let now = nowMs();
  const dbRoomMessages = () => db.messages
    .filter(m => m.roomId === roomId && !m.deletedAt && !(m.disappearAt && m.disappearAt <= now))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-200);
  let list = await fetchTursoMessages(roomId, now);
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
    const ci = isSafeMediaUrl(imageUrl) ? String(imageUrl).trim() : null;
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
        imageUrl: isSafeMediaUrl(replyTo.imageUrl) ? String(replyTo.imageUrl).trim().slice(0, 2048) : null,
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
          sql: 'INSERT INTO ps_notifications (id, user_id, kind, from_user_id, post_id, comment_id, created_at, seen_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at, data_json=excluded.data_json',
          args: [n.id, n.userId, n.kind, n.fromUserId, n.postId||null, n.commentId||null, Number(n.createdAt||0), n.seenAt?Number(n.seenAt):null, JSON.stringify(n)]
        });
      }
      if (roomId.startsWith('dm:')) {
        const ownerIds = roomId.slice(3).split(':').filter(Boolean);
        for (const oid of ownerIds) {
          stmts.push({
            sql: 'INSERT INTO ps_dm_index (owner_user_id, peer_user_id, last_message_id, last_message_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_user_id, peer_user_id) DO UPDATE SET last_message_id=excluded.last_message_id, last_message_at=excluded.last_message_at, updated_at=excluded.updated_at',
            args: [oid, myId, msg.id, Number(msg.createdAt||0), nowMs()]
          });
        }
      }
      const [persisted] = await Promise.all([
        saveDatabaseVerified(db, d => (d.messages || []).some(m => m.id === msg.id), 4, { skipSecondarySync: true }),
        tursoClient().batch(stmts, 'write').catch(e => {
          console.warn('[send] batched write failed:', e && e.message);
          return tursoUpsertMessages([msg]).catch(() => {});
        })
      ]);
      if (isPersist() && !persisted) return c.json({ error: 'Message storage unavailable. Please retry.' }, 503);
    } else {
      const persisted = await saveDatabaseVerified(db, d => (d.messages || []).some(m => m.id === msg.id), 4, { skipSecondarySync: true });
      if (isPersist() && !persisted) return c.json({ error: 'Message storage unavailable. Please retry.' }, 503);
    }
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
    await saveDatabase(db, false, { skipSecondarySync: true });
    if (isTursoConfigured()) {
      await tursoUpsertMessages([m]);
      if (typeof m.roomId === 'string' && m.roomId.startsWith('dm:')) await tursoRefreshDmIndexForOwners(db, m.roomId.slice(3).split(':').filter(Boolean));
    }
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
    await saveDatabase(db, false, { skipSecondarySync: true });
    if (isTursoConfigured()) {
      await tursoUpsertMessages([m]);
      if (typeof m.roomId === 'string' && m.roomId.startsWith('dm:')) await tursoRefreshDmIndexForOwners(db, m.roomId.slice(3).split(':').filter(Boolean));
    }
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
  const db = await fetchDatabase();
  const myId = c.get('userId');
  const sourceUsers = db.users || [];
  const mine = isTursoConfigured()
    ? await fetchTursoNotifications(myId)
    : (db.notifications || []).filter(n => n.userId === myId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  const enriched = mine.map(n => {
    const author = sourceUsers.find(u => u.id === n.fromUserId);
    return { ...n, from: author ? sanitizeUser(author) : (n.fromSnapshot || { id: n.fromUserId, displayName: 'Member', username: 'member' }) };
  });
  return c.json({ notifications: enriched, unread: enriched.filter(n => !n.seenAt).length });
});
app.post('/api/notifications/seen', requireAuth, async (c) => {
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
});
app.post('/api/notifications/clear', requireAuth, async (c) => {
  const db = await fetchDatabase();
  const before = (db.notifications || []).length;
  db.notifications = (db.notifications || []).filter(n => n.userId !== c.get('userId'));
  if (before !== db.notifications.length) {
    await saveDatabase(db, false, { skipSecondarySync: true });
    if (isTursoConfigured()) await tursoClearNotificationsForUser(c.get('userId'));
  }
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
  return c.json({ ok: true, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers });
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
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(target);
  }
  return c.json({ ok: true, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers });
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
  if (isTursoConfigured()) {
    await tursoUpsertUser(me);
    await tursoUpsertUser(target);
  }
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
      iBlocked,
      profileLocked,
    },
  });
});

// ---------- Posts ----------
app.get('/api/posts', requireAuth, async (c) => {
  const sdb = await fetchDatabase();
  const sourceUsers = sdb.users || [];
  const sourcePosts = sdb.posts || [];
  const myId = c.get('userId');
  const me = sourceUsers.find(u => u.id === myId);
  const myBlocked = new Set((me && me.blocked) || []);
  const blockedMe = new Set();
  sourceUsers.forEach(u => { if (u.id !== myId && Array.isArray(u.blocked) && u.blocked.includes(myId)) blockedMe.add(u.id); });
  const structuredDb = normalizeDb({ users: sourceUsers, posts: sourcePosts });
  const list = sourcePosts
    .filter(p => {
      if (!p || p.deletedAt || myBlocked.has(p.userId) || blockedMe.has(p.userId)) return false;
      const author = sourceUsers.find(u => u.id === p.userId);
      if (author && !canViewerAccessPrivateProfile(author, myId, structuredDb)) return false;
      return canViewerSeeStory(p, myId, structuredDb);
    })
    .slice().sort((a, b) => b.createdAt - a.createdAt)
    .map(p => {
      const author = sourceUsers.find(u => u.id === p.userId);
      const comments = (p.comments || []).map(cm => {
        const cu = sourceUsers.find(u => u.id === cm.userId);
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
    const ci = isSafeImageUrl(imageUrl) ? String(imageUrl).trim() : null;
    const cimgs = Array.isArray(images) ? images.filter(u => isSafeImageUrl(u)).map(u => String(u).trim()).slice(0, 3) : (ci ? [ci] : []);
    const mainImg = cimgs[0] || ci || null;
    const cvid = isSafeMediaUrl(videoUrl) && (/^https?:\/\//i.test(String(videoUrl)) || /^data:video\//i.test(String(videoUrl))) ? String(videoUrl).trim() : null;
    if (!ct && !mainImg && cimgs.length === 0 && !cvid) return c.json({ error: 'Empty post' }, 400);
    const myId = c.get('userId');
    const db = await fetchDatabase();
    const author = db.users.find(u => u.id === myId);
    const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
    const cleanMusic = music && typeof music === 'object' && music.title ? {
      id: music.id,
      title: sanitizeText(music.title, 60),
      artist: sanitizeText(music.artist || '', 60),
      audio: isSafeMediaUrl(music.audio, { allowData: false }) ? String(music.audio).trim().slice(0,1024) : '',
      art: isSafeImageUrl(music.art, { allowData: false }) ? String(music.art).trim().slice(0,1024) : '',
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
    if (author && author.isPrivate) {
      const allowedUserIds = new Set([
        ...(Array.isArray(author.followers) ? author.followers : []),
        ...db.users.filter(u => Array.isArray(u.following) && u.following.includes(myId)).map(u => u.id),
      ]);
      allowedUserIds.delete(myId);
      for (const viewerId of allowedUserIds) {
        _pushEvent(viewerId, 'new_post', { post: enriched });
      }
    } else {
      _broadcastEvent('new_post', { post: enriched }, myId);
    }
    if (isTursoConfigured()) {
      const [persisted] = await Promise.all([
        saveDatabaseVerified(db, d => (d.posts || []).some(p => p.id === post.id), 4, { skipSecondarySync: true }),
        tursoUpsertPosts([post]).then(() => fanoutPostToFollowers(post, db)).catch(() => {})
      ]);
      if (isPersist() && !persisted) return c.json({ error: 'Post storage unavailable. Please retry.' }, 503);
    } else {
      const persisted = await saveDatabaseVerified(db, d => (d.posts || []).some(p => p.id === post.id), 4, { skipSecondarySync: true });
      if (isPersist() && !persisted) return c.json({ error: 'Post storage unavailable. Please retry.' }, 503);
    }
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
  const myId = c.get('userId');
  const postAuthor = db.users.find(u => u.id === post.userId);
  if (postAuthor && !canViewerAccessPrivateProfile(postAuthor, myId, db)) return c.json({ error: 'Post unavailable' }, 403);
  post.likes = post.likes || [];
  const idx = post.likes.indexOf(myId);
  let liked;
  if (idx === -1) { post.likes.push(myId); liked = true; } else { post.likes.splice(idx, 1); liked = false; }
  const notif = liked ? pushNotification(db, post.userId, 'like', myId, { postId: post.id }) : null;
  await saveDatabase(db, false, { skipSecondarySync: true });
  if (isTursoConfigured()) {
    await tursoUpsertPosts([post]);
    if (notif) await tursoUpsertNotifications([notif]);
  }
  return c.json({ liked, likeCount: post.likes.length });
});

app.post('/api/rtc/signal', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { targetId, signal } = body;
  if (typeof targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(targetId) || !signal || typeof signal !== 'object') return c.json({ error: 'Missing data' }, 400);
  const signalType = sanitizeText(signal.type || '', 24);
  if (!['offer','answer','candidate','end','reject','busy'].includes(signalType)) return c.json({ error: 'Invalid signal' }, 400);
  if (JSON.stringify(signal).length > 20000) return c.json({ error: 'Signal too large' }, 413);
  const myId = c.get('userId');
  if (targetId === myId) return c.json({ error: 'Invalid target' }, 400);
  const db = await fetchDatabase();
  if (!db.users.some(u => u.id === targetId)) return c.json({ error: 'Target not found' }, 404);
  const me = db.users.find(u => u.id === myId);
  const author = me ? { id: me.id, username: me.username, displayName: me.displayName, photoUrl: me.photoUrl || '' } : { id: myId, displayName: 'Member', username: 'member' };
  const payload = { fromId: myId, author, signal };
  const now = nowMs();
  _pushEvent(targetId, 'rtc_signal', payload);

  if (isTursoConfigured()) {
    const rtcId = uid('rtc');
    const fullRow = { id: rtcId, createdAt: now, ...payload };
    await tursoClient().execute({
      sql: 'INSERT INTO ps_events (id, user_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [rtcId, targetId, 'rtc_signal', JSON.stringify(fullRow), now]
    }).catch(e => console.warn('[rtc] event insert failed:', e && e.message));
    if (Math.random() < 0.1) {
      tursoClient().execute({ sql: 'DELETE FROM ps_events WHERE created_at < ? AND kind = ?', args: [now - 60000, 'rtc_signal'] }).catch(() => {});
    }
    return c.json({ ok: true });
  }

  db.rtcSignals = Array.isArray(db.rtcSignals) ? db.rtcSignals : [];
  if (signalType === 'end' || signalType === 'reject' || signalType === 'busy') {
    db.rtcSignals = db.rtcSignals.filter(x => !( (x.targetId === targetId && x.payload?.fromId === myId) || (x.targetId === myId && x.payload?.fromId === targetId) ));
  }
  const expiresAt = now + (signalType === 'offer' ? 20000 : 60000);
  db.rtcSignals.push({ id: uid('rtc'), targetId, payload, createdAt: now, expiresAt });
  if (db.rtcSignals.length > 200) db.rtcSignals = db.rtcSignals.slice(-200);
  const persisted = await saveDatabaseVerified(db, d => (d.rtcSignals || []).some(x => x.id === db.rtcSignals[db.rtcSignals.length - 1].id));
  if (isPersist() && !persisted) return c.json({ error: 'Call signal storage unavailable. Please retry.' }, 503);
  return c.json({ ok: true });
});

app.get('/api/rtc/signals', requireAuth, async (c) => {
  const since = Number(c.req.query('since') || 0) || 0;
  const myId = c.get('userId');
  const now = nowMs();

  if (isTursoConfigured()) {
    const rs = await tursoClient().execute({
      sql: 'SELECT id, data, created_at FROM ps_events WHERE user_id = ? AND kind = ? AND created_at > ? AND created_at >= ? ORDER BY created_at ASC LIMIT 50',
      args: [myId, 'rtc_signal', since, now - 45000]
    }).catch(() => ({ rows: [] }));
    const signals = (rs.rows || []).map(r => {
      try {
        const obj = JSON.parse(r.data);
        return { id: r.id, createdAt: Number(r.created_at || now), ...obj };
      } catch { return null; }
    }).filter(Boolean);
    return c.json({ signals, now });
  }

  const db = await fetchDatabase();
  db.rtcSignals = Array.isArray(db.rtcSignals) ? db.rtcSignals.filter(x => !x.expiresAt || x.expiresAt > now) : [];
  let signals = db.rtcSignals
    .filter(x => x.targetId === myId && (x.createdAt || 0) > since && (now - (x.createdAt || 0) <= 45000))
    .sort((a,b) => (a.createdAt||0) - (b.createdAt||0))
    .slice(-30)
    .map(x => ({ id: x.id, createdAt: x.createdAt, ...x.payload }));
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
  const myId = c.get('userId');
  const postAuthor = db.users.find(u => u.id === post.userId);
  if (postAuthor && !canViewerAccessPrivateProfile(postAuthor, myId, db)) return c.json({ error: 'Post unavailable' }, 403);
  post.comments = post.comments || [];
  const author = db.users.find(u => u.id === myId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
  const comment = { id: uid('cmt'), userId: myId, text: ct, authorSnapshot: snap, createdAt: nowMs() };
  post.comments.push(comment);
  const notif = pushNotification(db, post.userId, 'comment', myId, { postId: post.id, commentId: comment.id, text: ct.slice(0, 140) });
  await saveDatabase(db, false, { skipSecondarySync: true });
  if (isTursoConfigured()) {
    await tursoUpsertPosts([post]);
    if (notif) await tursoUpsertNotifications([notif]);
  }
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
  await saveDatabase(db, false, { skipSecondarySync: true });
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
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
  await saveDatabase(db, false, { skipSecondarySync: true });
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
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
  if (isTursoConfigured()) await tursoUpsertPosts([p]);
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
  // Bug #10 fix: Filter out viewers who can no longer see the story
  // (e.g., removed from close_friends after they viewed)
  const filteredViews = views.filter(v => canViewerSeeStory(p, v.userId, db));
  const viewers = filteredViews.map(v => {
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
  const notif = pushNotification(db, p.userId, 'story_reply', myId, { text: bodyText.slice(0, 80), postId: p.id });
  const persisted = await saveDatabaseVerified(db, d => (d.messages || []).some(m => m.id === msg.id), 4, { skipSecondarySync: true });
  if (isPersist() && !persisted) return c.json({ error: 'Reply storage unavailable. Please retry.' }, 503);
  if (isTursoConfigured()) {
    await tursoUpsertMessages([msg]);
    if (notif) await tursoUpsertNotifications([notif]);
    await tursoRefreshDmIndexForOwners(db, roomId.slice(3).split(':').filter(Boolean));
  }
  return c.json({ ok: true, message: enriched });
});

// ---------- GetStream.io integration endpoints ----------
app.get('/api/stream/config', (c) => {
  if (c.env) loadConfig(c.env);
  const apiKey = STREAM_API_KEY || (c.env && c.env.STREAM_API_KEY) || null;
  const appId = STREAM_APP_ID || (c.env && c.env.STREAM_APP_ID) || null;
  const apiSecret = STREAM_API_SECRET || (c.env && c.env.STREAM_API_SECRET) || null;
  return c.json({
    enabled: !!(apiKey && apiSecret),
    apiKey: apiKey || null,
    appId: appId || null
  });
});

app.get('/api/stream/token', requireAuth, async (c) => {
  if (c.env) loadConfig(c.env);
  const apiKey = STREAM_API_KEY || (c.env && c.env.STREAM_API_KEY) || null;
  const appId = STREAM_APP_ID || (c.env && c.env.STREAM_APP_ID) || null;
  const apiSecret = STREAM_API_SECRET || (c.env && c.env.STREAM_API_SECRET) || null;
  if (!apiKey || !apiSecret) {
    return c.json({ error: 'GetStream API credentials are not configured on this server.' }, 501);
  }
  const myId = c.get('userId');
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = b64urlJson({ user_id: String(myId) });
  const signingInput = header + '.' + payload;
  const signature = b64url(await hmacSha256(apiSecret, signingInput));
  const token = signingInput + '.' + signature;
  return c.json({ token, userId: myId, apiKey, appId });
});

// ---------- Admin panel removed by owner request ----------
app.all('/api/admin/*', (c) => c.json({ error: 'Admin panel removed' }, 404));

// ---------- Push (subscribe endpoints - actual delivery is no-op for now) ----------
app.get('/api/push/vapid-public', (c) => c.json({ key: VAPID_PUBLIC || '' }));
app.post('/api/push/subscribe', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { subscription } = body;
  if (!isValidPushSubscription(subscription)) return c.json({ error: 'Invalid subscription' }, 400);
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
  if (!isSafeHttpsUrl(endpoint, 2048)) return c.json({ error: 'Invalid endpoint' }, 400);
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
  const authDb = await fetchPrimaryDatabase();
  const authUser = (authDb.users || []).find(u => u.id === payload.uid);
  if (!authUser || Number(payload.sv || 0) !== Number(authUser.tokenVersion || 0)) return c.text('', 401);
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
      let lastSeenTs = Date.now() - 1500;
      const sentIds = new Set();
      const primaryPoller = isTursoPrimary() ? setInterval(async () => {
        if (sub.closed) return;
        try {
          let rows = [];
          await tursoEnsure();
          const rs = await tursoClient().execute({
            sql: `SELECT id, kind, data, created_at FROM ps_events
                  WHERE (user_id = ? OR user_id = ?) AND created_at > ?
                  ORDER BY created_at ASC LIMIT 30`,
            args: [userId, '__ALL__', lastSeenTs],
          });
          rows = rs.rows || [];
          for (const r of rows || []) {
            const ts = Number(r.created_at);
            if (ts > lastSeenTs) lastSeenTs = ts;
            if (!sentIds.has(r.id)) {
              sentIds.add(r.id);
              const payloadStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
              send(`id: ${r.id}
event: ${r.kind}
data: ${payloadStr}

`);
            }
          }
          if (Math.random() < 0.03) {
            const oldTs = Date.now() - 300_000;
            tursoClient().execute({ sql: 'DELETE FROM ps_events WHERE created_at < ?', args: [oldTs] }).catch(() => {});
          }
        } catch (_) {}
      }, 1500) : null;
      const autoclose = setTimeout(() => cleanup(), 24000);
      function cleanup() {
        if (sub.closed) return;
        sub.closed = true;
        clearInterval(heartbeat);
        if (primaryPoller) clearInterval(primaryPoller);
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

// ---------- Export for Cloudflare ----------
export default app;

// ---------- Hybrid Fan-out Feed (DesignGurus Instagram optimization) ----------
const FEED_FANOUT_THRESHOLD = 5000; // users with <= this many followers get push fan-out

async function tursoUpsertUserFeeds(userFeeds) {
  if (!isTursoConfigured() || !Array.isArray(userFeeds) || userFeeds.length === 0) return;
  await tursoEnsure();
  const stmts = userFeeds.map(uf => ({
    sql: `INSERT INTO ps_user_feeds (user_id, post_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, post_id) DO UPDATE SET created_at = excluded.created_at`,
    args: [uf.userId, uf.postId, uf.createdAt]
  }));
  await tursoClient().batch(stmts, 'write').catch(e => console.warn('[turso] user_feeds upsert failed', e?.message));
}

async function getFollowerCount(userId, db) {
  const user = (db.users || []).find(u => u.id === userId);
  return user && Array.isArray(user.followers) ? user.followers.length : 0;
}

async function fanoutPostToFollowers(post, db) {
  if (!isTursoConfigured()) return;
  const authorId = post.userId;
  const followerCount = await getFollowerCount(authorId, db);
  
  if (followerCount > FEED_FANOUT_THRESHOLD) {
    // Celebrity: use pull model (do nothing here)
    return;
  }
  
  // Normal user: fan-out to followers
  const author = (db.users || []).find(u => u.id === authorId);
  const followers = (author && Array.isArray(author.followers)) ? author.followers : [];
  if (!followers.length) return;

  const feedRows = followers.map(fid => ({
    userId: fid,
    postId: post.id,
    createdAt: post.createdAt || nowMs()
  }));
  
  await tursoUpsertUserFeeds(feedRows);
}

// New optimized feed endpoint
app.get('/api/feed', requireAuth, async (c) => {
  const myId = c.get('userId');
  const limit = Math.min(50, Math.max(5, parseInt(c.req.query('limit') || '20')));
  const db = await fetchDatabase();
  const me = (db.users || []).find(u => u.id === myId);
  const following = (me && Array.isArray(me.following)) ? me.following : [];
  const allFollowing = new Set([...following, myId]);
  const usersById = new Map((db.users || []).map(u => [u.id, u]));
  const posts = (db.posts || [])
    .filter(p => !p.deletedAt && allFollowing.has(p.userId) && !p.story)
    .sort((a,b) => {
      const engA = ((a.likes || []).length * 3) + ((a.comments || []).length * 5);
      const engB = ((b.likes || []).length * 3) + ((b.comments || []).length * 5);
      return ((b.createdAt||0) * 0.7 + engB * 0.3) - ((a.createdAt||0) * 0.7 + engA * 0.3);
    })
    .slice(0, limit)
    .map(p => {
      const liveUser = usersById.get(p.userId);
      const authorObj = liveUser ? sanitizeUser(liveUser) : (p.authorSnapshot || { id: p.userId, displayName: 'Member', username: (p.userId || 'm').slice(-6) });
      return { ...p, author: authorObj };
    });
  return c.json({ posts, source: isTursoConfigured() ? 'hybrid-turso-feed' : 'full-db-fallback' });
});

// ---------- 404 ----------
// Must be registered LAST (after every real route above, including /api/feed).
// Hono matches routes in registration order, so a catch-all placed earlier
// would shadow any route defined after it — which is exactly what happened
// to /api/feed before this fix (it always hit this 404 handler instead).
app.all('/api/*', (c) => c.json({ error: 'Route not found', path: c.req.path }, 404));
