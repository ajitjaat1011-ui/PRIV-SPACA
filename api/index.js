/**
 * PRIV SPACA - Backend API
 * Express serverless app with GitHub Gist persistence + in-memory cache fallback.
 */

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// node-fetch v2 (CommonJS). If unavailable, fall back to globalThis.fetch (Node 18+).
let fetchFn;
try {
  fetchFn = require('node-fetch');
} catch (_) {
  fetchFn = (...args) => globalThis.fetch(...args);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'priv-spaca-dev-secret-change-me-in-production';
const JWT_EXPIRES = '7d';
// GitHub repo-file persistence (Contents API). Requires `repo` scope.
const GITHUB_PAT = process.env.GITHUB_PAT || '';
const GH_REPO    = process.env.GH_REPO    || 'ajitjaat1011-ui/PRIV-SPACA';
const GH_BRANCH  = process.env.GH_BRANCH  || 'data';
const GH_FILE    = process.env.GH_FILE    || 'db.json';
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
  typing: {},      // { roomId: { userId: timestamp } }
  heartbeat: {},   // { userId: timestamp }
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
async function fetchDatabase() {
  const now = nowMs();
  if (now - cacheTimestamp < CACHE_TTL_MS && cacheTimestamp !== 0) {
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
      typing: remote.typing && typeof remote.typing === 'object' ? remote.typing : {},
      heartbeat: remote.heartbeat && typeof remote.heartbeat === 'object' ? remote.heartbeat : {},
    };
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
  if (!Array.isArray(db.scheduledMessages) || db.scheduledMessages.length === 0) return false;
  const now = nowMs();
  const due = [];
  const remaining = [];
  for (const sm of db.scheduledMessages) {
    if (sm && typeof sm.deliverAt === 'number' && sm.deliverAt <= now) {
      due.push(sm);
    } else {
      remaining.push(sm);
    }
  }
  if (due.length === 0) return false;
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
  return ok;
}

// ---------- Auth helpers ----------
function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    req.username = payload.username;
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
  };
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

// ---------- Health ----------
app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    name: 'PRIV SPACA',
    persistence: isRepoConfigured() ? 'github-repo' : (isGistConfigured() ? 'gist' : 'in-memory'),
    time: nowMs(),
  });
});

// Diagnostics — verifies the configured persistence layer can READ & WRITE
app.get('/api/diag', async (req, res) => {
  const out = {
    persistence: isRepoConfigured() ? 'github-repo' : (isGistConfigured() ? 'gist' : 'in-memory'),
    repoConfigured: isRepoConfigured(),
    gistConfigured: isGistConfigured(),
    repo: GH_REPO,
    branch: GH_BRANCH,
    file: GH_FILE,
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
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, username, displayName, password, pin } = req.body || {};
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });
    if (!isValidUsername(username)) return res.status(400).json({ error: 'Username must be 3-24 chars (letters, numbers, _)' });
    if (!displayName || displayName.length < 1 || displayName.length > 60) return res.status(400).json({ error: 'Display name required (1-60 chars)' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!isValidPin(pin)) return res.status(400).json({ error: 'PIN must be 4 digits' });

    const db = await fetchDatabase();
    const emailLower = email.toLowerCase();
    const usernameLower = username.toLowerCase();

    if (db.users.some(u => u.email.toLowerCase() === emailLower)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    if (db.users.some(u => u.username.toLowerCase() === usernameLower)) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const pinHash = await bcrypt.hash(pin, 10);

    const newUser = {
      id: uid('usr'),
      email,
      username,
      displayName,
      bio: '',
      photoUrl: '',
      passwordHash,
      pinHash,
      createdAt: nowMs(),
    };
    db.users.push(newUser);
    const persisted = await saveDatabase(db, false);
    if (isPersistConfigured() && !persisted) {
      // Roll back the in-memory addition to keep state consistent
      const idx = db.users.findIndex(u => u.id === newUser.id);
      if (idx !== -1) db.users.splice(idx, 1);
      console.error('[signup] persistence failed for', newUser.username);
      return res.status(503).json({ error: 'Storage temporarily unavailable. Please try again in a moment.' });
    }

    const token = signToken(newUser);
    return res.json({ token, user: sanitizeUser(newUser) });
  } catch (e) {
    console.error('[signup] exception', e);
    return res.status(500).json({ error: 'Signup failed: ' + (e.message || 'unknown') });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ error: 'Missing credentials' });
    const db = await fetchDatabase();
    const idLower = String(identifier).toLowerCase();
    const user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signToken(user);
    return res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/reset-by-pin', async (req, res) => {
  try {
    const { identifier, pin, newPassword } = req.body || {};
    if (!identifier || !isValidPin(pin) || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Invalid reset payload' });
    }
    const db = await fetchDatabase();
    const idLower = String(identifier).toLowerCase();
    const user = db.users.find(u => u.email.toLowerCase() === idLower || u.username.toLowerCase() === idLower);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const pinOk = await bcrypt.compare(pin, user.pinHash);
    if (!pinOk) return res.status(401).json({ error: 'Incorrect PIN' });
    const oldHash = user.passwordHash;
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    const persisted = await saveDatabase(db, false);
    if (isPersistConfigured() && !persisted) {
      user.passwordHash = oldHash; // roll back
      console.error('[reset] persistence failed for', user.username);
      return res.status(503).json({ error: 'Storage temporarily unavailable. Please try again in a moment.' });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[reset] exception', e);
    return res.status(500).json({ error: 'Reset failed: ' + (e.message || 'unknown') });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === req.userId);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ user: sanitizeUser(u) });
});

// ---------- User Routes ----------
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
    if (typeof displayName === 'string' && displayName.length >= 1 && displayName.length <= 60) {
      user.displayName = displayName;
    }
    if (typeof bio === 'string' && bio.length <= 280) {
      user.bio = bio;
    }
    if (typeof photoUrl === 'string' && photoUrl.length <= 2048) {
      user.photoUrl = photoUrl;
    }
    await saveDatabase(db, false);
    res.json({ user: sanitizeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const now = nowMs();
  const list = db.users.map(u => {
    const hb = db.heartbeat[u.id] || 0;
    return {
      ...sanitizeUser(u),
      online: now - hb < 45000, // <45s = online
      lastSeen: hb,
    };
  });
  res.json({ users: list });
});

app.post('/api/user/heartbeat', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  db.heartbeat[req.userId] = nowMs();
  await saveDatabase(db, true); // ephemeral
  res.json({ ok: true });
});

app.post('/api/user/typing', authMiddleware, async (req, res) => {
  const { roomId } = req.body || {};
  if (!roomId) return res.status(400).json({ error: 'roomId required' });
  const db = await fetchDatabase();
  if (!db.typing[roomId]) db.typing[roomId] = {};
  db.typing[roomId][req.userId] = nowMs();
  await saveDatabase(db, true);
  res.json({ ok: true });
});

app.get('/api/user/typing', authMiddleware, async (req, res) => {
  const { roomId } = req.query;
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
  if (!roomId) return 'general-group';
  if (roomId === 'general-group' || roomId.startsWith('group:')) return roomId;
  if (roomId.startsWith('dm:')) {
    // dm:userA:userB -> sort
    const parts = roomId.slice(3).split(':');
    if (parts.length === 2) {
      const sorted = [...parts].sort();
      return 'dm:' + sorted.join(':');
    }
  }
  return roomId;
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
  const list = db.messages
    .filter(m => m.roomId === roomId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-200);
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
    const { roomId: rawRoom, text, imageUrl, replyTo, targetUserId } = req.body || {};
    let roomId = rawRoom;
    if (!roomId && targetUserId) {
      roomId = dmRoomFor(req.userId, targetUserId);
    }
    roomId = normalizeRoomId(roomId || 'general-group', req.userId);
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split(':');
      if (!parts.includes(req.userId)) return res.status(403).json({ error: 'Forbidden' });
    }
    const cleanText = typeof text === 'string' ? text.slice(0, 4000) : '';
    const cleanImage = typeof imageUrl === 'string' && imageUrl.length <= 4096 ? imageUrl : null;
    if (!cleanText && !cleanImage) return res.status(400).json({ error: 'Empty message' });
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
    db.messages.push(msg);
    await saveDatabase(db, false);
    res.json({ message: { ...msg, author: snapshot || { id: req.userId, displayName: 'Member', username: 'member' } } });
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
    const idx = db.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (db.messages[idx].userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    db.messages.splice(idx, 1);
    await saveDatabase(db, false);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Delete failed' });
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
    const cleanText = typeof text === 'string' ? text.slice(0, 4000) : '';
    const cleanImage = typeof imageUrl === 'string' && imageUrl.length <= 4096 ? imageUrl : null;
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
        imageUrl: typeof replyTo.imageUrl === 'string' ? replyTo.imageUrl.slice(0, 2048) : null,
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

// ---------- Social Feed / Posts ----------
app.get('/api/posts', authMiddleware, async (req, res) => {
  const db = await fetchDatabase();
  const list = db.posts
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(p => {
      const author = db.users.find(u => u.id === p.userId);
      const comments = (p.comments || []).map(c => {
        const cu = db.users.find(u => u.id === c.userId);
        const cAuth = cu ? sanitizeUser(cu) : (c.authorSnapshot || { id: c.userId, displayName: 'Member', username: (c.userId || 'm').slice(-6) });
        return { ...c, author: cAuth };
      });
      const pAuth = author ? sanitizeUser(author) : (p.authorSnapshot || { id: p.userId, displayName: 'Member', username: (p.userId || 'm').slice(-6) });
      return {
        ...p,
        likes: p.likes || [],
        likeCount: (p.likes || []).length,
        comments,
        commentCount: comments.length,
        author: pAuth
      };
    });
  res.json({ posts: list });
});

app.post('/api/posts/create', authMiddleware, async (req, res) => {
  try {
    const { text, imageUrl } = req.body || {};
    const cleanText = typeof text === 'string' ? text.slice(0, 2000) : '';
    const cleanImage = typeof imageUrl === 'string' && imageUrl.length <= 4096 ? imageUrl : null;
    if (!cleanText && !cleanImage) return res.status(400).json({ error: 'Empty post' });
    const db = await fetchDatabase();
    const author = db.users.find(u => u.id === req.userId);
    const snapshot = author ? {
      id: author.id, username: author.username, displayName: author.displayName, photoUrl: author.photoUrl || ''
    } : null;
    const post = {
      id: uid('post'),
      userId: req.userId,
      text: cleanText,
      imageUrl: cleanImage,
      likes: [],
      comments: [],
      authorSnapshot: snapshot,
      createdAt: nowMs(),
    };
    db.posts.push(post);
    await saveDatabase(db, false);
    res.json({ post: { ...post, likeCount: 0, commentCount: 0, author: snapshot || { id: req.userId, displayName: 'Member', username: 'member' } } });
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
  await saveDatabase(db, false);
  res.json({ liked, likeCount: post.likes.length });
});

app.post('/api/posts/comment', authMiddleware, async (req, res) => {
  const { postId, text } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const cleanText = typeof text === 'string' ? text.slice(0, 600).trim() : '';
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
  await saveDatabase(db, false);
  res.json({ comment: { ...comment, author: snapshot || { id: req.userId, displayName: 'Member', username: 'member' } } });
});

app.post('/api/posts/delete', authMiddleware, async (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const db = await fetchDatabase();
  const idx = db.posts.findIndex(p => p.id === postId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (db.posts[idx].userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  db.posts.splice(idx, 1);
  await saveDatabase(db, false);
  res.json({ ok: true });
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
