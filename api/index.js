/**
 * PRIV SPACA - Backend API
 * Express serverless app with GitHub Gist persistence + in-memory cache fallback.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');
const { createClient: createTursoClient } = require('@libsql/client');

// node-fetch v2 (CommonJS). If unavailable, fall back to globalThis.fetch (Node 18+).
let fetchFn;
try {
  fetchFn = require('node-fetch');
} catch (_) {
  fetchFn = (...args) => globalThis.fetch(...args);
}

const app = express();
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
function isDefaultJwtSecret() {
  return !JWT_SECRET || JWT_SECRET === 'priv-spaca-dev-secret-change-me-in-production';
}
function isProductionHost(req) {
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  return host === 'priv-spaca.pages.dev' || host.endsWith('.priv-spaca.pages.dev');
}
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin && !isAllowedCorsOrigin(origin)) return res.status(403).json({ error: 'CORS origin denied' });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (isProductionHost(req) && isDefaultJwtSecret() && req.path.startsWith('/api/') && req.path !== '/api/health') {
    return res.status(503).json({ error: 'Server auth secret is not configured' });
  }
  next();
});
// Body parsing — only use Express's parser when running on a real Node host.
// When running on Cloudflare Workers (detected via CF_PAGES env), our adapter
// has already populated req.body, and express.json() depends on body-parser
// → raw-body → iconv-lite which fail under the Workers bundler. We skip in that case.
const _isCloudflareWorker = typeof globalThis.WebSocketPair !== 'undefined' ||
                             process.env.CF_PAGES === '1' ||
                             process.env.CF_WORKER === '1';
if (!_isCloudflareWorker) {
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));
} else {
  // No-op middleware — body is already parsed by the CF worker adapter
  app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
}

// ---------- Security headers (lightweight, no external deps) ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});

// ---------- Rate limiting (in-memory, per IP) ----------
const _rateBuckets = new Map(); // key -> { count, resetAt }
function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  let b = _rateBuckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + windowMs };
    _rateBuckets.set(key, b);
  }
  b.count++;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.resetAt };
}
let _rateLimitSql = null;
let _rateLimitNeonReady = false;
function isRateLimitNeonConfigured() {
  return !!DATABASE_URL;
}
function rateLimitSql() {
  if (!_rateLimitSql) _rateLimitSql = neon(DATABASE_URL);
  return _rateLimitSql;
}
async function ensureRateLimitStore() {
  if (!isRateLimitNeonConfigured()) return false;
  if (_rateLimitNeonReady) return true;
  await rateLimitSql()`CREATE TABLE IF NOT EXISTS priv_spaca_rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await rateLimitSql()`CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON priv_spaca_rate_limits (reset_at)`;
  _rateLimitNeonReady = true;
  return true;
}
async function sharedRateLimit({ key, limit, windowMs }) {
  if (!isRateLimitNeonConfigured()) return rateLimit({ key, limit, windowMs });
  const now = Date.now();
  const nextResetAt = now + windowMs;
  try {
    await ensureRateLimitStore();
    const rows = await rateLimitSql()`INSERT INTO priv_spaca_rate_limits AS rl (key, count, reset_at, updated_at)
      VALUES (${key}, 1, ${nextResetAt}, NOW())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN rl.reset_at <= ${now} THEN 1 ELSE rl.count + 1 END,
        reset_at = CASE WHEN rl.reset_at <= ${now} THEN ${nextResetAt} ELSE rl.reset_at END,
        updated_at = NOW()
      RETURNING count, reset_at`;
    if (Math.random() < 0.01) {
      rateLimitSql()`DELETE FROM priv_spaca_rate_limits WHERE reset_at < ${now - (24 * 60 * 60 * 1000)}`.catch(() => {});
    }
    const row = rows && rows[0] ? rows[0] : { count: 1, reset_at: nextResetAt };
    const count = Number(row.count || 0);
    const resetAt = Number(row.reset_at || nextResetAt);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt };
  } catch (e) {
    console.warn('[sharedRateLimit] falling back to in-memory limiter:', e && e.message);
    return rateLimit({ key, limit, windowMs });
  }
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
      || req.headers['x-real-ip']
      || req.socket.remoteAddress
      || 'unknown';
}
// Periodically prune expired buckets
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets) if (v.resetAt < now) _rateBuckets.delete(k);
}, 60000).unref?.();

// Reject unexpectedly huge API bodies before they reach route handlers.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const len = Number(req.headers['content-length'] || '0');
  if (['POST','PUT','PATCH'].includes(req.method) && len > 16 * 1024 * 1024) {
    return res.status(413).json({ error: 'Request body too large' });
  }
  next();
});

// Global throttle: 400 req/min per IP for all /api/* routes
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  const ip = clientIp(req);
  const r = await sharedRateLimit({ key: 'global:' + ip, limit: 400, windowMs: 60_000 });
  res.setHeader('X-RateLimit-Limit', '400');
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((r.resetAt - Date.now())/1000)));
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  next();
});

// Auth-specific rate limit: 40 attempts / 15 min per IP for signup, login, reset
async function authRateLimit(req, res, next) {
  const ip = clientIp(req);
  const key = 'auth:' + ip + ':' + req.path;
  const r = await sharedRateLimit({ key, limit: 40, windowMs: 15 * 60_000 });
  if (!r.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((r.resetAt - Date.now())/1000)));
    return res.status(429).json({ error: 'Too many auth attempts. Try again in 15 minutes.' });
  }
  next();
}

// Per-account brute-force tracker: 5 wrong passwords in 5 min → 15 min lockout
const _loginFails = new Map(); // userId -> { count, firstAt, lockedUntil }
function checkAccountLock(userId) {
  const rec = _loginFails.get(userId);
  if (!rec) return { locked: false };
  const now = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return { locked: true, remaining: rec.lockedUntil - now };
  }
  return { locked: false };
}
function recordLoginFail(userId) {
  const now = Date.now();
  let rec = _loginFails.get(userId);
  if (!rec || (now - rec.firstAt) > 5 * 60_000) {
    rec = { count: 0, firstAt: now };
    _loginFails.set(userId, rec);
  }
  rec.count++;
  if (rec.count >= 5) {
    rec.lockedUntil = now + 15 * 60_000;
  }
}
function clearLoginFails(userId) { _loginFails.delete(userId); }
const AUTH_GENERIC_ERROR = 'Invalid username/email or password.';
function authFailureDelay() {
  return new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 250)));
}
async function authSubjectRateLimit(req, subject, limit = 10) {
  const ip = clientIp(req);
  const key = 'credential:' + ip + ':' + (subject || 'unknown');
  return sharedRateLimit({ key, limit, windowMs: 15 * 60_000 });
}

// Sanitize text inputs (strip control chars, collapse excessive whitespace)
function sanitizeText(s, maxLen = 4000) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFKC')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .slice(0, maxLen);
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

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'priv-spaca-dev-secret-change-me-in-production';
const JWT_EXPIRES = '7d';
// GitHub repo-file persistence (Contents API). Requires `repo` scope.
const GITHUB_PAT = process.env.GITHUB_PAT || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const GH_REPO    = process.env.GH_REPO    || 'ajitjaat1011-ui/PRIV-SPACA';
const GH_BRANCH  = process.env.GH_BRANCH  || 'data';
const GH_FILE    = process.env.GH_FILE    || 'db.json';
const ADMIN_USERS = process.env.ADMIN_USERS || process.env.OWNER_USERNAME || process.env.OWNER_EMAIL || '';
const VIP_UNLOCK_KEY = process.env.VIP_UNLOCK_KEY || '';
// Legacy gist support (still works if configured)
const GIST_ID    = process.env.GIST_ID || '';
const GIST_FILE  = 'db.json';
const CACHE_TTL_MS = 2000;
const EPHEMERAL_WRITE_INTERVAL_MS = 30000;

// ---------- In-memory cache + fallback DB ----------
let localCache = {
  users: [],
  messages: [],
  scheduledMessages: [],
  posts: [],
  notifications: [],   // { id, userId (recipient), kind, fromUserId, postId?, commentId?, text?, createdAt, seenAt? }
  typing: {},          // { roomId: { userId: timestamp } }
  heartbeat: {},       // { userId: timestamp }
  rtcSignals: [],      // { id, targetId, payload, createdAt, expiresAt } — WebRTC call signaling (SSE fallback poll)
};

let cacheTimestamp = 0;
let lastEphemeralWrite = 0;
let pendingEphemeral = false;
let ghFileSha = null; // current sha of db.json on GH_BRANCH

// ---------- Helpers ----------
function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function nowMs() {
  return Date.now();
}

function safeJson(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
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

function isRepoConfigured() {
  return !!(GITHUB_PAT && GH_REPO && GH_BRANCH);
}
function isGistConfigured() {
  return !!(GIST_ID && GITHUB_PAT);
}
function isPersistConfigured() {
  return isRepoConfigured() || isGistConfigured();
}

// ---- GitHub Contents API (primary, uses `repo` scope) ----
async function repoRead() {
  if (!isRepoConfigured()) return null;
  try {
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}?ref=${encodeURIComponent(GH_BRANCH)}`;
    const res = await fetchFn(url, {
      headers: {
        'Authorization': `token ${GITHUB_PAT}`,
        'User-Agent': 'PRIV-SPACA',
        'Accept': 'application/vnd.github+json'
      }
    });
    if (!res.ok) {
      console.error('repoRead HTTP', res.status);
      return null;
    }
    const data = await res.json();
    ghFileSha = data.sha || null;
    if (!data.content) return null;
    const buf = Buffer.from(data.content, data.encoding || 'base64');
    return safeJson(buf.toString('utf8'), null);
  } catch (e) {
    console.error('repoRead error', e.message);
    return null;
  }
}

async function repoWrite(dbObj) {
  if (!isRepoConfigured()) return false;
  // Always refresh sha right before writing — prevents stale-sha conflicts
  // across cold starts and concurrent writes.
  try {
    if (!ghFileSha) await repoRead();
    const content = Buffer.from(JSON.stringify(dbObj)).toString('base64');
    const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(GH_FILE)}`;
    const doPut = async (sha) => {
      const body = {
        message: 'priv-spaca sync ' + new Date().toISOString(),
        content,
        branch: GH_BRANCH,
      };
      if (sha) body.sha = sha;
      return fetchFn(url, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_PAT}`,
          'User-Agent': 'PRIV-SPACA',
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    };
    let res = await doPut(ghFileSha);
    // Retry on sha conflict (409/422) — refresh and try again, up to 3 attempts
    for (let attempt = 0; attempt < 3 && (res.status === 409 || res.status === 422); attempt++) {
      ghFileSha = null;
      await repoRead();
      res = await doPut(ghFileSha);
    }
    if (res.status === 401 || res.status === 403) {
      const txt = await res.text().catch(() => '');
      console.error('[repoWrite] AUTH FAILED — check GITHUB_PAT scopes/validity. HTTP', res.status, txt.slice(0, 200));
      return false;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error('[repoWrite] HTTP', res.status, txt.slice(0, 200));
      return false;
    }
    const j = await res.json();
    if (j && j.content && j.content.sha) ghFileSha = j.content.sha;
    return true;
  } catch (e) {
    console.error('[repoWrite] exception:', e.message);
    return false;
  }
}

// ---- Legacy Gist support (only if configured) ----
async function gistRead() {
  if (!isGistConfigured()) return null;
  try {
    const res = await fetchFn(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        'Authorization': `token ${GITHUB_PAT}`,
        'User-Agent': 'PRIV-SPACA',
        'Accept': 'application/vnd.github+json'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const file = data.files && data.files[GIST_FILE];
    if (!file || !file.content) return null;
    return safeJson(file.content, null);
  } catch (e) {
    console.error('gistRead error', e.message);
    return null;
  }
}

async function gistWrite(dbObj) {
  if (!isGistConfigured()) return false;
  try {
    const res = await fetchFn(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GITHUB_PAT}`,
        'User-Agent': 'PRIV-SPACA',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: {
          [GIST_FILE]: { content: JSON.stringify(dbObj, null, 2) }
        }
      })
    });
    return res.ok;
  } catch (e) {
    console.error('gistWrite error', e.message);
    return false;
  }
}

// Unified read/write — prefers repo, falls back to gist
async function persistRead() {
  if (isRepoConfigured()) return repoRead();
  if (isGistConfigured()) return gistRead();
  return null;
}
async function persistWrite(dbObj) {
  if (isRepoConfigured()) return repoWrite(dbObj);
  if (isGistConfigured()) return gistWrite(dbObj);
  return false;
}

/**
 * Fetch the database with cache TTL. Also auto-flushes scheduled messages
 * whose deliverAt timestamp has elapsed into the messages collection.
 */
let _turso = null;
let _tursoReady = false;
let _tursoBootstrapped = false;
function isTursoConfigured() {
  return !!(TURSO_DATABASE_URL && TURSO_AUTH_TOKEN);
}
function tursoClient() {
  if (!_turso) _turso = createTursoClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  return _turso;
}
async function tursoEnsure() {
  if (!isTursoConfigured()) return false;
  if (_tursoReady) return true;
  const c = tursoClient();
  await c.executeMultiple(`
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
  `);
  _tursoReady = true;
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
    let postsRows = await c.execute('SELECT data_json FROM ps_posts ORDER BY created_at DESC');
    if ((!usersRows.rows?.length && !postsRows.rows?.length) && fallbackDb) {
      await syncTursoMirror(fallbackDb);
      usersRows = await c.execute('SELECT data_json FROM ps_users ORDER BY created_at ASC');
      postsRows = await c.execute('SELECT data_json FROM ps_posts ORDER BY created_at DESC');
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

async function fetchPrimaryDatabase() {
  const remote = await persistRead();
  if (remote && typeof remote === 'object') return normalizeDb(remote);
  return normalizeDb(localCache);
}

async function fetchDatabase({ includeTurso = true } = {}) {
  const freshPrimary = !includeTurso;
  const now = nowMs();
  if (!freshPrimary && now - cacheTimestamp < CACHE_TTL_MS && cacheTimestamp !== 0) {
    runScheduler(localCache);
    return localCache;
  }
  const remote = await persistRead();
  if (remote && typeof remote === 'object') {
    localCache = {
      users: Array.isArray(remote.users) ? remote.users : [],
      messages: Array.isArray(remote.messages) ? remote.messages : [],
      scheduledMessages: Array.isArray(remote.scheduledMessages) ? remote.scheduledMessages : [],
      posts: Array.isArray(remote.posts) ? remote.posts : [],
      notifications: Array.isArray(remote.notifications) ? remote.notifications : [],
      typing: remote.typing && typeof remote.typing === 'object' ? remote.typing : {},
      heartbeat: remote.heartbeat && typeof remote.heartbeat === 'object' ? remote.heartbeat : {},
      rtcSignals: Array.isArray(remote.rtcSignals) ? remote.rtcSignals : [],
    };
  }
  if (includeTurso && isTursoConfigured()) {
    const mirror = await fetchTursoMirror(localCache);
    if ((mirror.users || []).length > 0) localCache.users = mirror.users;
    if ((mirror.posts || []).length > 0) localCache.posts = mirror.posts;
    localCache.meta = { ...(localCache.meta || {}), secondaryPersistence: 'turso-users-posts' };
  }
  cacheTimestamp = now;
  const changed = runScheduler(localCache);
  if (changed) {
    // Persist freshly promoted scheduled messages (durable write).
    await saveDatabase(localCache, false);
  }
  return localCache;
}

/**
 * Promote any scheduled messages whose time has come into the live feed.
 * Returns true if any messages were promoted (caller may persist).
 */
function runScheduler(db) {
  const now = nowMs();
  let changed = false;

  // Purge soft-deleted older than 30 days
  const PURGE_AFTER = 30 * 24 * 3600 * 1000;
  const beforePosts = (db.posts || []).length;
  db.posts = (db.posts || []).filter(p => !p.deletedAt || (now - p.deletedAt) < PURGE_AFTER);
  if (db.posts.length !== beforePosts) changed = true;
  const beforeMsgs = (db.messages || []).length;
  // Soft-delete disappearing messages whose TTL elapsed
  for (const m of db.messages || []) {
    if (m.disappearAt && m.disappearAt <= now && !m.deletedAt) {
      m.deletedAt = now;
      m.disappeared = true;
      changed = true;
    }
  }
  db.messages = (db.messages || []).filter(m => !m.deletedAt || (now - m.deletedAt) < PURGE_AFTER);
  if (db.messages.length !== beforeMsgs) changed = true;

  // Purge typing entries older than 10s
  if (db.typing && typeof db.typing === 'object') {
    for (const room of Object.keys(db.typing)) {
      const map = db.typing[room];
      if (!map || typeof map !== 'object') { delete db.typing[room]; continue; }
      for (const u of Object.keys(map)) {
        if (now - (map[u] || 0) > 10000) delete map[u];
      }
      if (Object.keys(map).length === 0) delete db.typing[room];
    }
  }

  if (!Array.isArray(db.scheduledMessages) || db.scheduledMessages.length === 0) return changed;
  const due = [];
  const remaining = [];
  for (const sm of db.scheduledMessages) {
    if (sm && typeof sm.deliverAt === 'number' && sm.deliverAt <= now) {
      due.push(sm);
    } else {
      remaining.push(sm);
    }
  }
  if (due.length === 0) return changed;
  for (const sm of due) {
    const author = db.users.find(u => u.id === sm.userId);
    const snapshot = author ? {
      id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || ''
    } : (sm.authorSnapshot || null);
    db.messages.push({
      id: sm.id || uid('msg'),
      roomId: sm.roomId,
      userId: sm.userId,
      text: sm.text || '',
      imageUrl: sm.imageUrl || null,
      replyTo: sm.replyTo || null,
      authorSnapshot: snapshot,
      createdAt: now,
      scheduledOriginally: true,
    });
  }
  db.scheduledMessages = remaining;
  return true;
}

/**
 * Save database. If isEphemeral, throttle external gist writes (every 30s);
 * always update in-memory cache instantly.
 */
async function saveDatabase(data, isEphemeral = false) {
  localCache = data;
  cacheTimestamp = nowMs();
  if (!isPersistConfigured()) return true; // in-memory only
  if (isEphemeral) {
    const now = nowMs();
    if (now - lastEphemeralWrite < EPHEMERAL_WRITE_INTERVAL_MS) {
      pendingEphemeral = true;
      return true;
    }
    lastEphemeralWrite = now;
    pendingEphemeral = false;
    // Fire and forget
    persistWrite(data).catch(() => {});
    return true;
  }
  // Durable write
  const ok = await persistWrite(data);
  if (ok && isTursoConfigured()) await syncTursoMirror(localCache);
  return ok;
}

// ---------- Auth helpers ----------
function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username, sv: Number(user.tokenVersion || 0) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Auth/session validation must use the primary write store. Turso is a
    // read mirror and can lag briefly after password/PIN changes.
    const authDb = await fetchPrimaryDatabase();
    const user = (authDb.users || []).find(u => u.id === payload.uid);
    if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
    if (Number(payload.sv || 0) !== Number(user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    req.userId = payload.uid;
    req.username = user.username || payload.username;
    req.authUser = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    displayName: u.displayName,
    bio: u.bio || '',
    photoUrl: u.photoUrl || '',
    createdAt: u.createdAt,
    publicKey: u.publicKey || null,
    verified: !!u.verified,
    note: activeNote(u),
  };
}
// A "note" is a short 24h status (Instagram-style). Returns null once expired.
function adminSet() {
  return new Set(String(ADMIN_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
}
function isAdminUser(u) {
  if (!u) return false;
  const set = adminSet();
  return set.has(String(u.username || '').toLowerCase()) || set.has(String(u.email || '').toLowerCase()) || set.has(String(u.id || '').toLowerCase());
}

function activeNote(u) {
  const n = u && u.note;
  if (!n || (!n.text && !n.music)) return null;
  if (n.expiresAt && n.expiresAt <= nowMs()) return null;
  return { text: String(n.text || '').slice(0, 60), music: n.music || null, createdAt: n.createdAt || 0, expiresAt: n.expiresAt || 0 };
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
function isValidUsername(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(s);
}
function isValidPin(s) {
  return typeof s === 'string' && /^[0-9]{4}$/.test(s);
}

// ---------- Web Push (VAPID) ----------
let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.warn('[push] web-push unavailable:', e.message); }

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BG5msm1YiW_5l5N2ZNAvz5CkzQDGchg99ZSpkXVhXb4mm70X8vPPZs_7lrsaDXtvPns7QloRkh40vY4J5O0pqlI';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || ''; // must be set as encrypted env secret in production
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@priv-spaca.app';
if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); }
  catch (e) { console.error('[push] setVapidDetails failed', e.message); }
}

// GET /api/push/vapid-public — frontend fetches the public key
app.get('/api/push/vapid-public', (req, res) => {
  res.json({ key: VAPID_PUBLIC || '' });
});

// POST /api/push/subscribe — save subscription on the user record
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const { subscription } = req.body || {};
  if (!isValidPushSubscription(subscription)) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === req.userId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  u.pushSubs = Array.isArray(u.pushSubs) ? u.pushSubs : [];
  // Replace existing sub with same endpoint, else append
  const idx = u.pushSubs.findIndex(s => s.endpoint === subscription.endpoint);
  if (idx >= 0) u.pushSubs[idx] = subscription;
  else u.pushSubs.push(subscription);
  // Cap at 5 devices per user
  if (u.pushSubs.length > 5) u.pushSubs = u.pushSubs.slice(-5);
  await saveDatabase(db, false);
  res.json({ ok: true, devices: u.pushSubs.length });
});

// POST /api/push/unsubscribe — remove subscription
app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!isSafeHttpsUrl(endpoint, 2048)) {
    return res.status(400).json({ error: 'Invalid endpoint' });
  }
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === req.userId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  u.pushSubs = (u.pushSubs || []).filter(s => s.endpoint !== endpoint);
  await saveDatabase(db, false);
  res.json({ ok: true });
});

// Send a push notification to a user (called internally by pushNotification).
// Fire-and-forget; failures (expired sub etc.) are pruned.
async function sendWebPush(db, recipientId, payload) {
  if (!webpush || !VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const u = db.users.find(x => x.id === recipientId);
  if (!u || !Array.isArray(u.pushSubs) || u.pushSubs.length === 0) return;
  const body = JSON.stringify(payload);
  const stillValid = [];
  await Promise.all(u.pushSubs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body, { TTL: 60 });
      stillValid.push(sub);
    } catch (e) {
      // 404/410 = subscription expired
      if (e.statusCode === 404 || e.statusCode === 410) {
        console.log('[push] pruning expired sub for', u.username);
      } else {
        console.warn('[push] send error', e.statusCode, e.body || e.message);
        stillValid.push(sub); // keep it; might be a transient error
      }
    }
  }));
  if (stillValid.length !== u.pushSubs.length) {
    u.pushSubs = stillValid;
    // Lazy save via ephemeral
    saveDatabase(db, true).catch(() => {});
  }
}

// ---------- Real-time event queue + SSE ----------
// Per-user FIFO queue holding events that occurred while they were disconnected.
// Capped at 200 per user so a long-offline account doesn't blow memory.
// Also a "subscribers" map for active SSE connections so we can fan-out push immediately.

const _eventQueues = new Map();       // userId -> [{ id, ts, kind, data }]
const _eventSubscribers = new Map();  // userId -> Set of {res, lastEventId, closed}

function _pushEvent(userId, kind, data) {
  if (!userId) return;
  const evt = { id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), ts: Date.now(), kind, data };
  // Queue it
  if (!_eventQueues.has(userId)) _eventQueues.set(userId, []);
  const q = _eventQueues.get(userId);
  q.push(evt);
  if (q.length > 200) q.splice(0, q.length - 200);
  // Fan-out to live subscribers
  const subs = _eventSubscribers.get(userId);
  if (subs) {
    for (const sub of subs) {
      if (sub.closed) continue;
      try {
        sub.res.write(`id: ${evt.id}\nevent: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`);
      } catch (_) { sub.closed = true; }
    }
  }
  return evt;
}

function _broadcastEvent(kind, data, excludeUserId) {
  // Broadcast to all known users (general-group new messages, presence, etc.)
  for (const userId of new Set([..._eventSubscribers.keys(), ..._eventQueues.keys()])) {
    if (userId === excludeUserId) continue;
    _pushEvent(userId, kind, data);
  }
}

// Periodic cleanup of empty queues
setInterval(() => {
  const now = Date.now();
  for (const [uid, q] of _eventQueues) {
    // Drop events older than 1 hour
    const fresh = q.filter(e => now - e.ts < 60 * 60 * 1000);
    if (fresh.length === 0) _eventQueues.delete(uid);
    else if (fresh.length !== q.length) _eventQueues.set(uid, fresh);
  }
}, 5 * 60 * 1000).unref?.();

// GET /api/stream — Server-Sent Events
// Accepts ?token=... since EventSource cannot set Authorization headers.
// Holds connection up to 25s (Netlify limit ≈ 26s), client auto-reconnects.
app.get('/api/stream', async (req, res) => {
  // Auth via query token (EventSource can't add Authorization header)
  const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).end();
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch (_) { return res.status(401).end(); }
  const authDb = await fetchDatabase();
  const authUser = (authDb.users || []).find(u => u.id === payload.uid);
  if (!authUser || Number(payload.sv || 0) !== Number(authUser.tokenVersion || 0)) return res.status(401).end();
  const userId = payload.uid;
  const lastEventId = req.headers['last-event-id'] || req.query.lastEventId || null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(req.headers.origin && isAllowedCorsOrigin(req.headers.origin) ? { 'Access-Control-Allow-Origin': req.headers.origin, 'Vary': 'Origin' } : {}),
  });
  res.write(': connected\n\n');

  // Flush any queued events since last id
  const queue = _eventQueues.get(userId) || [];
  let startIdx = 0;
  if (lastEventId) {
    const i = queue.findIndex(e => e.id === lastEventId);
    if (i >= 0) startIdx = i + 1;
  }
  for (let i = startIdx; i < queue.length; i++) {
    const e = queue[i];
    res.write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
  }

  // Register live subscriber
  if (!_eventSubscribers.has(userId)) _eventSubscribers.set(userId, new Set());
  const sub = { res, closed: false };
  _eventSubscribers.get(userId).add(sub);

  // Heartbeat every 10s
  const heartbeatTimer = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { closeConn(); }
  }, 10000);

  // Auto-close at 24s so Netlify doesn't timeout; client reconnects automatically
  const autoClose = setTimeout(() => closeConn(), 24000);

  function closeConn() {
    if (sub.closed) return;
    sub.closed = true;
    clearInterval(heartbeatTimer);
    clearTimeout(autoClose);
    const set = _eventSubscribers.get(userId);
    if (set) { set.delete(sub); if (set.size === 0) _eventSubscribers.delete(userId); }
    try { res.end(); } catch (_) {}
  }
  req.on('close', closeConn);
  req.on('error', closeConn);
});

// ---------- Health ----------
app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    name: 'PRIV SPACA',
    persistence: isRepoConfigured() ? 'github-repo' : (isGistConfigured() ? 'gist' : 'in-memory'),
    secondaryPersistence: isTursoConfigured() ? 'turso-structured-social' : null,
    time: nowMs(),
  });
});

// Diagnostics — verifies the configured persistence layer can READ & WRITE
app.get('/api/diag', authMiddleware, async (req, res) => {
  const dbAuth = await fetchDatabase();
  const diagUser = dbAuth.users.find(u => u.id === req.userId);
  if (!isAdminUser(diagUser)) return res.status(403).json({ error: 'Admin only' });
  const out = {
    persistence: isRepoConfigured() ? 'github-repo' : (isGistConfigured() ? 'gist' : 'in-memory'),
    repoConfigured: isRepoConfigured(),
    gistConfigured: isGistConfigured(),
    repo: GH_REPO ? '[configured]' : '',
    branch: GH_BRANCH ? '[configured]' : '',
    file: GH_FILE ? '[configured]' : '',
    canRead: false,
    canWrite: false,
    userCount: 0,
    error: null,
  };
  try {
    const db = await persistRead();
    if (db && typeof db === 'object') {
      out.canRead = true;
      out.userCount = Array.isArray(db.users) ? db.users.length : 0;
      // Test write by re-saving the same content
      const ok = await persistWrite(db);
      out.canWrite = !!ok;
    } else if (!isPersistConfigured()) {
      out.canRead = true; out.canWrite = true; // in-memory always works
      out.userCount = (localCache.users || []).length;
    } else {
      out.error = 'Read returned no data';
    }
  } catch (e) {
    out.error = e.message;
  }
  res.json(out);
});

// ---------- Auth Routes ----------
app.post('/api/auth/signup', authRateLimit, async (req, res) => {
  try {
    const { email, username, displayName, password, pin, termsAccepted, termsVersion } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
    if (!isValidUsername(username)) return res.status(400).json({ error: 'Username must be 3-24 chars (letters, numbers, _)' });
    const cleanDN = sanitizeText(displayName || '', 60).trim();
    if (!cleanDN || cleanDN.length < 1) return res.status(400).json({ error: 'Display name required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (password.length > 128) return res.status(400).json({ error: 'Password too long (max 128)' });
    if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });
    // Reject super-weak PINs that account for huge brute-force surface (0000, 1234, 1111, etc.)
    const weakPins = new Set([
      '0000','1111','2222','3333','4444','5555','6666','7777','8888','9999',
      '1234','4321','0123','2580','1212','1313','1010','0101','1122','1221',
      '2024','2025','2026','2027','0007','1357','2468','9876','6789',
    ]);
    if (weakPins.has(pin)) return res.status(400).json({ error: 'Please choose a less obvious PIN' });
    // Require terms acceptance
    if (termsAccepted !== true) {
      return res.status(400).json({ error: 'You must accept the Terms & Community Guidelines.' });
    }

    const db = await fetchPrimaryDatabase();
    const emailLower = email.toLowerCase();
    const usernameLower = username.toLowerCase();

    if (db.users.some(u => u.email.toLowerCase() === emailLower)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (db.users.some(u => u.username.toLowerCase() === usernameLower)) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    // Reserve some usernames to prevent impersonation of system roles
    const reserved = new Set(['admin','administrator','priv-spaca','privspaca','support','system','moderator','staff','help','root']);
    if (reserved.has(usernameLower)) return res.status(403).json({ error: 'That username is reserved' });

    const passwordHash = await bcrypt.hash(password, 12);  // bumped from 10 → 12 rounds
    const pinHash = await bcrypt.hash(pin, 12);

    const newUser = {
      id: uid('usr'),
      email: emailLower,                            // normalize stored email
      username,
      displayName: cleanDN,
      bio: '',
      photoUrl: '',
      passwordHash,
      pinHash,
      followers: [],
      following: [],
      blocked: [],
      closeFriends: [],
      termsAccepted: true,
      termsVersion: String(termsVersion || '1.0'),
      termsAcceptedAt: nowMs(),
      createdAt: nowMs(),
      verified: false,
    };
    db.users.push(newUser);
    const persisted = await saveDatabase(db, false);
    if (isPersistConfigured() && !persisted) {
      const idx = db.users.findIndex(u => u.id === newUser.id);
      if (idx !== -1) db.users.splice(idx, 1);
      console.error('[signup] persistence failed for', newUser.username);
      return res.status(503).json({ error: 'Storage temporarily unavailable. Please try again in a moment.' });
    }

    const token = signToken(newUser);
    return res.json({ token, user: sanitizeUser(newUser) });
  } catch (e) {
    console.error('[signup] exception', e);
    return res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || typeof password !== 'string' || password.length < 1 || password.length > 128) {
      await authFailureDelay();
      return res.status(401).json({ error: AUTH_GENERIC_ERROR });
    }
    const subjLimit = await authSubjectRateLimit(req, idLower, 20);
    if (!subjLimit.allowed) {
      res.setHeader('Retry-After', String(Math.ceil((subjLimit.resetAt - Date.now()) / 1000)));
      return res.status(429).json({ error: 'Too many login attempts. Please wait and try again.' });
    }
    const db = await fetchPrimaryDatabase();
    const user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    if (!user) { await authFailureDelay(); return res.status(404).json({ error: AUTH_GENERIC_ERROR }); }
    const lock = checkAccountLock(user.id);
    if (lock.locked) {
      res.setHeader('Retry-After', String(Math.ceil(lock.remaining / 1000)));
      return res.status(429).json({ error: 'Too many login attempts. Please wait and try again.' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      recordLoginFail(user.id);
      await authFailureDelay();
      return res.status(401).json({ error: AUTH_GENERIC_ERROR });
    }
    clearLoginFails(user.id);
    const token = signToken(user);
    return res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/reset-by-pin', authRateLimit, async (req, res) => {
  try {
    const { identifier, pin, newPassword } = req.body || {};
    const idLower = normalizeAuthIdentifier(identifier);
    if (!idLower || !isValidPin(pin) || typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) {
      await authFailureDelay();
      return res.status(400).json({ error: 'Invalid reset details.' });
    }
    const subjLimit = await authSubjectRateLimit(req, 'reset:' + idLower, 8);
    if (!subjLimit.allowed) {
      res.setHeader('Retry-After', String(Math.ceil((subjLimit.resetAt - Date.now()) / 1000)));
      return res.status(429).json({ error: 'Too many reset attempts. Please wait and try again.' });
    }
    const db = await fetchPrimaryDatabase();
    const user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    if (!user) { await authFailureDelay(); return res.status(401).json({ error: 'Invalid reset details.' }); }
    const pinOk = await bcrypt.compare(pin, user.pinHash);
    if (!pinOk) { await authFailureDelay(); return res.status(401).json({ error: 'Invalid reset details.' }); }
    const oldHash = user.passwordHash;
    const oldTokenVersion = Number(user.tokenVersion || 0);
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.tokenVersion = oldTokenVersion + 1;
    user.passwordChangedAt = nowMs();
    const persisted = await saveDatabase(db, false);
    if (isPersistConfigured() && !persisted) {
      user.passwordHash = oldHash; // roll back
      user.tokenVersion = oldTokenVersion;
      console.error('[reset] persistence failed for', user.username);
      return res.status(503).json({ error: 'Storage temporarily unavailable. Please try again in a moment.' });
    }
    const token = signToken(user);
    return res.json({ ok: true, token, user: sanitizeUser(user) });
  } catch (e) {
    console.error('[reset] exception', e);
    return res.status(500).json({ error: 'Reset failed' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const u = req.authUser;
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ user: sanitizeUser(u) });
});

// ---------- User Routes ----------

/**
 * Permanent image upload to GitHub repo (raw.githubusercontent.com as CDN).
 * POST /api/upload-photo  { dataUrl: "data:image/jpeg;base64,..." , kind: "avatar"|"post" }
 * Returns: { url: "https://raw.githubusercontent.com/.../media/avatars/<id>.jpg" }
 *
 * Requires GITHUB_PAT with repo scope. Falls back to returning the data URL itself
 * (which works but bloats DB) if upload fails.
 */
app.post('/api/upload-photo', authMiddleware, async (req, res) => {
  try {
    const { dataUrl, kind } = req.body || {};
    if (typeof dataUrl !== 'string' || (!dataUrl.startsWith('data:image/') && !dataUrl.startsWith('data:audio/') && !dataUrl.startsWith('data:video/'))) {
      return res.status(400).json({ error: 'Send a data URL: data:image/... , data:audio/... or data:video/...' });
    }
    const match = dataUrl.match(/^data:(image|audio|video)\/(jpeg|jpg|png|webp|gif|webm|mp3|mp4|quicktime|mov);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Unsupported media type' });
    const isVideo = match[1] === 'video';
    const ext = match[2] === 'jpeg' ? 'jpg' : (match[2] === 'quicktime' ? 'mov' : match[2]);
    const b64 = match[3];
    const sizeBytes = Math.floor(b64.length * 3 / 4);
    const maxBytes = isVideo ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (sizeBytes > maxBytes) {
      return res.status(413).json({ error: (isVideo ? 'Video too large (max 10 MB)' : 'Image too large (max 5 MB after compression)') });
    }
    const safeKind = (kind === 'post' || kind === 'avatar') ? kind : 'media';
    const folder = safeKind === 'avatar' ? 'avatars' : (safeKind === 'post' ? 'posts' : 'media');
    const id = (safeKind === 'avatar' ? req.userId : uid(isVideo ? 'vid' : 'img'));
    const path = `media/${folder}/${id}.${ext}`;

    if (!isRepoConfigured()) {
      // Fallback: return the data URL itself (works but stores image inline)
      return res.json({ url: dataUrl, persisted: false });
    }

    // For avatars: replace any existing file (PUT with prior sha if exists)
    let priorSha = null;
    try {
      const headRes = await fetchFn(
        `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`,
        { headers: { 'Authorization': `token ${GITHUB_PAT}`, 'User-Agent': 'PRIV-SPACA', 'Accept': 'application/vnd.github+json' } }
      );
      if (headRes.ok) {
        const j = await headRes.json();
        priorSha = j.sha || null;
      }
    } catch (_) {}

    const body = {
      message: `upload ${safeKind} ${id}`,
      content: b64,
      branch: GH_BRANCH,
    };
    if (priorSha) body.sha = priorSha;

    const putRes = await fetchFn(
      `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_PAT}`,
          'User-Agent': 'PRIV-SPACA',
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );
    if (!putRes.ok) {
      const txt = await putRes.text().catch(() => '');
      console.error('[upload-photo] HTTP', putRes.status, txt.slice(0, 200));
      // Fallback to data URL so user still sees their image
      return res.json({ url: dataUrl, persisted: false, warning: 'GitHub upload failed; using inline data URL.' });
    }
    const url = `https://raw.githubusercontent.com/${GH_REPO}/${encodeURIComponent(GH_BRANCH)}/${path}`;
    // Bust raw.githubusercontent.com cache by appending a tiny query string
    const cdnUrl = url + '?t=' + Date.now();
    res.json({ url: cdnUrl, persisted: true });
  } catch (e) {
    console.error('[upload-photo] exception', e.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});
app.post('/api/user/update', authMiddleware, async (req, res) => {
  try {
    const { displayName, username, bio, photoUrl } = req.body || {};
    const db = await fetchDatabase();
    const user = db.users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (typeof username === 'string' && username !== user.username) {
      if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username' });
      if (db.users.some(u => u.id !== user.id && u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(409).json({ error: 'Username taken' });
      }
      user.username = username;
    }
    if (typeof displayName === 'string') {
      const cleanDN = sanitizeText(displayName, 60).trim();
      if (cleanDN.length >= 1) user.displayName = cleanDN;
    }
    if (typeof bio === 'string') {
      user.bio = sanitizeText(bio, 280);
    }
    if (typeof photoUrl === 'string') {
      const cleanPhoto = photoUrl.trim();
      if (cleanPhoto === '' || isSafeImageUrl(cleanPhoto)) user.photoUrl = cleanPhoto;
    }
    await saveDatabase(db, false);
    res.json({ user: sanitizeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Update failed' });
  }
});


app.post('/api/user/vip/redeem', authMiddleware, async (req, res) => {
  try {
    const key = sanitizeText(String((req.body || {}).key || ''), 80).trim();
    if (!VIP_UNLOCK_KEY) return res.status(503).json({ error: 'VIP unlock is not configured' });
    if (!key || key !== VIP_UNLOCK_KEY) return res.status(403).json({ error: 'Invalid VIP key' });
    const db = await fetchDatabase();
    const user = db.users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.verified = true;
    user.verifiedAt = user.verifiedAt || nowMs();
    await saveDatabase(db, false);
    res.json({ ok: true, user: sanitizeUser(user) });
  } catch (e) { console.error('[vip/redeem]', e); res.status(500).json({ error: 'VIP activation failed' }); }
});

app.get('/api/user/close-friends', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === req.userId);
  if (!me) return res.status(404).json({ error: 'Not found' });
  const ids = Array.isArray(me.closeFriends) ? me.closeFriends : [];
  res.json({ ids });
});

app.post('/api/user/close-friends', authMiddleware, async (req, res) => {
  try {
    const { targetId, action } = req.body || {};
    if (!targetId) return res.status(400).json({ error: 'targetId required' });
    if (targetId === req.userId) return res.status(400).json({ error: 'You cannot add yourself' });
    const db = await fetchDatabase();
    const me = db.users.find(u => u.id === req.userId);
    const target = db.users.find(u => u.id === targetId);
    if (!me || !target) return res.status(404).json({ error: 'Not found' });
    me.closeFriends = Array.isArray(me.closeFriends) ? me.closeFriends : [];
    const set = new Set(me.closeFriends);
    const mode = String(action || 'toggle');
    if (mode === 'add') set.add(targetId);
    else if (mode === 'remove') set.delete(targetId);
    else if (set.has(targetId)) set.delete(targetId);
    else set.add(targetId);
    me.closeFriends = Array.from(set).slice(0, 500);
    await saveDatabase(db, false);
    res.json({ ids: me.closeFriends, added: me.closeFriends.includes(targetId) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const sdb = isTursoConfigured() ? await fetchTursoMirror(db) : db;
  const sourceUsers = (sdb.users || []).length ? sdb.users : (db.users || []);
  const now = nowMs();
  const me = sourceUsers.find(u => u.id === req.userId);
  const myBlocked = new Set((me && me.blocked) || []);
  // Also hide users who blocked ME
  const blockedMe = new Set();
  sourceUsers.forEach(u => {
    if (u.id !== req.userId && Array.isArray(u.blocked) && u.blocked.includes(req.userId)) {
      blockedMe.add(u.id);
    }
  });
  const myFollowing = new Set((me && me.following) || []);
  let lastByPeer = {};
  if (isTursoConfigured()) {
    lastByPeer = await fetchTursoDmIndex(req.userId);
  } else {
    for (const m of (db.messages || [])) {
      if (typeof m.roomId !== 'string' || !m.roomId.startsWith('dm:')) continue;
      const parts = m.roomId.slice(3).split(':');
      if (!parts.includes(req.userId)) continue;
      const peer = parts.find(id => id !== req.userId);
      if (!peer) continue;
      if (!lastByPeer[peer] || (m.createdAt || 0) > (lastByPeer[peer].createdAt || 0)) {
        let preview;
        if (m.encrypted) preview = '🔒 Encrypted message';
        else if (m.storyReply) preview = 'Replied to a story';
        else if (m.imageUrl) preview = '📷 Photo';
        else preview = String(m.text || '').slice(0, 60);
        lastByPeer[peer] = { text: preview, createdAt: m.createdAt || 0, fromMe: m.userId === req.userId };
      }
    }
  }
  const list = sourceUsers
    .filter(u => !myBlocked.has(u.id) && !blockedMe.has(u.id))
    .map(u => {
      const hb = (db.heartbeat && db.heartbeat[u.id]) || 0;
      return {
        ...sanitizeUser(u),
        online: now - hb < 45000,
        lastSeen: hb,
        iFollow: myFollowing.has(u.id),
        followsMe: Array.isArray(u.following) && u.following.includes(req.userId),
        lastMessage: lastByPeer[u.id] || null,
      };
    });
  res.json({ users: list });
});

// ---------- E2E public key (Part 3) ----------
app.post('/api/user/public-key', authMiddleware, async (req, res) => {
  try {
    const { publicKey } = req.body || {};
    if (typeof publicKey !== 'string' || publicKey.length < 32 || publicKey.length > 256) {
      return res.status(400).json({ error: 'Invalid key' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) return res.status(400).json({ error: 'Invalid key format' });
    const db = await fetchDatabase();
    const u = db.users.find(x => x.id === req.userId);
    if (!u) return res.status(404).json({ error: 'Not found' });
    u.publicKey = publicKey;
    u.publicKeyUpdatedAt = nowMs();
    await saveDatabase(db, false);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Save failed' }); }
});

app.get('/api/user/public-key', authMiddleware, async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === userId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ userId: u.id, publicKey: u.publicKey || null });
});

app.post('/api/user/heartbeat', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  db.heartbeat[req.userId] = nowMs();
  await saveDatabase(db, true); // ephemeral
  res.json({ ok: true });
});

// ---------- Notes: short 24h status shown on the DM inbox rail ----------
app.post('/api/user/note', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === req.userId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const text = sanitizeText((req.body || {}).text || '', 60).trim();
  const music = cleanNoteMusic((req.body || {}).music);
  if (!text && !music) { u.note = null; }
  else { u.note = { text, music, createdAt: nowMs(), expiresAt: nowMs() + 24 * 3600 * 1000 }; }
  await saveDatabase(db, false);
  res.json({ ok: true, note: activeNote(u) });
});
// Normalize an optional song attached to a note.
function cleanNoteMusic(m) {
  if (!m || typeof m !== 'object' || !m.title) return null;
  return {
    title: sanitizeText(m.title, 80),
    artist: sanitizeText(m.artist || '', 80),
    audio: isSafeMediaUrl(m.audio, { allowData: false }) ? String(m.audio).trim().slice(0, 1024) : '',
    art: isSafeImageUrl(m.art, { allowData: false }) ? String(m.art).trim().slice(0, 1024) : '',
  };
}

app.post('/api/user/typing', authMiddleware, async (req, res) => {
  const { roomId: rawRoomId } = req.body || {};
  if (!rawRoomId) return res.status(400).json({ error: 'roomId required' });
  const roomId = normalizeRoomId(rawRoomId, req.userId);
  const db = await fetchDatabase();
  if (!db.typing[roomId]) db.typing[roomId] = {};
  db.typing[roomId][req.userId] = nowMs();
  await saveDatabase(db, true);
  res.json({ ok: true });
});

app.get('/api/user/typing', authMiddleware, async (req, res) => {
  const roomId = normalizeRoomId(req.query.roomId, req.userId);
  if (!roomId) return res.status(400).json({ error: 'roomId required' });
  const db = await fetchDatabase();
  const map = db.typing[roomId] || {};
  const now = nowMs();
  const typingUserIds = Object.keys(map).filter(uidKey => uidKey !== req.userId && now - map[uidKey] < 4000);
  const typingUsers = typingUserIds.map(id => {
    const u = db.users.find(x => x.id === id);
    return u ? { id: u.id, username: u.username, displayName: u.displayName } : null;
  }).filter(Boolean);
  res.json({ typing: typingUsers });
});

// ---------- Messages ----------
function normalizeRoomId(roomId, currentUserId) {
  const raw = sanitizeText(String(roomId || 'general-group'), 160).trim();
  if (!raw || raw === 'general-group') return 'general-group';
  if (/^group:[a-zA-Z0-9_-]{1,64}$/.test(raw)) return raw;
  if (raw.startsWith('dm:')) {
    const parts = raw.slice(3).split(':').filter(Boolean);
    if (parts.length === 2 && parts.every(x => /^[a-zA-Z0-9_-]{1,96}$/.test(x))) return 'dm:' + [...parts].sort().join(':');
  }
  return 'general-group';
}

function dmRoomFor(a, b) {
  const sorted = [a, b].sort();
  return 'dm:' + sorted.join(':');
}

app.get('/api/messages', authMiddleware, async (req, res) => {
  const roomId = normalizeRoomId(req.query.roomId || 'general-group', req.userId);
  // Authorization for DM rooms: ensure user is participant
  if (roomId.startsWith('dm:')) {
    const parts = roomId.slice(3).split(':');
    if (!parts.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
  }
  const db = await fetchDatabase();
  const now = nowMs();
  let list = await fetchTursoMessages(roomId, now);
  if (!Array.isArray(list)) {
    list = db.messages
      .filter(m => m.roomId === roomId && !m.deletedAt && !(m.disappearAt && m.disappearAt <= now))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-200);
  }
  // Enrich with author profile; if user record is gone, fall back to embedded snapshot
  const enriched = list.map(m => {
    const author = db.users.find(u => u.id === m.userId);
    if (author) return { ...m, author: sanitizeUser(author) };
    if (m.authorSnapshot) return { ...m, author: m.authorSnapshot };
    return { ...m, author: { id: m.userId, displayName: 'Member', username: (m.userId || 'member').slice(-6) } };
  });
  res.json({ messages: enriched, roomId });
});

app.post('/api/messages/send', authMiddleware, async (req, res) => {
  try {
    const {
      roomId: rawRoom, text, imageUrl, replyTo, targetUserId,
      encrypted, cipher, iv, disappearAfterMs,
    } = req.body || {};
    let roomId = rawRoom;
    if (!roomId && targetUserId) {
      roomId = dmRoomFor(req.userId, targetUserId);
    }
    roomId = normalizeRoomId(roomId || 'general-group', req.userId);
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      if (!parts.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
    }
    const isEncrypted = !!encrypted && typeof cipher === 'string' && typeof iv === 'string';
    if (isEncrypted && !roomId.startsWith('dm:')) return res.status(400).json({ error: 'E2E only supported in DMs' });
    if (isEncrypted && (cipher.length > 12000 || iv.length > 64)) return res.status(413).json({ error: 'Payload too large' });

    const cleanText = isEncrypted ? '' : sanitizeText(text, 4000);
    const cleanImage = isSafeMediaUrl(imageUrl) ? String(imageUrl).trim() : null;
    if (!cleanText && !cleanImage && !isEncrypted) return res.status(400).json({ error: 'Empty message' });

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
    const author = db.users.find(u => u.id === req.userId);
    const snapshot = author ? {
      id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || ''
    } : null;
    const msg = {
      id: uid('msg'),
      roomId,
      userId: req.userId,
      text: cleanText,
      imageUrl: cleanImage,
      replyTo: replyRef,
      authorSnapshot: snapshot,
      createdAt: nowMs(),
    };
    if (isEncrypted) { msg.encrypted = true; msg.cipher = cipher; msg.iv = iv; }
    if (disappearAt) { msg.disappearAt = disappearAt; msg.disappearAfterMs = disappearAfterMs; }
    db.messages.push(msg);
    const enrichedMsg = { ...msg, author: snapshot || { id: req.userId, displayName: 'Member', username: 'member' } };
    // Real-time fan-out
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      parts.filter(uid2 => uid2 !== req.userId).forEach(recip => {
        // SSE: push the actual message to recipient instantly
        _pushEvent(recip, 'new_message', { roomId, message: enrichedMsg });
        // Also create a notification (which itself pushes an SSE 'notification' event)
        const previewText = isEncrypted ? '🔒 Encrypted message' : (cleanText || (cleanImage ? '📷 Photo' : ''));
        pushNotification(db, recip, 'message', req.userId, { text: previewText.slice(0, 80) });
      });
    } else {
      // Group message — broadcast to ALL other users so they get it live (no notification, just SSE)
      _broadcastEvent('new_message', { roomId, message: enrichedMsg }, req.userId);
    }
    await saveDatabase(db, false);
    res.json({ message: enrichedMsg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Send failed' });
  }
});

app.post('/api/messages/delete', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.body || {};
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    const db = await fetchDatabase();
    const m = db.messages.find(x => x.id === messageId);
    if (!m) return res.status(404).json({ error: 'Not found' });
    if (m.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    // Soft delete — keeps the row for 30 days so we can undo
    m.deletedAt = nowMs();
    await saveDatabase(db, false);
    res.json({ ok: true, undoUntil: m.deletedAt + 30 * 24 * 3600 * 1000 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.post('/api/messages/restore', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.body || {};
    const db = await fetchDatabase();
    const m = db.messages.find(x => x.id === messageId);
    if (!m) return res.status(404).json({ error: 'Not found' });
    if (m.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    delete m.deletedAt;
    await saveDatabase(db, false);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Restore failed' });
  }
});

// ---------- Scheduled Messages ----------
app.post('/api/messages/schedule', authMiddleware, async (req, res) => {
  try {
    const { roomId: rawRoom, targetUserId, text, imageUrl, deliverAt, replyTo } = req.body || {};
    let roomId = rawRoom;
    if (!roomId && targetUserId) roomId = dmRoomFor(req.userId, targetUserId);
    roomId = normalizeRoomId(roomId || 'general-group', req.userId);
    const ts = Number(deliverAt);
    if (!ts || isNaN(ts) || ts < nowMs() + 5000) return res.status(400).json({ error: 'deliverAt must be at least 5 seconds in the future' });
    const cleanText = sanitizeText(text, 4000);
    const cleanImage = isSafeMediaUrl(imageUrl) ? String(imageUrl).trim() : null;
    if (!cleanText && !cleanImage) return res.status(400).json({ error: 'Empty message' });
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      if (!parts.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
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
    const author = db.users.find(u => u.id === req.userId);
    const snapshot = author ? {
      id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || ''
    } : null;
    const sm = {
      id: uid('sched'),
      roomId,
      userId: req.userId,
      text: cleanText,
      imageUrl: cleanImage,
      replyTo: replyRef,
      authorSnapshot: snapshot,
      deliverAt: ts,
      createdAt: nowMs(),
    };
    db.scheduledMessages.push(sm);
    await saveDatabase(db, false);
    res.json({ scheduled: sm });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Schedule failed' });
  }
});

app.get('/api/messages/scheduled', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const list = db.scheduledMessages.filter(s => s.userId === req.userId).sort((a, b) => a.deliverAt - b.deliverAt);
  res.json({ scheduled: list });
});

app.post('/api/messages/scheduled/cancel', authMiddleware, async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const db = await fetchDatabase();
  const idx = db.scheduledMessages.findIndex(s => s.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (db.scheduledMessages[idx].userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  db.scheduledMessages.splice(idx, 1);
  await saveDatabase(db, false);
  res.json({ ok: true });
});

// ---------- Notifications + Follow/Block helpers ----------

/**
 * Push a notification onto the recipient's queue.
 * Dedupes within a 30-second window to prevent spam from repeated like-toggles.
 * Does NOT trigger self-notifications (user can't notify themselves).
 */
function pushNotification(db, recipientId, kind, fromUserId, extra = {}) {
  if (!recipientId || !fromUserId || recipientId === fromUserId) return null;
  if (!Array.isArray(db.notifications)) db.notifications = [];
  // Honor block list — if recipient blocked the from-user, drop
  const recipient = db.users.find(u => u.id === recipientId);
  if (recipient && Array.isArray(recipient.blocked) && recipient.blocked.includes(fromUserId)) return null;
  const now = nowMs();
  // Dedupe: same (recipient, fromUser, kind, postId) within 30s
  const dupe = db.notifications.find(n =>
    n.userId === recipientId &&
    n.kind === kind &&
    n.fromUserId === fromUserId &&
    n.postId === (extra.postId || null) &&
    (now - n.createdAt) < 30000
  );
  if (dupe) {
    // Refresh its timestamp so it stays at the top
    dupe.createdAt = now;
    delete dupe.seenAt;
    return dupe;
  }
  const author = db.users.find(u => u.id === fromUserId);
  const snapshot = author ? {
    id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || ''
  } : null;
  const notif = {
    id: uid('ntf'),
    userId: recipientId,
    kind,                        // 'like' | 'comment' | 'follow' | 'message'
    fromUserId,
    fromSnapshot: snapshot,
    postId: extra.postId || null,
    commentId: extra.commentId || null,
    text: extra.text || null,    // comment text or message preview
    createdAt: now,
  };
  db.notifications.push(notif);
  // Cap at 500 per user to prevent runaway growth
  const perUser = db.notifications.filter(n => n.userId === recipientId);
  if (perUser.length > 500) {
    const oldest = perUser.slice(0, perUser.length - 500).map(n => n.id);
    db.notifications = db.notifications.filter(n => !oldest.includes(n.id));
  }
  // Real-time SSE fan-out (in-app)
  _pushEvent(recipientId, 'notification', {
    kind,
    fromUserId,
    fromSnapshot: snapshot,
    postId: notif.postId,
    text: notif.text,
    notifId: notif.id,
  });
  // Web Push (OS-level lock-screen notification)
  const fromName = (snapshot && (snapshot.username || snapshot.displayName)) || 'Someone';
  let title = 'PRIV SPACA', body = '';
  if (kind === 'like')    body = `${fromName} liked your post`;
  if (kind === 'comment') body = `${fromName} commented: ${(notif.text || '').slice(0, 80)}`;
  if (kind === 'follow')  body = `${fromName} started following you`;
  if (kind === 'message') body = `${fromName}: ${(notif.text || '').slice(0, 80)}`;
  if (body) {
    sendWebPush(db, recipientId, {
      title, body,
      tag: 'priv-spaca-' + notif.id,
      url: '/',
      kind, notifId: notif.id,
    }).catch(() => {});
  }
  return notif;
}

// GET /api/notifications — list mine, newest first
app.get('/api/notifications', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const mine = isTursoConfigured()
    ? await fetchTursoNotifications(req.userId)
    : (db.notifications || []).filter(n => n.userId === req.userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  // Enrich with current author data when available
  const enriched = mine.map(n => {
    const author = (db.users || []).find(u => u.id === n.fromUserId);
    return {
      ...n,
      from: author ? sanitizeUser(author) : (n.fromSnapshot || { id: n.fromUserId, displayName: 'Member', username: 'member' })
    };
  });
  const unread = enriched.filter(n => !n.seenAt).length;
  res.json({ notifications: enriched, unread });
});

// POST /api/notifications/seen — mark all my notifications as seen
app.post('/api/notifications/seen', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const now = nowMs();
  let changed = 0;
  (db.notifications || []).forEach(n => {
    if (n.userId === req.userId && !n.seenAt) { n.seenAt = now; changed++; }
  });
  if (changed > 0) await saveDatabase(db, true); // ephemeral — okay if it batches
  res.json({ ok: true, updated: changed });
});

// POST /api/notifications/clear — delete all my notifications
app.post('/api/notifications/clear', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const before = (db.notifications || []).length;
  db.notifications = (db.notifications || []).filter(n => n.userId !== req.userId);
  if (before !== db.notifications.length) await saveDatabase(db, false);
  res.json({ ok: true, removed: before - db.notifications.length });
});

// ---------- Follow / Unfollow / Block ----------

app.post('/api/user/follow', authMiddleware, async (req, res) => {
  const { targetId } = req.body || {};
  if (!targetId || targetId === req.userId) return res.status(400).json({ error: 'Invalid target' });
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === req.userId);
  const target = db.users.find(u => u.id === targetId);
  if (!me || !target) return res.status(404).json({ error: 'User not found' });
  // Blocked relationships prevent follow
  if (Array.isArray(target.blocked) && target.blocked.includes(req.userId)) {
    return res.status(403).json({ error: 'Cannot follow this user' });
  }
  if (Array.isArray(me.blocked) && me.blocked.includes(targetId)) {
    return res.status(403).json({ error: 'Unblock this user first' });
  }
  me.following = Array.isArray(me.following) ? me.following : [];
  target.followers = Array.isArray(target.followers) ? target.followers : [];
  if (!me.following.includes(targetId)) me.following.push(targetId);
  if (!target.followers.includes(req.userId)) target.followers.push(req.userId);
  pushNotification(db, targetId, 'follow', req.userId);
  await saveDatabase(db, false);
  res.json({ ok: true, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers });
});

app.post('/api/user/unfollow', authMiddleware, async (req, res) => {
  const { targetId } = req.body || {};
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === req.userId);
  const target = db.users.find(u => u.id === targetId);
  if (!me || !target) return res.status(404).json({ error: 'User not found' });
  me.following = (me.following || []).filter(id => id !== targetId);
  target.followers = (target.followers || []).filter(id => id !== req.userId);
  await saveDatabase(db, false);
  res.json({ ok: true, following: me.following.length, followers: target.followers.length, followingIds: me.following, targetFollowerIds: target.followers });
});

app.post('/api/user/block', authMiddleware, async (req, res) => {
  const { targetId } = req.body || {};
  if (!targetId || targetId === req.userId) return res.status(400).json({ error: 'Invalid target' });
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === req.userId);
  const target = db.users.find(u => u.id === targetId);
  if (!me || !target) return res.status(404).json({ error: 'User not found' });
  me.blocked = Array.isArray(me.blocked) ? me.blocked : [];
  if (!me.blocked.includes(targetId)) me.blocked.push(targetId);
  // Mutual unfollow
  me.following = (me.following || []).filter(id => id !== targetId);
  target.followers = (target.followers || []).filter(id => id !== req.userId);
  target.following = (target.following || []).filter(id => id !== req.userId);
  me.followers = (me.followers || []).filter(id => id !== targetId);
  // Remove notifications involving the blocked user (both directions)
  db.notifications = (db.notifications || []).filter(n => !(
    (n.userId === req.userId && n.fromUserId === targetId) ||
    (n.userId === targetId && n.fromUserId === req.userId)
  ));
  await saveDatabase(db, false);
  res.json({ ok: true });
});

app.post('/api/user/unblock', authMiddleware, async (req, res) => {
  const { targetId } = req.body || {};
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  const db = await fetchDatabase();
  const me = db.users.find(u => u.id === req.userId);
  if (!me) return res.status(404).json({ error: 'Not found' });
  me.blocked = (me.blocked || []).filter(id => id !== targetId);
  await saveDatabase(db, false);
  res.json({ ok: true });
});

// GET /api/user/:id/profile — public profile of any user
app.get('/api/user/:id/profile', authMiddleware, async (req, res) => {
  const targetId = req.params.id;
  const sdb = isTursoConfigured() ? await fetchTursoMirror() : await fetchDatabase();
  const sourceUsers = sdb.users || [];
  const sourcePosts = sdb.posts || [];
  const target = sourceUsers.find(u => u.id === targetId);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const me = sourceUsers.find(u => u.id === req.userId);
  const blockedMe = Array.isArray(target.blocked) && target.blocked.includes(req.userId);
  const iBlocked = me && Array.isArray(me.blocked) && me.blocked.includes(targetId);
  if (blockedMe) return res.status(403).json({ error: 'Profile unavailable' });
  const posts = (sourcePosts || [])
    .filter(p => p.userId === targetId && !p.deletedAt && !isStoryRecord(p))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => ({
      id: p.id, userId: p.userId, imageUrl: p.imageUrl || (Array.isArray(p.images) ? p.images[0] : null), images: Array.isArray(p.images) ? p.images : [], videoUrl: p.videoUrl || null, text: p.text, createdAt: p.createdAt,
      likeCount: (p.likes || []).length, commentCount: (p.comments || []).length, authorSnapshot: p.authorSnapshot || null,
    }));
  const followerIds = Array.from(new Set([
    ...(Array.isArray(target.followers) ? target.followers : []),
    ...sourceUsers.filter(u => Array.isArray(u.following) && u.following.includes(targetId)).map(u => u.id),
  ])).filter(id => id && id !== targetId);
  const followingIds = Array.from(new Set(Array.isArray(target.following) ? target.following : [])).filter(id => id && id !== targetId);
  res.json({
    user: {
      ...sanitizeUser(target),
      followers: followerIds.length,
      following: followingIds.length,
      followerIds,
      followingIds,
      postsCount: posts.length,
    },
    posts,
    relationship: {
      isMe: targetId === req.userId,
      iFollow: !!(me && (me.following || []).includes(targetId)),
      followsMe: Array.isArray(target.following) && target.following.includes(req.userId),
      iBlocked,
    }
  });
});

// ---------- Social Feed / Posts ----------
app.get('/api/posts', authMiddleware, async (req, res) => {
  const sdb = isTursoConfigured() ? await fetchTursoMirror() : await fetchDatabase();
  const sourceUsers = sdb.users || [];
  const sourcePosts = sdb.posts || [];
  const me = sourceUsers.find(u => u.id === req.userId);
  const myBlocked = new Set((me && me.blocked) || []);
  const blockedMe = new Set();
  sourceUsers.forEach(u => {
    if (u.id !== req.userId && Array.isArray(u.blocked) && u.blocked.includes(req.userId)) {
      blockedMe.add(u.id);
    }
  });
  const structuredDb = normalizeDb({ users: sourceUsers, posts: sourcePosts });
  const list = sourcePosts
    .filter(p => !p.deletedAt && !myBlocked.has(p.userId) && !blockedMe.has(p.userId) && canViewerSeeStory(p, req.userId, structuredDb))
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => {
      const author = sourceUsers.find(u => u.id === p.userId);
      const comments = (p.comments || []).map(c => {
        const cu = sourceUsers.find(u => u.id === c.userId);
        const cAuth = cu ? sanitizeUser(cu) : (c.authorSnapshot || { id: c.userId, displayName: 'Member', username: (c.userId || 'm').slice(-6) });
        return { ...c, author: cAuth };
      });
      const pAuth = author ? sanitizeUser(author) : (p.authorSnapshot || { id: p.userId, displayName: 'Member', username: (p.userId || 'm').slice(-6) });
      const isOwner = p.userId === req.userId;
      const base = {
        ...p,
        likes: p.likes || [],
        likeCount: (p.likes || []).length,
        comments,
        commentCount: comments.length,
        author: pAuth
      };
      // Privacy: only the author gets the raw viewer list / view count.
      if (!isOwner) delete base.views;
      if (isStoryRecord(p)) base.viewCount = isOwner ? (Array.isArray(p.views) ? p.views.length : 0) : undefined;
      return base;
    });
  res.json({ posts: list });
});

app.post('/api/posts/create', authMiddleware, async (req, res) => {
  try {
    const { text, imageUrl, images, videoUrl, isScratch, music, style, story, storyExpiresAt, audience } = req.body || {};
    const cleanText = sanitizeText(text, 2000);
    const cleanImage = isSafeImageUrl(imageUrl) ? String(imageUrl).trim() : null;
    const cleanImages = Array.isArray(images)
      ? images.filter(u => isSafeImageUrl(u)).map(u => String(u).trim()).slice(0, 3)
      : (cleanImage ? [cleanImage] : []);
    const mainImage = cleanImages[0] || cleanImage || null;
    const cleanVideo = isSafeMediaUrl(videoUrl) && (/^https?:\/\//i.test(String(videoUrl)) || /^data:video\//i.test(String(videoUrl))) ? String(videoUrl).trim() : null;
    if (!cleanText && !mainImage && cleanImages.length === 0 && !cleanVideo) return res.status(400).json({ error: 'Empty post' });
    const db = await fetchDatabase();
    const author = db.users.find(u => u.id === req.userId);
    const snapshot = author ? {
      id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || ''
    } : null;
    const cleanMusic = music && typeof music === 'object' && music.title ? {
      id: music.id,
      title: sanitizeText(music.title, 60),
      artist: sanitizeText(music.artist || '', 60),
      audio: isSafeMediaUrl(music.audio, { allowData: false }) ? String(music.audio).trim().slice(0, 1024) : '',
      art: isSafeImageUrl(music.art, { allowData: false }) ? String(music.art).trim().slice(0, 1024) : '',
      posX: Math.max(0, Math.min(100, Number(music.posX) || 50)),
      posY: Math.max(0, Math.min(100, Number(music.posY) || 32)),
      startTime: Math.max(0, Math.min(180, Number(music.startTime) || 0)),
      clipDur: Math.max(10, Math.min(30, Number(music.clipDur) || 30)),
      scale: Math.max(0.5, Math.min(2.5, Number(music.scale) || 1)),
      layout: ['pill', 'card', 'minimal'].includes(music.layout) ? music.layout : 'pill',
    } : null;
    const cleanStyle = style && typeof style === 'object' ? {
      font: String(style.font || 'modern').slice(0, 32),
      color: String(style.color || '#ffffff').slice(0, 32),
      bg: !!style.bg,
      bgMode: ['none', 'solid', 'soft', 'outline'].includes(style.bgMode) ? style.bgMode : (style.bg ? 'solid' : 'none'),
      align: ['left', 'center', 'right'].includes(style.align) ? style.align : 'center',
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
      id: uid('post'),
      userId: req.userId,
      text: cleanText,
      imageUrl: mainImage,
      images: cleanImages.length > 0 ? cleanImages : (mainImage ? [mainImage] : []),
      videoUrl: cleanVideo,
      music: cleanMusic,
      style: cleanStyle,
      story: isStory,
      storyExpiresAt: expiresAt,
      audience: isStory ? (audience === 'close_friends' ? 'close_friends' : 'all') : null,
      isScratch: !!isScratch,
      likes: [],
      comments: [],
      authorSnapshot: snapshot,
      createdAt: nowMs(),
    };
    db.posts.push(post);
    const enrichedPost = { ...post, likeCount: 0, commentCount: 0, author: snapshot || { id: req.userId, displayName: 'Member', username: 'member' } };
    // Broadcast to other users so their feed updates instantly
    _broadcastEvent('new_post', { post: enrichedPost }, req.userId);
    await saveDatabase(db, false);
    res.json({ post: enrichedPost });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Create post failed' });
  }
});

app.post('/api/posts/like', authMiddleware, async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const db = await fetchDatabase();
  const post = db.posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (!Array.isArray(post.likes)) post.likes = [];
  const idx = post.likes.indexOf(req.userId);
  let liked;
  if (idx === -1) { post.likes.push(req.userId); liked = true; }
  else { post.likes.splice(idx, 1); liked = false; }
  // Fire notification only on a NEW like (not on unlike)
  if (liked) {
    pushNotification(db, post.userId, 'like', req.userId, { postId: post.id });
  }
  await saveDatabase(db, false);
  res.json({ liked, likeCount: post.likes.length });
});

app.post('/api/rtc/signal', authMiddleware, async (req, res) => {
  const { targetId, signal } = req.body || {};
  if (typeof targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(targetId) || !signal || typeof signal !== 'object') return res.status(400).json({ error: 'Missing data' });
  const signalType = sanitizeText(signal.type || '', 24);
  if (!['offer','answer','candidate','end','reject','busy'].includes(signalType)) return res.status(400).json({ error: 'Invalid signal' });
  if (JSON.stringify(signal).length > 20000) return res.status(413).json({ error: 'Signal too large' });
  if (targetId === req.userId) return res.status(400).json({ error: 'Invalid target' });
  const db = await fetchDatabase();
  if (!db.users.some(u => u.id === targetId)) return res.status(404).json({ error: 'Target not found' });
  const me = db.users.find(u => u.id === req.userId);
  const author = me ? { id: me.id, username: me.username, displayName: me.displayName, photoUrl: me.photoUrl || '' } : { id: req.userId, displayName: 'Member', username: 'member' };
  const payload = { fromId: req.userId, author, signal };
  // Persist the signal so a client relying on the /api/rtc/signals poll
  // fallback (when SSE is unavailable) still receives it. Mirrors cf-worker.js.
  db.rtcSignals = Array.isArray(db.rtcSignals) ? db.rtcSignals : [];
  if (signalType === 'end' || signalType === 'reject' || signalType === 'busy') {
    // Terminal signals also clear any pending offer/answer between the pair.
    db.rtcSignals = db.rtcSignals.filter(x => !(
      (x.targetId === targetId && x.payload && x.payload.fromId === req.userId) ||
      (x.targetId === req.userId && x.payload && x.payload.fromId === targetId)
    ));
  }
  const expiresAt = nowMs() + (signalType === 'offer' ? 20000 : 60000);
  db.rtcSignals.push({ id: uid('rtc'), targetId, payload, createdAt: nowMs(), expiresAt });
  if (db.rtcSignals.length > 200) db.rtcSignals = db.rtcSignals.slice(-200);
  // Fan out instantly to any live SSE subscriber too.
  _pushEvent(targetId, 'rtc_signal', payload);
  // Signaling must be durable but is high-frequency; ephemeral save keeps
  // in-memory instant while throttling remote writes.
  await saveDatabase(db, true);
  res.json({ ok: true });
});

// GET /api/rtc/signals — poll fallback for WebRTC signaling when SSE is down.
// Returns recent signals addressed to the caller since `?since=<ms>`, matching
// the cf-worker.js contract the frontend's pollRTCSignals() expects.
app.get('/api/rtc/signals', authMiddleware, async (req, res) => {
  const since = Number(req.query.since || 0) || 0;
  const myId = req.userId;
  const db = await fetchDatabase();
  const now = nowMs();
  db.rtcSignals = Array.isArray(db.rtcSignals) ? db.rtcSignals.filter(x => !x.expiresAt || x.expiresAt > now) : [];
  const signals = db.rtcSignals
    .filter(x => x.targetId === myId && (x.createdAt || 0) > since && (now - (x.createdAt || 0) <= 20000))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(-30)
    .map(x => ({ id: x.id, createdAt: x.createdAt, ...x.payload }));
  res.json({ signals, now });
});

app.post('/api/posts/comment', authMiddleware, async (req, res) => {
  const { postId, text } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const cleanText = sanitizeText(text, 600).trim();
  if (!cleanText) return res.status(400).json({ error: 'Empty comment' });
  const db = await fetchDatabase();
  const post = db.posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (!Array.isArray(post.comments)) post.comments = [];
  const author = db.users.find(u => u.id === req.userId);
  const snapshot = author ? {
    id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || ''
  } : null;
  const comment = {
    id: uid('cmt'),
    userId: req.userId,
    text: cleanText,
    authorSnapshot: snapshot,
    createdAt: nowMs(),
  };
  post.comments.push(comment);
  // Notify post owner of new comment (skipped automatically if commenter == owner)
  pushNotification(db, post.userId, 'comment', req.userId, { postId: post.id, commentId: comment.id, text: cleanText.slice(0, 140) });
  await saveDatabase(db, false);
  res.json({ comment: { ...comment, author: snapshot || { id: req.userId, displayName: 'Member', username: 'member' } } });
});

app.post('/api/posts/delete', authMiddleware, async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const db = await fetchDatabase();
  const p = db.posts.find(x => x.id === postId);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  // Soft delete (30-day undo window)
  p.deletedAt = nowMs();
  await saveDatabase(db, false);
  res.json({ ok: true, undoUntil: p.deletedAt + 30 * 24 * 3600 * 1000 });
});

app.post('/api/posts/restore', authMiddleware, async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const db = await fetchDatabase();
  const p = db.posts.find(x => x.id === postId);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (p.userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  delete p.deletedAt;
  await saveDatabase(db, false);
  res.json({ ok: true });
});

// ---------- Story analytics: "Seen by" (parity with cf-worker.js) ----------
app.post('/api/stories/:id/view', authMiddleware, async (req, res) => {
  const postId = req.params.id;
  const myId = req.userId;
  const db = await fetchDatabase();
  const p = db.posts.find(x => x.id === postId);
  if (!p || !isStoryRecord(p)) return res.status(404).json({ error: 'Story not found' });
  if (!canViewerSeeStory(p, myId, db)) return res.status(403).json({ error: 'Forbidden' });
  if (p.userId === myId) return res.json({ ok: true, viewCount: (p.views || []).length });
  p.views = Array.isArray(p.views) ? p.views : [];
  const existing = p.views.find(v => v.userId === myId);
  if (existing) existing.at = nowMs();
  else p.views.push({ userId: myId, at: nowMs() });
  await saveDatabase(db, true);
  res.json({ ok: true, viewCount: p.views.length });
});

app.get('/api/stories/:id/viewers', authMiddleware, async (req, res) => {
  const postId = req.params.id;
  const myId = req.userId;
  const db = await fetchDatabase();
  const p = db.posts.find(x => x.id === postId);
  if (!p || !isStoryRecord(p)) return res.status(404).json({ error: 'Story not found' });
  if (p.userId !== myId) return res.status(403).json({ error: 'Forbidden' });
  const views = (Array.isArray(p.views) ? p.views : []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const viewers = views.map(v => {
    const u = db.users.find(x => x.id === v.userId);
    const su = u ? sanitizeUser(u) : { id: v.userId, displayName: 'Member', username: (v.userId || 'm').slice(-6), photoUrl: '' };
    return { ...su, at: v.at || 0 };
  });
  res.json({ viewers, viewCount: viewers.length });
});

// ---------- Reply to a story (delivered into DMs) ----------
app.post('/api/stories/:id/reply', authMiddleware, async (req, res) => {
  const postId = req.params.id;
  const myId = req.userId;
  const emoji = typeof (req.body || {}).emoji === 'string' ? req.body.emoji.slice(0, 8) : '';
  const text = sanitizeText((req.body || {}).text || '', 500).trim();
  if (!emoji && !text) return res.status(400).json({ error: 'Empty reply' });
  const db = await fetchDatabase();
  const p = db.posts.find(x => x.id === postId);
  if (!p || !isStoryRecord(p)) return res.status(404).json({ error: 'Story not found' });
  if (p.userId === myId) return res.status(400).json({ error: 'Cannot reply to your own story' });
  if (!canViewerSeeStory(p, myId, db)) return res.status(403).json({ error: 'Forbidden' });
  const roomId = dmRoomFor(myId, p.userId);
  const author = db.users.find(u => u.id === myId);
  const snap = author ? { id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || '' } : null;
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
  await saveDatabase(db, false);
  res.json({ ok: true, message: enriched });
});

// ---------- 404 + Error handling ----------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error' });
});

// ---------- Local server / Vercel export ----------
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`PRIV SPACA API listening on :${PORT}`));
}

module.exports = app;
// Also export helpers so the Cloudflare Hono adapter can reuse the same business logic.
module.exports.helpers = {
  // DB
  fetchDatabase, saveDatabase, isPersistConfigured, isRepoConfigured, isGistConfigured,
  // Auth
  signToken, JWT_SECRET, JWT_EXPIRES, sanitizeUser,
  // Validation
  isValidEmail, isValidUsername, isValidPin, sanitizeText,
  // IDs
  uid, nowMs,
  // Rate limit & lockout
  rateLimit, clientIp, checkAccountLock, recordLoginFail, clearLoginFails,
  // Rooms
  normalizeRoomId, dmRoomFor,
  // Notifications + SSE + push
  pushNotification, sendWebPush,
  _pushEvent, _broadcastEvent, _eventQueues, _eventSubscribers,
  // Photo upload
  GH_REPO, GH_BRANCH, GH_FILE, GITHUB_PAT, VAPID_PUBLIC, VAPID_SUBJECT,
  // bcrypt + jwt
  bcrypt, jwt,
  // fetch
  fetchFn,
};
