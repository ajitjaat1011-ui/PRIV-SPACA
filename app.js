/**
 * PRIV SPACA — Frontend Application (Instagram-grade)
 * Vanilla JS, modular, JWT in localStorage, fetch() to /api.
 */
(() => {
'use strict';

// ====== State ======
function safeLocalGet(key, fallback = null) {
  try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
}
function safeJsonParse(raw, fallback = null) {
  try { return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
}

const State = {
  token: safeLocalGet('ps_token', null),
  user: safeJsonParse(safeLocalGet('ps_user', null), null),
  currentTab: 'feed',
  currentRoom: { id: 'general-group', kind: 'group', label: '#general-group', target: null },
  members: [],
  messages: [],
  posts: [],
  scheduled: [],
  typingUsers: [],
  closeFriends: safeJsonParse(safeLocalGet('ps_closeFriends', '[]'), []),
  replyTo: null,
  attach: null,
  postAttach: null,
  pollTimers: {},
  rtcLastSignalAt: Math.max(Number(safeLocalGet('ps_rtcLastSignalAt', 0) || 0), Date.now() - 5000),
};

// ====== Self-heal config ======
// This version must match SW_VERSION in sw.js. If it doesn't, the page is
// running stale code and needs to heal.
const APP_VERSION = 'priv-spaca-v77-bugfix';
const HEAL_MAX_ATTEMPTS = 2;
const HEAL_PROBE_TIMEOUT_MS = 4000;
const HEAL_STORAGE_PREFIXES = ['ps_', 'priv-spaca'];

const API_BASE = '/api';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ====== API helper ======
function authHeaders() {
  return State.token ? { 'Authorization': 'Bearer ' + State.token } : {};
}
// Tiny GET cache (5s TTL) + in-flight de-duplication so notification poller
// and view loaders don't double-fetch the same endpoint within the same tick.
const _apiCache = new Map();      // key -> { ts, data }
const _apiInflight = new Map();   // key -> Promise
const API_CACHE_TTL_MS = 5000;
let startupFallback = null;

async function api(path, options = {}) {
  const opts = Object.assign({ method: 'GET', headers: {} }, options);
  opts.headers = Object.assign({}, opts.headers, authHeaders());
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const isGet = (opts.method || 'GET').toUpperCase() === 'GET';
  // High-frequency realtime polling endpoints must never use the general GET
  // cache. In particular, caching /rtc/signals makes call pickup/ICE candidate
  // delivery lag by up to API_CACHE_TTL_MS and can break WebRTC negotiation.
  let cacheKey = isGet ? path : null;
  if (cacheKey && cacheKey.startsWith('/rtc/signals')) cacheKey = null;
  if (cacheKey) {
    const cached = _apiCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < API_CACHE_TTL_MS) return cached.data;
    if (_apiInflight.has(cacheKey)) return _apiInflight.get(cacheKey);
  }
  const fetchPromise = (async () => {
    let res;
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let timeoutId = null;
    if (controller) {
      opts.signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
    }
    try { res = await fetch(API_BASE + path, opts); }
    catch (e) { throw new Error(e && e.name === 'AbortError' ? 'Network timeout' : 'Network error'); }
    finally { if (timeoutId) clearTimeout(timeoutId); }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      if (res.status === 401 && State.token && !path.startsWith('/auth/')) {
        logout(true);
      }
      const msg = (data && data.error) || ('Request failed (' + res.status + ')');
      const err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    if (cacheKey) _apiCache.set(cacheKey, { ts: Date.now(), data });
    // Bust GET cache when a mutation happens for related endpoints
    if (!isGet) {
      _apiCache.delete('/notifications');
      if (path.startsWith('/messages')) {
        for (const k of [..._apiCache.keys()]) if (k.startsWith('/messages')) _apiCache.delete(k);
      } else if (path.startsWith('/posts')) {
        for (const k of [..._apiCache.keys()]) if (k.startsWith('/posts') || k.startsWith('/feed')) _apiCache.delete(k);
      } else if (path.startsWith('/user')) {
        _apiCache.delete('/users'); _apiCache.delete('/auth/me');
        // Follow/unfollow changes the feed — bust it
        if (path.includes('/follow') || path.includes('/unfollow')) _apiCache.delete('/feed');
      }
    }
    return data;
  })();
  if (cacheKey) {
    _apiInflight.set(cacheKey, fetchPromise);
    fetchPromise.finally(() => _apiInflight.delete(cacheKey));
  }
  return fetchPromise;
}

// ====== Utilities ======
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initialsOf(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorOf(seed) {
  if (!seed) return '#00a2ff';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 60 + (h % 20);
  return `hsl(${hue}, ${sat}%, 55%)`;
}

/**
 * Per-user pastel bubble tint (background, text, author-name color).
 * Deterministic from userId hash → same user always gets same color.
 */
function bubbleTintFor(seed) {
  if (!seed) return { bg: '#eef3f7', fg: '#1a2733', author: '#3a4d5c' };
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    bg:     `hsl(${hue}, 78%, 95%)`,   // soft pastel
    fg:     `hsl(${hue}, 40%, 18%)`,   // dark readable text
    author: `hsl(${hue}, 60%, 38%)`,   // medium-dark for author line
  };
}

function isPrivOwner(user) {
  if (!user) return false;
  const username = String(user.username || '').toLowerCase();
  const email = String(user.email || '').toLowerCase();
  const id = String(user.id || '');
  return id === 'usr_mr1p9tls_xj3xdw1'
    || username === 'arvind_1011'
    || username === 'arvindjaat1011'
    || email === 'ajitjaat1011@gmail.com'
    || email === 'arvindjaat1011@gmail.com';
}

// Blue tick: owner OR users who redeem VIP key
function isVerifiedUser(user) {
  return !!(user && (user.verified || isPrivOwner(user)));
}

function ownerVerifiedBadgeSvg(extraClass = '') {
  const n = (ownerVerifiedBadgeSvg._n = (ownerVerifiedBadgeSvg._n || 0) + 1);
  const g = `blueTickGrad${n}`;
  return `
    <svg class="owner-verified-badge ${extraClass}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="${g}" x1="5" y1="4" x2="27" y2="28">
          <stop offset="0" stop-color="#5bd6ff"/>
          <stop offset="0.42" stop-color="#159cff"/>
          <stop offset="1" stop-color="#0068e8"/>
        </linearGradient>
      </defs>
      <path class="bt-shape" d="M16 1.9 19.1 4.4 23.1 4.2 24.8 7.9 28.5 9.6 28.2 13.6 30.7 16.7 28.2 19.8 28.5 23.8 24.8 25.5 23.1 29.2 19.1 29 16 31.5 12.9 29 8.9 29.2 7.2 25.5 3.5 23.8 3.8 19.8 1.3 16.7 3.8 13.6 3.5 9.6 7.2 7.9 8.9 4.2 12.9 4.4 16 1.9Z" fill="url(#${g})"/>
      <path class="bt-gloss" d="M8 10.8C10.8 5.8 18.8 4.4 24 8.9C18.3 7.3 12.5 8.4 8.5 13.8Z" fill="#fff" opacity=".32"/>
      <path class="bt-check" d="M9.5 16.7 13.8 20.8 22.9 11.6" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function ownerBadgeHtml(user, extraClass = 'inline') {
  return isVerifiedUser(user) ? ownerVerifiedBadgeSvg(extraClass) : '';
}

function displayNameWithOwnerBadge(user, fallback = '', extraClass = 'inline') {
  const label = fallback || (user && (user.displayName || user.username)) || 'Member';
  return `${escapeHtml(label)}${ownerBadgeHtml(user, extraClass)}`;
}

// In-memory cache of broken photo URLs (so we don't keep retrying within the session)
const _brokenPhotoUrls = new Set();
try {
  const saved = JSON.parse(sessionStorage.getItem('ps_brokenPhotos') || '[]');
  saved.forEach(u => _brokenPhotoUrls.add(u));
} catch (_) {}

function _markPhotoBroken(url) {
  if (!url) return;
  _brokenPhotoUrls.add(url);
  try { sessionStorage.setItem('ps_brokenPhotos', JSON.stringify([..._brokenPhotoUrls].slice(-100))); } catch (_) {}
}

function _applyInitials(el, user) {
  const seed = user ? (user.username || user.displayName || user.id || '?') : '?';
  const c1 = colorOf(seed);
  const c2 = colorOf(seed + 'x');
  el.style.backgroundImage = '';
  el.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  el.textContent = initialsOf(user ? (user.displayName || user.username) : '?');
}

function renderAvatar(el, user, opts = {}) {
  if (!el) return;
  el.textContent = '';
  el.style.backgroundImage = '';
  el.style.background = '';
  el.classList.toggle('with-status', !!opts.showStatus);
  el.classList.toggle('online', !!opts.online);
  el.classList.toggle('owner-ring', isPrivOwner(user));
  const url = user && user.photoUrl;
  if (url && !_brokenPhotoUrls.has(url)) {
    // Probe load asynchronously; if it fails, swap to initials
    el.style.backgroundImage = `url("${String(url).replace(/"/g, '%22')}")`;
    const probe = new Image();
    probe.onerror = () => {
      _markPhotoBroken(url);
      _applyInitials(el, user);
    };
    probe.src = url;
  } else {
    _applyInitials(el, user);
  }
}

function timeFmt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.toDateString();
}
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.classList.remove('hidden');
  // Motion One pop animation
  if (window.Motion && window.Motion.animate) {
    try {
      window.Motion.animate(t,
        { opacity: [0, 1], transform: ['translate(-50%, 14px) scale(.94)', 'translate(-50%, 0) scale(1)'] },
        { duration: 0.32, easing: [0.34, 1.4, 0.64, 1] }
      );
    } catch (_) {}
  }
  void t.offsetWidth;
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => {
    if (window.Motion && window.Motion.animate) {
      try {
        window.Motion.animate(t,
          { opacity: [1, 0], transform: ['translate(-50%, 0) scale(1)', 'translate(-50%, 8px) scale(.96)'] },
          { duration: 0.22, easing: 'ease-in' }
        ).finished.then(() => t.classList.add('hidden')).catch(() => t.classList.add('hidden'));
      } catch (_) { t.classList.add('hidden'); }
    } else {
      t.classList.add('hidden');
    }
  }, 3200);
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try { window.lucide.createIcons(); } catch (_) {}
  }
}

/* ====== Motion One animation helpers ====== */
// Motion One exposes a global `Motion` object (UMD build). Falls back silently to CSS if unavailable.
const M = (window.Motion && (window.Motion.animate || (window.Motion.default && window.Motion.default.animate)))
  ? window.Motion
  : null;
const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function motionAnimate(el, keyframes, opts) {
  if (!el || prefersReducedMotion) return;
  if (!M) return; // graceful fallback to CSS animations
  try {
    const animate = M.animate;
    return animate(el, keyframes, opts);
  } catch (_) { /* swallow */ }
}

function springIn(el, opts = {}) {
  motionAnimate(el,
    { opacity: [0, 1], transform: ['translateY(8px) scale(.96)', 'translateY(0) scale(1)'] },
    Object.assign({ duration: 0.32, easing: [0.2, 0.8, 0.2, 1] }, opts)
  );
}

function popIn(el, opts = {}) {
  motionAnimate(el,
    { transform: ['scale(.5)', 'scale(1.12)', 'scale(1)'], opacity: [0, 1, 1] },
    Object.assign({ duration: 0.36, easing: [0.34, 1.56, 0.64, 1] }, opts)
  );
}

function slideUp(el, opts = {}) {
  motionAnimate(el,
    { opacity: [0, 1], transform: ['translateY(28px)', 'translateY(0)'] },
    Object.assign({ duration: 0.34, easing: [0.2, 0.85, 0.15, 1] }, opts)
  );
}

function staggerIn(els, opts = {}) {
  if (!els || !els.length) return;
  els.forEach((el, i) => springIn(el, { delay: (opts.delayPer || 0.04) * i }));
}

function pulseEl(el, opts = {}) {
  motionAnimate(el,
    { transform: ['scale(1)', 'scale(1.18)', 'scale(1)'] },
    Object.assign({ duration: 0.5, easing: 'ease-out' }, opts)
  );
}

// Resolve any author-like object into a renderable display object (no "Unknown")
function resolveAuthor(rawAuthor, fallbackUserId, authorSnapshot) {
  if (rawAuthor && rawAuthor.username && rawAuthor.username !== 'unknown' && !String(rawAuthor.username).startsWith('member_')) return rawAuthor;
  // Try members directory
  if (fallbackUserId) {
    const m = State.members.find(u => u.id === fallbackUserId);
    if (m) return m;
  }
  // Embedded snapshot from server (posts/messages/comments all carry
  // authorSnapshot as their durable author record — /api/feed's raw Turso
  // rows in particular only set authorSnapshot, not author, so this must be
  // checked before falling back to a synthetic "member_xxx" label).
  if (authorSnapshot && (authorSnapshot.username || authorSnapshot.displayName)) return authorSnapshot;
  if (rawAuthor && rawAuthor.username && rawAuthor.username !== 'unknown') return rawAuthor;
  // Embedded snapshot from server
  if (rawAuthor && (rawAuthor.displayName || rawAuthor.id)) return rawAuthor;
  // Synthetic fallback — derive short id label
  const id = fallbackUserId || (rawAuthor && rawAuthor.id) || 'member';
  const short = String(id).slice(-6);
  return { id, displayName: 'Member ' + short, username: 'member_' + short, photoUrl: '' };
}

// ====== Image upload (durable fallback only — tmpfiles.org removed) ======
// tmpfiles.org used to be tried here as a "fallback" when the durable
// /api/upload-photo (GitHub-backed CDN) path failed. That's backwards:
// tmpfiles.org links expire/get pruned (confirmed live — multiple posts'
// images returned 404 within days), so using it as a fallback quietly
// trades a transient upload failure for a guaranteed-to-break-later image.
// This now always produces a durable result: it persists the image as a
// data URL via the same /api/upload-photo endpoint the primary path uses
// (which commits it to the GitHub media CDN), so there is no unreliable
// third-party host in the chain at all anymore.
async function uploadImage(file, onProgress) {
  if (!file) throw new Error('No file');
  if (file.size > 15 * 1024 * 1024) throw new Error('File too large (max 15MB)');
  if (onProgress) onProgress(10);
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Read failed'));
    r.readAsDataURL(file);
  });
  if (onProgress) onProgress(50);
  try {
    const res = await api('/upload-photo', { method: 'POST', body: { dataUrl, kind: 'media' } });
    if (onProgress) onProgress(100);
    return { url: res.url || dataUrl, name: file.name, size: file.size, persisted: res.persisted !== false };
  } catch (e) {
    // Last resort: inline data URL only (works everywhere, but bloats the
    // DB record and won't persist across a full post-storage rewrite). Only
    // reached if /api/upload-photo itself is unreachable/erroring, and only
    // for small files so we don't balloon storage with large inline blobs.
    if (file.size > 800 * 1024) throw new Error('Image upload service unavailable. Please use a smaller image (<800KB) or try again later.');
    if (onProgress) onProgress(100);
    return { url: dataUrl, name: file.name, size: file.size, persisted: false };
  }
}

// ====== Splash / Shells ======
function hideSplash() {
  const s = $('#splash');
  if (!s) return;
  s.classList.add('fade-out');
  setTimeout(() => s.classList.add('hidden'), 320);
}

function showAuth() {
  if (typeof startupFallback !== 'undefined') try { clearTimeout(startupFallback); } catch (_) {}
  $('#authShell').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
  hideSplash();
  refreshIcons();
}

function showApp() {
  if (typeof startupFallback !== 'undefined') try { clearTimeout(startupFallback); } catch (_) {}
  $('#authShell').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  hideSplash();
  refreshIcons();
  hydrateMeChips();
  switchTab('feed');
  startPolls();
  loadAll();
  loadCloseFriends().catch(() => {});
  // Part 3: publish E2E public key so peers can DM us with Secret Chat
  if (window.crypto && crypto.subtle && window.indexedDB) {
    setTimeout(() => { E2E.publishPublicKey().catch(() => {}); }, 800);
  }
}

function hydrateMeChips() {
  if (!State.user) return;
  if ($('#feedMeName')) $('#feedMeName').textContent = (State.user.displayName || State.user.username).toUpperCase();
  if ($('#feedMeAvatar')) renderAvatar($('#feedMeAvatar'), State.user);
  if ($('#profileAvatarPreview')) renderAvatar($('#profileAvatarPreview'), State.user);
  const profileTitle = $('#profileTitleUsername');
  if (profileTitle) profileTitle.innerHTML = `${escapeHtml(State.user.username || State.user.displayName || 'me')}${ownerBadgeHtml(State.user, 'title')}`;
  const profileUserLine = $('#profileUsername');
  if (profileUserLine) profileUserLine.innerHTML = displayNameWithOwnerBadge(State.user, '@' + (State.user.username || State.user.displayName || 'me'), 'inline');
  // Bottom-nav avatar (uses the same broken-URL detection as renderAvatar)
  const bn = $('#bnMeAvatar');
  if (bn) {
    bn.textContent = '';
    bn.style.backgroundImage = '';
    bn.style.backgroundColor = '';
    const url = State.user.photoUrl;
    if (url && !_brokenPhotoUrls.has(url)) {
      bn.style.backgroundImage = `url("${String(url).replace(/"/g, '%22')}")`;
      const probe = new Image();
      probe.onerror = () => {
        _markPhotoBroken(url);
        const seed = State.user.username || State.user.displayName || State.user.id || '?';
        bn.style.backgroundImage = '';
        bn.style.backgroundColor = colorOf(seed);
        bn.textContent = initialsOf(State.user.displayName || State.user.username);
      };
      probe.src = url;
    } else {
      const seed = State.user.username || State.user.displayName || State.user.id || '?';
      bn.style.backgroundColor = colorOf(seed);
      bn.textContent = initialsOf(State.user.displayName || State.user.username);
    }
  }
  const pf = $('#profileForm');
  if (pf) {
    const dn = pf.querySelector('[name="displayName"]');
    const un = pf.querySelector('[name="username"]');
    const bio = pf.querySelector('[name="bio"]');
    if (dn) dn.value = State.user.displayName || '';
    if (un) un.value = State.user.username || '';
    if (bio) bio.value = State.user.bio || '';
  }
}

function logout(silent) {
  Object.values(State.pollTimers).forEach(t => clearInterval(t));
  State.pollTimers = {};
  if (typeof disconnectSSE === 'function') disconnectSSE();
  State.token = null;
  State.user = null;
  State.messages = [];
  State.members = [];
  State.posts = [];
  State.closeFriends = [];
  _previousMessageIds = new Set();
  _previousPostIds = new Set();
  _storiesRendered = false;
  try { localStorage.removeItem('ps_token'); } catch (_) {}
  try { localStorage.removeItem('ps_user'); } catch (_) {}
  try { localStorage.removeItem('ps_closeFriends'); } catch (_) {}
  showAuth();
  if (!silent) toast('Signed out');
}

// ====== PIN segmented input ======
function bindPinGroup(group) {
  const cells = $$('input[data-pin-cell]', group);
  const hidden = group.parentElement.querySelector('input[type=hidden][name=pin]');
  function sync() {
    const v = cells.map(c => c.value).join('');
    if (hidden) hidden.value = v;
    cells.forEach(c => c.classList.toggle('filled', !!c.value));
  }
  cells.forEach((c, i) => {
    c.addEventListener('input', (e) => {
      // Only digits
      c.value = c.value.replace(/\D/g, '').slice(0, 1);
      sync();
      if (c.value && cells[i + 1]) cells[i + 1].focus();
    });
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !c.value && cells[i - 1]) {
        cells[i - 1].focus();
        cells[i - 1].value = '';
        sync();
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' && cells[i - 1]) {
        cells[i - 1].focus(); e.preventDefault();
      } else if (e.key === 'ArrowRight' && cells[i + 1]) {
        cells[i + 1].focus(); e.preventDefault();
      }
    });
    c.addEventListener('paste', (e) => {
      const txt = (e.clipboardData || window.clipboardData).getData('text');
      const digits = (txt || '').replace(/\D/g, '').slice(0, 4);
      if (!digits) return;
      e.preventDefault();
      cells.forEach((cc, idx) => { cc.value = digits[idx] || ''; });
      sync();
      const next = cells[Math.min(digits.length, 3)];
      if (next) next.focus();
    });
  });
}

function clearPin(group) {
  $$('input[data-pin-cell]', group).forEach(c => { c.value = ''; c.classList.remove('filled'); });
  const h = group.parentElement.querySelector('input[type=hidden][name=pin]');
  if (h) h.value = '';
}

// ====== Auth Forms ======
function bindAuth() {
  $$('.pin-input').forEach(g => bindPinGroup(g));

  // Terms modal open/close
  const openTermsBtn = $('#openTermsBtn');
  if (openTermsBtn) openTermsBtn.addEventListener('click', () => {
    const m = $('#termsModal');
    m.classList.remove('hidden');
    const card = m.querySelector('.modal-card');
    if (card) springIn(card, { duration: 0.28 });
    refreshIcons();
  });
  $$('[data-close-terms]').forEach(b => b.addEventListener('click', () => {
    $('#termsModal').classList.add('hidden');
  }));
  const tm = $('#termsModal');
  if (tm) tm.addEventListener('click', (e) => { if (e.target === tm) tm.classList.add('hidden'); });

  // New auth flow (Instagram-style):
  //  - Default = sign-in panel, with the form + 'Forgotten password?' link inside
  //  - Bottom 'Create new account' button + 'Forgotten password?' link swap panels
  //  - Sign up / Reset panels have their own back arrow
  //  - Top back arrow reveals the splash/landing
  const authPanels = document.querySelectorAll('[data-auth-panel]');
  const authBottom = $('[data-auth-secondary]'); // .auth-bottom with 'Create new account'
  function showAuthPanel(name) {
    authPanels.forEach(p => p.hidden = (p.dataset.authPanel !== name));
    // The bottom 'Create new account' CTA only shows on the sign-in panel
    if (authBottom) authBottom.hidden = (name !== 'login');
    // Focus the first input of the active panel
    const active = document.querySelector('[data-auth-panel="' + name + '"]');
    if (active) {
      const firstInput = active.querySelector('input:not([type=hidden])');
      if (firstInput) setTimeout(() => firstInput.focus(), 50);
    }
    $$('.auth-error').forEach(el => el.textContent = '');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
  }
  // Any [data-auth-step] button (bottom 'Create new account', 'Forgotten password?' link) swaps panels
  document.querySelectorAll('[data-auth-step]').forEach(btn => {
    btn.addEventListener('click', () => showAuthPanel(btn.dataset.authStep));
  });
  // In-panel back arrows (in sign-up / reset panels) return to sign-in
  document.querySelectorAll('[data-auth-back]').forEach(btn => {
    btn.addEventListener('click', () => showAuthPanel('login'));
  });
  // Top back arrow: hide the auth and reveal the splash/landing
  const topBack = $('#authTopBack');
  if (topBack) {
    topBack.addEventListener('click', () => {
      const splash = $('#splash');
      const auth = $('#authShell');
      const app = $('#appShell');
      if (auth) auth.classList.add('hidden');
      if (app) app.classList.add('hidden');
      if (splash) splash.classList.remove('hidden');
    });
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = e.target.querySelector('[data-error]');
    errEl.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…';
    try {
      const data = await api('/auth/login', { method: 'POST', body: {
        identifier: String(fd.get('identifier') || '').trim(),
        password: String(fd.get('password') || ''),
      }});
      acceptSession(data);
    } catch (err) { errEl.textContent = err.message || 'Login failed'; }
    finally { btn.disabled = false; btn.innerHTML = orig; }
  });

  $('#signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = e.target.querySelector('[data-error]');
    errEl.textContent = '';
    const pin = String(fd.get('pin') || '');
    if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'Enter your 4-digit PIN'; return; }

    // ---- Terms & Conditions check (defaults checked, must be checked to proceed) ----
    const termsBox = $('#termsCheckbox');
    const termsRow = e.target.querySelector('.terms-row');
    if (termsBox && !termsBox.checked) {
      errEl.textContent = "You must accept the Terms & Community Guidelines to create an account.";
      if (termsRow) {
        termsRow.classList.add('invalid');
        pulseEl(termsRow);
        setTimeout(() => termsRow.classList.remove('invalid'), 2000);
      }
      return;
    }

    const btn = e.target.querySelector('button[type=submit]');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creating…';
    try {
      const data = await api('/auth/signup', { method: 'POST', body: {
        email: String(fd.get('email') || '').trim(),
        username: String(fd.get('username') || '').trim(),
        displayName: String(fd.get('displayName') || '').trim(),
        password: String(fd.get('password') || ''),
        pin,
        termsAccepted: true,
        termsVersion: '1.0',
      }});
      acceptSession(data);
    } catch (err) { errEl.textContent = err.message || 'Signup failed'; }
    finally { btn.disabled = false; btn.innerHTML = orig; }
  });

  $('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = e.target.querySelector('[data-error]');
    errEl.textContent = '';
    errEl.style.color = '';
    const pin = String(fd.get('pin') || '');
    if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'Enter your 4-digit PIN'; return; }
    const btn = e.target.querySelector('button[type=submit]');
    const orig = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Resetting…';
    try {
      const data = await api('/auth/reset-by-pin', { method: 'POST', body: {
        identifier: String(fd.get('identifier') || '').trim(),
        pin,
        newPassword: String(fd.get('newPassword') || ''),
      }});
      if (data && data.token && data.user) {
        acceptSession(data);
      } else {
        errEl.style.color = 'var(--green)';
        errEl.textContent = 'Password reset! Please sign in.';
        setTimeout(() => {
          errEl.style.color = ''; errEl.textContent = '';
          // default to options list — user picks login/signup/reset themselves
  showAuthPanel('login');
          $('#loginForm input[name=identifier]').value = String(fd.get('identifier') || '').trim();
          $('#loginForm input[name=password]').focus();
        }, 900);
      }
    } catch (err) { errEl.textContent = err.message || 'Reset failed'; }
    finally { btn.disabled = false; btn.innerHTML = orig; }
  });
}

function acceptSession(data) {
  State.token = data.token;
  State.user = data.user;
  try { localStorage.setItem('ps_token', State.token); } catch (_) {}
  try { localStorage.setItem('ps_user', JSON.stringify(State.user)); } catch (_) {}
  // Clear PIN fields
  $$('.pin-input').forEach(clearPin);
  showApp();
  toast('Welcome, ' + (State.user.displayName || State.user.username) + '!', 'success');
}


// ====== Tabs ======
// ====== New-post composer (top "+" button) ======
// Reuses the inline composer card already built into the feed view.
function openPostComposer() {
  switchTab('feed');
  const card = $('#inlineComposerCard');
  if (card) {
    card.classList.remove('hidden');
    const ta = $('#postInput');
    if (ta) setTimeout(() => ta.focus(), 50);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  refreshIcons();
}
function closePostComposer() {
  const card = $('#inlineComposerCard');
  if (card) card.classList.add('hidden');
  const inp = $('#postInput');
  if (inp) inp.value = '';
  _postDraftMusic = null; updatePostMusicUI();
  const picker = $('#postSongPicker'); if (picker) picker.classList.add('hidden');
  const chk = $('#postScratchCheckbox');
  if (chk) chk.checked = false;
  if (typeof clearPostAttach === 'function') clearPostAttach();
  const pm = $('#postComposerModal');
  if (pm) pm.classList.add('hidden');
}

const _scrollMemory = {
  feed: 0,
  search: 0,
  profile: 0,
  roomsPane: 0,
  membersList: 0,
  messagesScroll: 0,
};
function bindScrollMemory() {
  const watch = [
    ['feed', '#feedView'],
    ['search', '#searchView'],
    ['profile', '#profileView'],
    ['roomsPane', '.rooms-pane'],
    ['membersList', '#membersList'],
    ['messagesScroll', '#messagesScroll'],
  ];
  watch.forEach(([key, sel]) => {
    const el = $(sel);
    if (!el || el.dataset.scrollBound === '1') return;
    el.dataset.scrollBound = '1';
    let ticking = false;
    el.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        _scrollMemory[key] = el.scrollTop || 0;
        ticking = false;
      });
    }, { passive: true });
  });
}
function rememberCurrentScroll() {
  const map = [
    ['feed', '#feedView'],
    ['search', '#searchView'],
    ['profile', '#profileView'],
    ['roomsPane', '.rooms-pane'],
    ['membersList', '#membersList'],
    ['messagesScroll', '#messagesScroll'],
  ];
  map.forEach(([key, sel]) => {
    const el = $(sel);
    if (el) _scrollMemory[key] = el.scrollTop || 0;
  });
}
function restoreScrollForTab(tab) {
  requestAnimationFrame(() => {
    if (tab === 'feed') { const el = $('#feedView'); if (el) el.scrollTop = _scrollMemory.feed || 0; }
    if (tab === 'search') { const el = $('#searchView'); if (el) el.scrollTop = _scrollMemory.search || 0; }
    if (tab === 'profile') { const el = $('#profileView'); if (el) el.scrollTop = _scrollMemory.profile || 0; }
  if (tab === 'chat' || tab === 'groups') {
      const rooms = $('.rooms-pane'); if (rooms) rooms.scrollTop = _scrollMemory.roomsPane || 0;
      const members = $('#membersList'); if (members) members.scrollTop = _scrollMemory.membersList || 0;
      const msgs = $('#messagesScroll'); if (msgs && !$('#chatView').classList.contains('show-rooms')) msgs.scrollTop = _scrollMemory.messagesScroll || 0;
    }
  });
}

function bindTabs() {
  $$('.bn-btn[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  const bw = $('#brandWordmarkBtn') || $('#brandWordmark');
  if (bw) bw.addEventListener('click', () => {
    switchTab('feed');
    const fv = $('#feedView');
    if (fv) fv.scrollTo({ top: 0, behavior: 'smooth' });
    _scrollMemory.feed = 0;
    lastPostsSignature = null;
    loadPosts(true);
  });
  // Legacy top-chat button is gone; keep guard in case markup is cached
  const tc = $('#topChatBtn');
  if (tc) tc.addEventListener('click', () => switchTab('chat'));
  const tn = $('#topNotifBtn');
  if (tn) tn.addEventListener('click', openNotifications);
  // New IG-style top "+" — jump to feed, focus composer, open photo picker
  const ta = $('#topAddBtn');
  if (ta) ta.addEventListener('click', openPostComposer);
  const fa = $('#floatingAddBtn');
  if (fa) fa.addEventListener('click', openPostComposer);
  const icb = $('#inlineComposerCloseBtn');
  if (icb) icb.addEventListener('click', closePostComposer);
  const icab = $('#inlineComposerCancelBtn');
  if (icab) icab.addEventListener('click', closePostComposer);
  const pmc = $('#postModalClose');
  if (pmc) pmc.addEventListener('click', closePostComposer);
  const pm = $('#postComposerModal');
  if (pm) pm.addEventListener('click', (e) => { if (e.target === pm) closePostComposer(); });
}

let _searchFocusReleaseTimer = null;
function shouldAutoFocusSearch() {
  try {
    return window.innerWidth > 820 && window.matchMedia && window.matchMedia('(pointer:fine)').matches;
  } catch (_) {
    return window.innerWidth > 820;
  }
}
function suppressSearchAutofillPrompt() {
  const inp = $('#searchInput');
  if (!inp) return;
  inp.readOnly = true;
  inp.setAttribute('aria-readonly', 'true');
  try { inp.blur(); } catch (_) {}
  clearTimeout(_searchFocusReleaseTimer);
  _searchFocusReleaseTimer = setTimeout(() => {
    inp.readOnly = false;
    inp.removeAttribute('aria-readonly');
  }, 650);
}

function switchTab(tab) {
  rememberCurrentScroll();
  State.currentTab = tab;
  // Stop post music when leaving the feed — the user is no longer
  // looking at any post, so silence is the expected UX.
  if (tab !== 'feed' && isPostMusicPlaying()) {
    const player = getPostMusicPlayer();
    player.pause();
    player.currentTime = 0;
    _postMusicState.postId = null;
    _postMusicState.src = '';
    _postMusicState.title = '';
    _postMusicState.artist = '';
    syncPostMusicUI();
  }
  $$('.bn-btn[data-tab]').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    if (active) popIn(b, { duration: 0.25 });
  });
  $$('.view').forEach(v => v.classList.remove('active'));
  let activeView = null;
  if (tab === 'feed') { activeView = $('#feedView'); activeView.classList.add('active'); loadMembers(); loadFeed(); markTabSeen('feed'); }
  if (tab === 'search') {
    activeView = $('#searchView');
    activeView.classList.add('active');
    loadMembers();
    renderSearch('');
    if (shouldAutoFocusSearch()) setTimeout(() => $('#searchInput').focus(), 100);
    else suppressSearchAutofillPrompt();
  }
  if (tab === 'groups') {
    activeView = $('#chatView');
    activeView.classList.add('active');
    markTabSeen('groups');
    setInboxSegment('groups');
    if (window.innerWidth <= 820) {
      // Mobile: show the channel list; let the user pick (Instagram-style).
      $('#chatView').classList.add('show-rooms');
    } else {
      // Desktop: both panes visible, so open the default channel.
      const r = $('#roomsList .room-item[data-room="general-group"]');
      if (r) r.click();
    }
  }
  if (tab === 'chat') {
    activeView = $('#chatView');
    activeView.classList.add('active');
    markTabSeen('chat');
    refreshSecretChatUI();
    setInboxSegment('primary');
    if (window.innerWidth <= 820) {
      $('#chatView').classList.add('show-rooms');
    } else if (State.currentRoom.kind !== 'dm') {
      const firstMember = $('#membersList .member-item');
      if (firstMember) firstMember.click();
    }
  }
  if (tab === 'profile') {
    activeView = $('#profileView');
    activeView.classList.add('active');
    $('#profileEditMode').classList.add('hidden');
    $('#profileViewMode').classList.remove('hidden');
    renderOwnProfile();
  }
  if (tab === 'reels') {
    // Reels are coming soon — show a friendly toast and snap back to feed
    // (the reelsView container doesn't exist; the nav button is a placeholder).
    if (typeof toast === 'function') toast('Reels — coming soon', 'info');
    // Revert active class on the reels nav button + snap back to feed
    $$('.bn-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'feed'));
    State.currentTab = 'feed';
    $$('.view').forEach(v => v.classList.remove('active'));
    const feedView = $('#feedView');
    if (feedView) { feedView.classList.add('active'); activeView = feedView; }
    tab = 'feed';
  }
  updateTopbarHeader(tab);
  updateChatThreadChrome();
  restoreScrollForTab(tab);
  if (activeView) springIn(activeView, { duration: 0.22 });
  refreshIcons();
  if (typeof updateNotifDots === 'function') updateNotifDots();
}

// On the chat/DM tabs, show the Instagram-style username header instead of
// the PRIV SPACA wordmark.
function updateTopbarHeader(tab) {
  const brand = $('#brandWordmarkBtn') || $('#brandWordmark');
  const igH = $('#igUsernameHeader');
  const igT = $('#igUsernameText');
  const showUsername = (tab === 'chat' || tab === 'groups');
  if (showUsername && State.user) {
    if (igT) igT.innerHTML = displayNameWithOwnerBadge(State.user, State.user.username || State.user.displayName || 'you', 'inline');
    if (brand) brand.classList.add('hidden');
    if (igH) igH.classList.remove('hidden');
  } else {
    if (brand) brand.classList.remove('hidden');
    if (igH) igH.classList.add('hidden');
  }
  if (typeof refreshIcons === 'function') refreshIcons();
}

// ====== Rooms & Members ======
let _lastMembersLoadedAt = 0;
let _loadMembersPromise = null;
async function loadMembers(force = false) {
  if (_loadMembersPromise) return _loadMembersPromise;
  if (!force && _lastMembersLoadedAt && (Date.now() - _lastMembersLoadedAt) < 2500 && Array.isArray(State.members) && State.members.length) {
    renderMembers();
    if (typeof renderStoriesRail === 'function') renderStoriesRail();
    return State.members;
  }
  _loadMembersPromise = (async () => {
    try {
      const data = await api('/users');
      State.members = data.users || [];
      _lastMembersLoadedAt = Date.now();
      renderMembers();
      if (typeof renderStoriesRail === 'function') renderStoriesRail();
      return State.members;
    } catch (_) {
      return State.members;
    } finally {
      _loadMembersPromise = null;
    }
  })();
  return _loadMembersPromise;
}

// Inbox segment state: 'groups' or 'primary'. Requests is a sub-view of primary.
let _inboxSeg = 'groups';
let _inboxShowRequests = false;

// A member counts as a "request" (not yet connected) when neither of us
// follows the other. Mutual/one-way follows land in Primary.
function _isRequestUser(u) {
  return !u.iFollow && !u.followsMe;
}

let _lastMembersSig = '';
function renderMembers() {
  const list = $('#membersList');
  if (!list) return;
  const reqListEl = $('#requestsList');
  const roomsPane = $('.rooms-pane');
  const prevListScroll = list.scrollTop || 0;
  const prevReqScroll = reqListEl ? (reqListEl.scrollTop || 0) : 0;
  const prevPaneScroll = roomsPane ? (roomsPane.scrollTop || 0) : 0;
  const meId = State.user && State.user.id;
  const others = State.members.filter(u => u.id !== meId);
  const me = State.members.find(u => u.id === meId);
  if ($('#memberCount')) $('#memberCount').textContent = String(State.members.length);

  // Split into Primary (connected) vs Requests (not connected yet).
  const primary = others.filter(u => !_isRequestUser(u));
  const requests = others.filter(u => _isRequestUser(u));

  // Update segment badges.
  const gBadge = $('#segGroupsBadge');
  if (gBadge) { const n = $$('#roomsList .room-item').length; gBadge.textContent = String(n); gBadge.classList.toggle('zero', n === 0); }
  const pBadge = $('#segPrimaryBadge');
  if (pBadge) { pBadge.textContent = String(primary.length); pBadge.classList.toggle('zero', primary.length === 0); }

  // Requests banner.
  const banner = $('#requestsBanner');
  const reqSub = $('#requestsSub');
  if (banner) banner.classList.toggle('hidden', requests.length === 0 || _inboxShowRequests);
  if (reqSub) reqSub.textContent = requests.length === 1 ? '1 person wants to chat' : requests.length + ' people want to chat';

  const typingIds = (State.typingUsers || []).map(t => t.id).sort().join(',');
  const activeDM = (State.currentRoom.kind === 'dm' && State.currentRoom.target) ? State.currentRoom.target.id : '';
  const sig = _inboxSeg + '|' + _inboxShowRequests + '||' +
    others.map(u => u.id + ':' + (u.online?1:0) + ':' + (u.photoUrl?1:0) + ':' + (u.iFollow?1:0) + ':' + (u.followsMe?1:0)).join(',') +
    '||' + typingIds + '||' + activeDM;
  if (sig === _lastMembersSig && list.children.length > 0) return;
  _lastMembersSig = sig;

  const buildRow = (u) => {
    const li = document.createElement('li');
    li.className = 'member-item';
    if (State.currentRoom.kind === 'dm' && State.currentRoom.target && State.currentRoom.target.id === u.id) li.classList.add('active');
    const avatar = document.createElement('span');
    avatar.className = 'avatar sm';
    renderAvatar(avatar, u, { showStatus: true, online: !!u.online });
    const meta = document.createElement('div');
    meta.className = 'meta';
    const isTyping = State.typingUsers.some(t => t.id === u.id);
    let subCls, subTxt;
    if (isTyping) { subCls = 'member-typing'; subTxt = 'typing…'; }
    else if (u.lastMessage && u.lastMessage.text) {
      subCls = 'last-msg';
      subTxt = (u.lastMessage.fromMe ? 'You: ' : '') + escapeHtml(u.lastMessage.text);
    } else { subCls = 'un'; subTxt = '@' + escapeHtml(u.username); }
    meta.innerHTML = '<span class="nm">' + displayNameWithOwnerBadge(u, u.displayName || u.username, 'inline') + '</span>' +
      '<span class="' + subCls + '">' + subTxt + '</span>';
    li.appendChild(avatar); li.appendChild(meta);
    // Right column: last-message time.
    if (u.lastMessage && u.lastMessage.createdAt) {
      const right = document.createElement('div');
      right.className = 'row-right';
      const t = document.createElement('span');
      t.className = 'row-time';
      t.textContent = (typeof timeAgo === 'function') ? timeAgo(u.lastMessage.createdAt) : '';
      right.appendChild(t);
      li.appendChild(right);
    }
    li.addEventListener('click', () => openDM(u));
    return li;
  };

  // Render Primary list.
  list.innerHTML = '';
  primary.forEach(u => list.appendChild(buildRow(u)));
  const emptyEl = $('#membersEmpty');
  if (emptyEl) emptyEl.classList.toggle('hidden', primary.length > 0 || requests.length > 0);

  // Render Requests sub-list.
  const reqList = $('#requestsList');
  if (reqList) {
    reqList.innerHTML = '';
    requests.forEach(u => reqList.appendChild(buildRow(u)));
    const reqEmpty = $('#requestsEmpty');
    if (reqEmpty) reqEmpty.classList.toggle('hidden', requests.length > 0);
  }

  renderNotesRail();
  requestAnimationFrame(() => {
    if (roomsPane) roomsPane.scrollTop = prevPaneScroll;
    if (list) list.scrollTop = prevListScroll;
    if (reqList) reqList.scrollTop = prevReqScroll;
  });
}

// ===== Notes rail (Instagram-style 24h statuses on the DM inbox) =====
function renderNotesRail() {
  const rail = $('#notesRail');
  if (!rail || _inboxSeg !== 'primary' || _inboxShowRequests) { if (rail) rail.innerHTML = ''; return; }
  const meId = State.user && State.user.id;
  const me = State.members.find(u => u.id === meId) || State.user;
  const others = State.members.filter(u => u.id !== meId);
  // Only show friends' notes for people who actually have an active note
  // (text OR an attached song). Empty/expired notes never render.
  const noteHas = (u) => u.note && (u.note.text || (u.note.music && u.note.music.title));
  const withNotes = others.filter(noteHas);
  rail.innerHTML = '';

  // Build one note cell (used for both me and friends).
  const buildNoteCell = (u, isMe) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'note-cell' + (isMe ? ' mine' : '');
    const note = u && u.note;
    const hasNote = isMe ? !!noteHas(u) : true;
    const music = note && note.music && note.music.title ? note.music : null;
    const bubble = document.createElement('div');
    bubble.className = 'note-bubble' + (isMe && !hasNote ? ' placeholder' : '');
    if (music) {
      const song = document.createElement('span');
      song.className = 'note-bubble-song';
      song.textContent = '♪ ' + music.title;
      bubble.appendChild(song);
    }
    const txt = document.createElement('span');
    txt.className = 'note-bubble-txt';
    txt.textContent = (note && note.text) ? note.text : (isMe && !hasNote ? 'Note…' : (music ? music.artist || '♪' : ''));
    bubble.appendChild(txt);
    const avWrap = document.createElement('span');
    avWrap.className = 'note-avatar avatar md' + (music ? ' has-music' : '');
    renderAvatar(avWrap, u, { online: isMe ? true : !!u.online, showStatus: !isMe });
    if (music) {
      const mb = document.createElement('span'); mb.className = 'note-music-badge'; mb.textContent = '♪';
      avWrap.appendChild(mb);
    } else if (isMe && !hasNote) {
      const add = document.createElement('span'); add.className = 'note-add-badge'; add.textContent = '+';
      avWrap.appendChild(add);
    }
    const nm = document.createElement('span');
    nm.className = 'note-name';
    if (isMe) nm.textContent = 'Your note'; else nm.innerHTML = displayNameWithOwnerBadge(u, u.displayName || u.username, 'inline');
    cell.appendChild(bubble); cell.appendChild(avWrap); cell.appendChild(nm);
    if (isMe) cell.addEventListener('click', openNoteModal);
    else cell.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (music && music.audio) playNotePreview(music.audio);
      else stopNotePreviewAudio();
      openNoteViewer(u);
    });
    return cell;
  };

  rail.appendChild(buildNoteCell(me, true));
  withNotes.forEach(u => rail.appendChild(buildNoteCell(u, false)));
  refreshIcons();
}

let _currentNoteUser = null;
function openNoteViewer(u) {
  if (!u) return;
  _currentNoteUser = u;
  const modal = $('#noteViewerModal');
  if (!modal) return;
  const h = $('#noteViewerHandle');
  if (h) h.innerHTML = displayNameWithOwnerBadge(u, u.username || u.displayName, 'inline') + ' • ' + escapeHtml(timeAgo(u.note?.createdAt || Date.now()));
  renderAvatar($('#noteViewerAvatar'), u);
  const songEl = $('#noteViewerSong');
  const textEl = $('#noteViewerText');
  if (songEl) {
    if (u.note?.music?.title) {
      songEl.innerHTML = `♪ ${escapeHtml(u.note.music.title)}${u.note.music.artist ? ' • ' + escapeHtml(u.note.music.artist) : ''}`;
      songEl.classList.remove('hidden');
    } else {
      songEl.classList.add('hidden');
    }
  }
  if (textEl) textEl.textContent = u.note?.text || '';
  const inp = $('#noteViewerInput');
  if (inp) { inp.placeholder = 'Message ' + (u.username || u.displayName) + '...'; inp.value = ''; }
  modal.classList.remove('hidden');
  springIn(modal);
}
function closeNoteViewer() {
  const modal = $('#noteViewerModal');
  if (modal) modal.classList.add('hidden');
  stopNotePreviewAudio();
}

// Play a short preview of a note's song (tap-to-play, Instagram-style).
let _notePreviewAudio = null;
function playNotePreview(url) {
  if (!url) return;
  try {
    if (!_notePreviewAudio) _notePreviewAudio = $('#notePreviewAudio') || new Audio();
    if (_notePreviewAudio.src === url && !_notePreviewAudio.paused) { stopNotePreviewAudio(); return; }
    _notePreviewAudio.src = url;
    _notePreviewAudio.currentTime = 0;
    _notePreviewAudio.play().catch(() => {});
  } catch (_) {}
}

function stopNotePreviewAudio() {
  try {
    if (_notePreviewAudio) {
      _notePreviewAudio.pause();
      _notePreviewAudio.currentTime = 0;
    }
  } catch (_) {}
}

function openNoteModal() {
  const modal = $('#noteModal');
  if (!modal) return;
  const meId = State.user && State.user.id;
  const me = State.members.find(u => u.id === meId) || State.user;
  const curNote = me && me.note ? me.note : null;
  const cur = curNote && curNote.text ? curNote.text : '';
  _noteDraftMusic = (curNote && curNote.music && curNote.music.title) ? Object.assign({}, curNote.music) : null;
  const input = $('#noteInput');
  if (input) input.value = cur;
  updateNotePreview();
  updateNoteMusicRow();
  const picker = $('#noteSongPicker'); if (picker) picker.classList.add('hidden');
  const chev = $('#noteMusicChev'); if (chev) chev.style.transform = '';
  const clearBtn = $('#noteClearBtn');
  if (clearBtn) clearBtn.style.display = (cur || _noteDraftMusic) ? '' : 'none';
  modal.classList.remove('hidden');
  const card = modal.querySelector('.sheet-card');
  if (card) motionAnimate(card, { transform: ['translateY(100%)', 'translateY(0)'], opacity: [0.6, 1] }, { duration: 0.34, easing: [0.2, 0.85, 0.15, 1] });
  if (input) setTimeout(() => input.focus(), 120);
  refreshIcons();
}
function closeNoteModal() {
  const m = $('#noteModal'); if (m) m.classList.add('hidden');
  const picker = $('#noteSongPicker'); if (picker) picker.classList.add('hidden');
  const chev = $('#noteMusicChev'); if (chev) chev.style.transform = '';
  stopNotePreviewAudio();
}

async function saveNote(text, music) {
  try {
    const body = { text: text || '' };
    if (music && music.title) body.music = { title: music.title, artist: music.artist || '', audio: music.audio || '', art: music.art || '' };
    const res = await api('/user/note', { method: 'POST', body });
    const meId = State.user && State.user.id;
    const me = State.members.find(u => u.id === meId);
    if (me) me.note = res.note || null;
    if (State.user) State.user.note = res.note || null;
    _lastMembersSig = '';
    renderNotesRail();
    toast((text || (music && music.title)) ? 'Note shared' : 'Note cleared', 'success');
  } catch (e) {
    toast('Could not save note: ' + (e.message || ''), 'error');
  }
}

// ---- Note editor: live preview + music picker (reuses iTunes search) ----
let _noteDraftMusic = null;
let _noteSearchTimer = null;
function updateNotePreview() {
  const input = $('#noteInput');
  const txt = $('#notePreviewText');
  const song = $('#notePreviewSong');
  const v = (input && input.value || '').trim();
  if (txt) txt.textContent = v || (_noteDraftMusic ? (_noteDraftMusic.artist || '') : "What's on your mind?");
  if (song) {
    if (_noteDraftMusic && _noteDraftMusic.title) { song.textContent = _noteDraftMusic.title; song.classList.remove('hidden'); }
    else song.classList.add('hidden');
  }
}
function updateNoteMusicRow() {
  const title = $('#noteMusicTitle');
  const artist = $('#noteMusicArtist');
  const remove = $('#noteMusicRemove');
  if (_noteDraftMusic && _noteDraftMusic.title) {
    if (title) title.textContent = _noteDraftMusic.title;
    if (artist) artist.textContent = _noteDraftMusic.artist || 'Song attached';
    if (remove) remove.classList.remove('hidden');
  } else {
    if (title) title.textContent = 'Add music';
    if (artist) artist.textContent = 'Search a song for your note';
    if (remove) remove.classList.add('hidden');
  }
}
function renderNoteSongResults(list) {
  const box = $('#noteSongList');
  if (!box) return;
  if (!list || !list.length) { box.innerHTML = '<div class="note-song-empty">Type to search songs…</div>'; return; }
  box.innerHTML = '';
  list.forEach(s => {
    const item = document.createElement('div');
    item.className = 'note-song-item';
    const art = document.createElement('img'); art.className = 'nsi-art'; art.src = s.art || ''; art.alt = '';
    const m = document.createElement('div'); m.className = 'nsi-m';
    m.innerHTML = '<div class="nsi-t"></div><div class="nsi-a"></div>';
    m.querySelector('.nsi-t').textContent = s.title;
    m.querySelector('.nsi-a').textContent = s.artist;
    const play = document.createElement('span'); play.className = 'nsi-play'; play.textContent = '▶';
    play.addEventListener('click', (e) => { e.stopPropagation(); if (s.audio) playNotePreview(s.audio); });
    item.appendChild(art); item.appendChild(m); item.appendChild(play);
    item.addEventListener('click', () => {
      _noteDraftMusic = { title: s.title, artist: s.artist, audio: s.audio || '', art: s.art || '' };
      updateNoteMusicRow(); updateNotePreview();
      stopNotePreviewAudio();
      const picker = $('#noteSongPicker'); if (picker) picker.classList.add('hidden');
      const clearBtn = $('#noteClearBtn'); if (clearBtn) clearBtn.style.display = '';
    });
    box.appendChild(item);
  });
}
async function searchNoteSongs(q) {
  const box = $('#noteSongList');
  if (!q || !q.trim()) { renderNoteSongResults([]); return; }
  try {
    const res = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&media=music&limit=15');
    const data = await res.json();
    let list = (data.results || []).filter(r => r.previewUrl).map(r => ({
      title: r.trackName || 'Song', artist: r.artistName || 'Artist',
      art: r.artworkUrl100 || '', audio: r.previewUrl,
    }));
    if (list.length === 0 && typeof storyMusicCatalog !== 'undefined') {
      const ql = q.toLowerCase();
      list = storyMusicCatalog.filter(s => s.title.toLowerCase().includes(ql) || s.artist.toLowerCase().includes(ql));
    }
    renderNoteSongResults(list);
  } catch (e) {
    if (typeof storyMusicCatalog !== 'undefined') {
      const ql = q.toLowerCase();
      const list = storyMusicCatalog.filter(s => s.title.toLowerCase().includes(ql) || s.artist.toLowerCase().includes(ql));
      if (list.length > 0) { renderNoteSongResults(list); return; }
    }
    if (box) box.innerHTML = '<div class="note-song-empty">Search failed — check your connection.</div>';
  }
}

function bindNotes() {
  const close = $('#noteClose');
  if (close) close.addEventListener('click', closeNoteModal);
  const modal = $('#noteModal');
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeNoteModal(); });
  const input = $('#noteInput');
  if (input) input.addEventListener('input', updateNotePreview);
  const share = $('#noteShareBtn');
  if (share) share.addEventListener('click', () => { const v = (input && input.value || '').trim(); saveNote(v, _noteDraftMusic); closeNoteModal(); });
  const clear = $('#noteClearBtn');
  if (clear) clear.addEventListener('click', () => { _noteDraftMusic = null; saveNote('', null); closeNoteModal(); });
  // Music row toggles the song picker.
  const musicRow = $('#noteMusicRow');
  if (musicRow) musicRow.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'noteMusicRemove') return;
    const picker = $('#noteSongPicker'); if (!picker) return;
    const show = picker.classList.contains('hidden');
    picker.classList.toggle('hidden', !show);
    const chev = $('#noteMusicChev'); if (chev) chev.style.transform = show ? 'rotate(180deg)' : '';
    if (show) { renderNoteSongResults([]); const s = $('#noteSongSearch'); if (s) setTimeout(() => s.focus(), 80); }
    else stopNotePreviewAudio();
  });
  const removeBtn = $('#noteMusicRemove');
  if (removeBtn) removeBtn.addEventListener('click', (e) => {
    e.stopPropagation(); stopNotePreviewAudio(); _noteDraftMusic = null; updateNoteMusicRow(); updateNotePreview();
    const clearBtn = $('#noteClearBtn'); if (clearBtn && !(input && input.value.trim())) clearBtn.style.display = 'none';
  });
  const searchInp = $('#noteSongSearch');
  if (searchInp) searchInp.addEventListener('input', () => {
    clearTimeout(_noteSearchTimer);
    const q = searchInp.value;
    _noteSearchTimer = setTimeout(() => searchNoteSongs(q), 350);
  });
  const nvc = $('#noteViewerClose');
  if (nvc) nvc.addEventListener('click', closeNoteViewer);
  const nvm = $('#noteViewerModal');
  if (nvm) nvm.addEventListener('click', (e) => { if (e.target === nvm) closeNoteViewer(); });
  const nvf = $('#noteViewerForm');
  if (nvf) nvf.addEventListener('submit', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const inp = $('#noteViewerInput');
    const txt = (inp && inp.value || '').trim();
    if (!txt || !_currentNoteUser) return;
    if (inp) inp.value = '';
    const target = _currentNoteUser;
    closeNoteViewer();
    const roomId = dmRoomId(State.user.id, target.id);
    try {
      await api('/messages/send', { method: 'POST', body: { roomId, targetUserId: target.id, text: `Replying to note: "${target.note?.text || '♪'}"\n${txt}` } });
      toast('Sent reply to @' + target.username, 'success');
    } catch (_) {}
  });
  $$('#noteViewerModal .note-quick-emoji').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!_currentNoteUser) return;
      const emoji = btn.dataset.emoji || '❤️';
      const target = _currentNoteUser;
      closeNoteViewer();
      const roomId = dmRoomId(State.user.id, target.id);
      try {
        await api('/messages/send', { method: 'POST', body: { roomId, targetUserId: target.id, text: `Reacted to note: "${target.note?.text || '♪'}"\n${emoji}` } });
        toast(`Reacted ${emoji} to @${target.username}`, 'success');
      } catch (_) {}
    });
  });
}


function isMobileChatViewport() {
  return window.innerWidth <= 780;
}

function isInMobileDmThread() {
  const cv = $('#chatView');
  return !!(State.currentRoom && State.currentRoom.kind === 'dm' && cv && cv.classList.contains('active') && !cv.classList.contains('show-rooms') && isMobileChatViewport());
}

function updateChatThreadChrome() {
  const inThread = isInMobileDmThread();
  const shell = $('#appShell');
  if (shell) shell.classList.toggle('chat-thread-open', inThread);
  const back = $('#backToRoomsBtn');
  if (back) {
    back.innerHTML = inThread ? '<i data-lucide="arrow-left"></i>' : '<i data-lucide="menu"></i>';
    back.title = inThread ? 'Back to chats' : 'Chats';
    back.setAttribute('aria-label', inThread ? 'Back to chats' : 'Chats');
  }
  const headerLeft = $('#chatHeaderProfileTap');
  if (headerLeft) headerLeft.classList.toggle('is-profile-link', !!(State.currentRoom && State.currentRoom.kind === 'dm' && State.currentRoom.target));
  if (typeof refreshIcons === 'function') refreshIcons();
}

function backToChatList() {
  const cv = $('#chatView');
  if (!cv) return;
  cv.classList.add('show-rooms');
  updateChatThreadChrome();
}

function openDM(user) {
  State.currentRoom = {
    id: dmRoomId(State.user.id, user.id),
    kind: 'dm',
    target: user,
    label: '@' + user.username
  };
  $('#chatTitle').innerHTML = displayNameWithOwnerBadge(user, user.displayName || ('@' + user.username), 'inline');
  $('#chatSubtitle').textContent = '@' + user.username + (user.online ? ' · online' : ' · offline');
  const ca = $('#chatAvatar');
  ca.style.display = 'inline-flex';
  renderAvatar(ca, user, { showStatus: true, online: !!user.online });
  $$('#roomsList .room-item').forEach(r => r.classList.remove('active'));
  $('#chatView').classList.remove('show-rooms');
  updateChatThreadChrome();
  if ($('#rtcCallActions')) $('#rtcCallActions').style.display = 'flex';
  // Opening a DM belongs to the Primary segment — make sure it's shown.
  if (typeof _inboxSeg !== 'undefined' && _inboxSeg !== 'primary') {
    _inboxSeg = 'primary';
    $$('#inboxSegment .inbox-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.seg === 'primary'));
    const gs = $('#groupsPaneSection'); if (gs) gs.style.display = 'none';
    const ds = $('#dmsPaneSection'); if (ds) ds.style.display = 'block';
  }
  // Reset message-id memo so all messages in the new room animate-in once
  _previousMessageIds = new Set();
  renderMembers();
  refreshSecretChatUI();
  loadMessages(true);
}

function dmRoomId(a, b) { return 'dm:' + [a, b].sort().join(':'); }

// Show/hide Secret Chat controls based on current room
function refreshSecretChatUI() {
  const room = State.currentRoom;
  const btn = $('#secretChatBtn');
  const banner = $('#secretBanner');
  const disRow = $('#disappearRow');
  if (banner) banner.classList.add('hidden');
  if (!btn) return;
  if (!room || room.kind !== 'dm' || !room.target) {
    btn.style.display = 'none';
    if (disRow) disRow.style.display = 'none';
    return;
  }
  btn.style.display = '';
  const on = isSecretChatOn(room.id);
  btn.classList.toggle('active', on);
  btn.innerHTML = `<i data-lucide="lock"></i> <span>${on ? 'Turn OFF Secret Chat' : 'Toggle Secret Chat'}</span>`;
  
  const target = room.target;
  const sub = $('#chatSubtitle');
  if (sub && target) {
    sub.innerHTML = `@${target.username}${target.online ? ' · online' : ' · offline'}${on ? ' <strong style="color:#10b981;">· 🔒 E2E Secret Mode</strong>' : ''}`;
  }

  if (on) {
    if (disRow) disRow.style.display = 'flex';
    const sel = $('#disappearSelect');
    if (sel) sel.value = String(getDisappearMs(room.id) || 0);
  } else {
    if (disRow) disRow.style.display = 'none';
  }
  refreshIcons();
}

async function toggleSecretChat() {
  const room = State.currentRoom;
  if (!room || room.kind !== 'dm' || !room.target) return;
  const on = !isSecretChatOn(room.id);
  if (on) {
    // Pre-flight: make sure peer has uploaded a public key
    try {
      const r = await api('/user/public-key?userId=' + encodeURIComponent(room.target.id));
      if (!r || !r.publicKey) {
        toast(`${room.target.username} hasn't opened the app recently — Secret Chat needs their key.`, 'error');
        return;
      }
    } catch (e) {
      toast('Could not reach server to set up Secret Chat', 'error');
      return;
    }
    // Make sure my own key is published
    try { await E2E.publishPublicKey(); } catch (_) {}
  }
  setSecretChat(room.id, on);
  refreshSecretChatUI();
  toast(on ? '🔒 Secret Chat ON — messages are end-to-end encrypted' : 'Secret Chat off', 'success');
}

function bindSecretChat() {
  const btn = $('#secretChatBtn');
  if (btn) btn.addEventListener('click', toggleSecretChat);
  const off = $('#secretOffBtn');
  if (off) off.addEventListener('click', () => {
    const room = State.currentRoom;
    if (!room) return;
    setSecretChat(room.id, false);
    refreshSecretChatUI();
    toast('Secret Chat off', 'success');
  });
  const sel = $('#disappearSelect');
  if (sel) sel.addEventListener('change', () => {
    const room = State.currentRoom;
    if (!room) return;
    setDisappearMs(room.id, Number(sel.value) || 0);
    const ms = Number(sel.value) || 0;
    toast(ms > 0 ? 'Messages will disappear after ' + (ms < 60000 ? (ms/1000)+'s' : Math.round(ms/60000)+' min') : 'Disappearing off', 'success');
  });
}

function bindRooms() {
  $$('#roomsList .room-item').forEach(r => {
    r.addEventListener('click', () => {
      const id = r.dataset.room;
      State.currentRoom = { id, kind: 'group', target: null, label: '#' + id };
      $$('#roomsList .room-item').forEach(x => x.classList.toggle('active', x === r));
      $('#chatTitle').textContent = '#' + id;
      $('#chatSubtitle').textContent = 'Tap members to start a private chat';
      $('#chatAvatar').style.display = 'none';
      $('#chatView').classList.remove('show-rooms');
      updateChatThreadChrome();
      if ($('#rtcCallActions')) $('#rtcCallActions').style.display = 'none';
      _previousMessageIds = new Set();
      renderMembers();
      refreshSecretChatUI();
      loadMessages(true);
    });
  });
  const back = $('#backToRoomsBtn');
  if (back) back.addEventListener('click', () => {
    if (isInMobileDmThread()) backToChatList();
    else { $('#chatView').classList.toggle('show-rooms'); updateChatThreadChrome(); }
  });
  const headerTap = $('#chatHeaderProfileTap');
  if (headerTap) headerTap.addEventListener('click', () => {
    if (State.currentRoom && State.currentRoom.kind === 'dm' && State.currentRoom.target) {
      openUserProfile(State.currentRoom.target.id);
    }
  });
}

// Switch the inbox side-pane between the Groups and Primary segments.
function setInboxSegment(seg) {
  _inboxSeg = (seg === 'primary') ? 'primary' : 'groups';
  _inboxShowRequests = false; // always reset to the main list on segment switch
  $$('#inboxSegment .inbox-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.seg === _inboxSeg));
  const gs = $('#groupsPaneSection'); if (gs) gs.style.display = (_inboxSeg === 'groups') ? 'block' : 'none';
  const ds = $('#dmsPaneSection'); if (ds) ds.style.display = (_inboxSeg === 'primary') ? 'block' : 'none';
  // Within Primary, show the main DM list (not the requests sub-view).
  const rv = $('#requestsView'); if (rv) rv.classList.add('hidden');
  const ml = $('#membersList'); if (ml) ml.classList.remove('hidden');
  const banner = $('#requestsBanner');
  const me = $('#membersEmpty');
  if (_inboxSeg === 'primary') {
    renderMembers();
    // Refresh from the server so newly-joined people appear in Primary/Requests.
    if (typeof loadMembers === 'function') loadMembers();
  } else {
    if (banner) banner.classList.add('hidden'); if (me) me.classList.add('hidden');
  }
  refreshIcons();
}

function bindInboxSegment() {
  $$('#inboxSegment .inbox-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const seg = btn.dataset.seg;
      setInboxSegment(seg);
      // Keep the bottom-nav tab visually in sync (Groups btn ↔ groups seg).
      const navTab = seg === 'groups' ? 'groups' : 'chat';
      $$('.bn-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === navTab));
      State.currentTab = navTab;
    });
  });
  // Requests banner opens the requests sub-view.
  const banner = $('#requestsBanner');
  if (banner) banner.addEventListener('click', () => {
    _inboxShowRequests = true;
    const ml = $('#membersList'); if (ml) ml.classList.add('hidden');
    banner.classList.add('hidden');
    const me = $('#membersEmpty'); if (me) me.classList.add('hidden');
    const rv = $('#requestsView'); if (rv) rv.classList.remove('hidden');
    renderMembers();
    refreshIcons();
  });
  const backBtn = $('#requestsBackBtn');
  if (backBtn) backBtn.addEventListener('click', () => {
    _inboxShowRequests = false;
    const rv = $('#requestsView'); if (rv) rv.classList.add('hidden');
    const ml = $('#membersList'); if (ml) ml.classList.remove('hidden');
    renderMembers();
    refreshIcons();
  });
}

// ============================================================
// ====== E2E (Part 3) — Secret Chat + Disappearing Messages ====
// ============================================================
// Each user generates an ECDH P-256 keypair on first login.
// - Private key lives in IndexedDB (browser-local, non-exportable)
// - Public key is uploaded to the server
// To encrypt a DM:
//   1) Derive a shared 32-byte secret via ECDH with peer's public key
//   2) HKDF-derive a 32-byte AES-GCM key
//   3) Encrypt text with random 12-byte IV
//   4) Send { cipher, iv, encrypted:true } — server never sees plaintext
const E2E = (() => {
  const DB_NAME = 'priv-spaca-e2e';
  const STORE = 'keys';
  const KEY_ID = 'self';
  let _myKeypairP = null;        // cached Promise<{privateKey, publicKey}>
  let _myPublicRawB64 = null;    // cached base64url of own public key
  let _peerKeyCache = new Map(); // userId -> CryptoKey (peer public)
  let _peerKeyB64Cache = new Map();
  let _aesKeyCache = new Map();  // peerId -> CryptoKey (AES-GCM derived)
  let _publishedOnce = false;

  // ---- IndexedDB helpers (we only ever read/write one record) ----
  function _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function _idbGet(key) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror  = () => reject(r.error);
    });
  }
  async function _idbPut(key, val) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const r = tx.objectStore(STORE).put(val, key);
      r.onsuccess = () => resolve();
      r.onerror  = () => reject(r.error);
    });
  }

  // ---- base64url ↔ bytes ----
  function b64uEncode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(str) {
    str = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- Load or generate user's keypair ----
  async function getOrCreateKeypair() {
    if (_myKeypairP) return _myKeypairP;
    _myKeypairP = (async () => {
      const stored = await _idbGet(KEY_ID).catch(() => null);
      if (stored && stored.privateKey && stored.publicKey) {
        return { privateKey: stored.privateKey, publicKey: stored.publicKey };
      }
      // Generate fresh keypair
      const kp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,                    // not extractable (private stays inside)
        ['deriveBits']
      );
      await _idbPut(KEY_ID, { privateKey: kp.privateKey, publicKey: kp.publicKey });
      return kp;
    })();
    return _myKeypairP;
  }

  async function getMyPublicKeyB64() {
    if (_myPublicRawB64) return _myPublicRawB64;
    const { publicKey } = await getOrCreateKeypair();
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
    _myPublicRawB64 = b64uEncode(raw);
    return _myPublicRawB64;
  }

  // ---- Publish my public key to server (once per session, or if changed) ----
  async function publishPublicKey() {
    if (_publishedOnce) return;
    try {
      const pub = await getMyPublicKeyB64();
      // Skip if server already has the same key for me
      try {
        const me = State.user && State.user.id;
        if (me) {
          const r = await api('/user/public-key?userId=' + encodeURIComponent(me));
          if (r && r.publicKey === pub) { _publishedOnce = true; return; }
        }
      } catch (_) {}
      await api('/user/public-key', { method: 'POST', body: { publicKey: pub } });
      _publishedOnce = true;
      if (State.user) State.user.publicKey = pub;
    } catch (e) {
      console.warn('[E2E] publishPublicKey failed', e && e.message);
    }
  }

  // ---- Fetch peer's public key (cached) ----
  async function getPeerPublicKey(userId) {
    if (_peerKeyCache.has(userId)) return _peerKeyCache.get(userId);
    // Try members list first
    let b64 = null;
    const m = (State.members || []).find(u => u.id === userId);
    if (m && m.publicKey) b64 = m.publicKey;
    if (!b64) {
      try {
        const r = await api('/user/public-key?userId=' + encodeURIComponent(userId));
        b64 = r && r.publicKey;
      } catch (_) {}
    }
    if (!b64) return null;
    // Same b64? reuse imported key
    if (_peerKeyB64Cache.get(userId) === b64 && _peerKeyCache.has(userId)) {
      return _peerKeyCache.get(userId);
    }
    try {
      const raw = b64uDecode(b64);
      const key = await crypto.subtle.importKey(
        'raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
      );
      _peerKeyCache.set(userId, key);
      _peerKeyB64Cache.set(userId, b64);
      _aesKeyCache.delete(userId); // force re-derive
      return key;
    } catch (e) {
      console.warn('[E2E] importKey peer failed', e && e.message);
      return null;
    }
  }

  // ---- Derive AES-GCM key with peer (cached per peer) ----
  async function deriveAesKey(peerId) {
    if (_aesKeyCache.has(peerId)) return _aesKeyCache.get(peerId);
    const peerPub = await getPeerPublicKey(peerId);
    if (!peerPub) return null;
    const { privateKey } = await getOrCreateKeypair();
    // ECDH shared secret (256 bits)
    const shared = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPub }, privateKey, 256
    ));
    // HKDF → 32-byte AES key (use sorted-pair as salt info so both sides match)
    const myId = (State.user && State.user.id) || '';
    const info = new TextEncoder().encode('PRIV-SPACA-E2E|' + [myId, peerId].sort().join('|'));
    const baseKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const aesRaw = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info }, baseKey, 256
    ));
    const aesKey = await crypto.subtle.importKey(
      'raw', aesRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    );
    _aesKeyCache.set(peerId, aesKey);
    return aesKey;
  }

  async function encryptFor(peerId, plaintext) {
    const aes = await deriveAesKey(peerId);
    if (!aes) throw new Error('No public key for peer — ask them to open the app once.');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, aes, new TextEncoder().encode(plaintext)
    ));
    return { cipher: b64uEncode(ct), iv: b64uEncode(iv) };
  }

  async function decryptFrom(peerId, cipherB64, ivB64) {
    const aes = await deriveAesKey(peerId);
    if (!aes) throw new Error('no key');
    const ct = b64uDecode(cipherB64);
    const iv = b64uDecode(ivB64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, ct);
    return new TextDecoder().decode(pt);
  }

  // Clear caches when keys change (e.g. peer rotated key)
  function clearPeerCache(userId) {
    if (userId) {
      _peerKeyCache.delete(userId);
      _peerKeyB64Cache.delete(userId);
      _aesKeyCache.delete(userId);
    } else {
      _peerKeyCache.clear();
      _peerKeyB64Cache.clear();
      _aesKeyCache.clear();
    }
  }

  return {
    getOrCreateKeypair, getMyPublicKeyB64, publishPublicKey,
    encryptFor, decryptFrom, clearPeerCache,
  };
})();

// ---- Secret Chat per-DM toggle (persisted in localStorage) ----
function _secretSettings() {
  try { return JSON.parse(localStorage.getItem('ps_secret') || '{}'); }
  catch (_) { return {}; }
}
function _saveSecretSettings(s) { localStorage.setItem('ps_secret', JSON.stringify(s)); }
function isSecretChatOn(roomId) {
  if (!roomId || !roomId.startsWith('dm:')) return false;
  return !!_secretSettings()[roomId];
}
function setSecretChat(roomId, on) {
  const s = _secretSettings();
  if (on) s[roomId] = { on: true, since: Date.now() };
  else delete s[roomId];
  _saveSecretSettings(s);
}
function getDisappearMs(roomId) {
  const s = _secretSettings();
  return (s[roomId] && s[roomId].disappearMs) || 0;
}
function setDisappearMs(roomId, ms) {
  const s = _secretSettings();
  if (!s[roomId]) s[roomId] = { on: true, since: Date.now() };
  s[roomId].disappearMs = Number(ms) || 0;
  _saveSecretSettings(s);
}

// Decrypt-or-fallback for an incoming message (called from renderMessages).
// Async — when decryption completes we re-trigger a render so the bubble updates.
const _e2eDecryptCache = new Map(); // msgId -> decrypted text or '__ERR__'
async function _e2eDecryptInPlace(m, peerId) {
  if (!m || !m.encrypted || !m.cipher || !m.iv) return;
  if (_e2eDecryptCache.has(m.id)) {
    m._decrypted = _e2eDecryptCache.get(m.id);
    return;
  }
  try {
    const pt = await E2E.decryptFrom(peerId, m.cipher, m.iv);
    m._decrypted = pt;
    _e2eDecryptCache.set(m.id, pt);
  } catch (e) {
    m._decrypted = '__ERR__';
    _e2eDecryptCache.set(m.id, '__ERR__');
  }
  // Re-render after decryption completes
  lastMessagesSignature = '';
  renderMessages(false);
}

// ====== Messages ======
let lastMessagesScrollAtBottom = true;
let lastMessagesSignature = '';

function dedupeMessagesById(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages || []) {
    if (!m || !m.id) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

function upsertMessageInState(msg) {
  if (!msg || !msg.id) return false;
  const idx = State.messages.findIndex(m => m && m.id === msg.id);
  if (idx >= 0) {
    // Realtime can arrive before /messages/send finishes. Merge instead of
    // pushing so slow voice-note sends never appear as two bubbles temporarily.
    State.messages[idx] = { ...State.messages[idx], ...msg };
    return false;
  }
  State.messages.push(msg);
  return true;
}

async function loadMessages(scrollEnd) {
  try {
    const data = await api('/messages?roomId=' + encodeURIComponent(State.currentRoom.id));
    const newMsgs = dedupeMessagesById(data.messages || []);
    const sig = newMsgs.map(m => m.id).join('|');
    if (sig === lastMessagesSignature && !scrollEnd) return; // skip rerender if unchanged
    lastMessagesSignature = sig;
    State.messages = newMsgs;
    renderMessages(scrollEnd);
  } catch (e) {
    if (e.status !== 401) console.warn('loadMessages', e.message);
  }
}

let _previousMessageIds = new Set();
let _lastMessageRenderSig = '';
function _messagesRenderSig(msgs) {
  return msgs.map(m => m.id + ':' + (m.text||'').length + ':' + (m.imageUrl?'1':'0')).join('|');
}
function renderMessages(forceScroll) {
  const list = $('#messagesList');
  const scroller = $('#messagesScroll');
  const wasAtBottom = lastMessagesScrollAtBottom;
  const currentIds = new Set(State.messages.map(m => m.id));
  const newOnes = new Set();
  currentIds.forEach(id => { if (!_previousMessageIds.has(id)) newOnes.add(id); });
  // === Skip rebuild if nothing actually changed (anti-flicker) ===
  const sig = _messagesRenderSig(State.messages);
  if (sig === _lastMessageRenderSig && newOnes.size === 0 && !forceScroll && list.children.length > 0) {
    return;
  }
  _lastMessageRenderSig = sig;
  _previousMessageIds = currentIds;
  list.innerHTML = '';
  if (State.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="icon"><i data-lucide="message-circle"></i></div>
      <div class="title">No messages yet</div>
      <div class="sub">Be the first to say hi 👋</div>
    `;
    list.appendChild(empty);
  }
  const meId = State.user && State.user.id;
  let lastDay = null;
  let lastSender = null;
  State.messages.forEach((m, idx) => {
    const dk = dayKey(m.createdAt);
    if (dk !== lastDay) {
      const div = document.createElement('div');
      div.className = 'day-divider';
      div.textContent = dayLabel(m.createdAt);
      list.appendChild(div);
      lastDay = dk;
      lastSender = null;
    }
    const grouped = (lastSender === m.userId);
    const node = renderMessage(m, meId, grouped);
    list.appendChild(node);
    // Only animate truly new messages (not the entire list on every poll)
    if (newOnes.has(m.id)) {
      const fromX = (m.userId === meId) ? 16 : -12;
      motionAnimate(node,
        { opacity: [0, 1], transform: [`translate(${fromX}px, 6px) scale(.96)`, 'translate(0,0) scale(1)'] },
        { duration: 0.32, easing: [0.2, 0.85, 0.2, 1] }
      );
    }
    lastSender = m.userId;
  });
  refreshIcons();
  if (forceScroll || wasAtBottom) {
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
    $('#scrollBottomBtn').classList.add('hidden');
  }
}


function isAudioAttachmentUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const raw = url.trim();
  const clean = raw.split('#')[0].split('?')[0].toLowerCase();
  return raw.startsWith('data:audio/')
    || /\.(webm|mp3|m4a|ogg|oga|wav|aac|opus|flac)$/i.test(clean)
    || /(^|[\/_-])voice[\w-]*note/i.test(raw)
    || /(^|[\/_-])audio[\w-]*(\.|\/)/i.test(raw);
}

function formatAudioTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return '0:00';
  const mins = Math.floor(n / 60);
  const secs = Math.floor(n % 60);
  return mins + ':' + String(secs).padStart(2, '0');
}

function createVoiceNoteElement(src, isMine, opts = {}) {
  const root = document.createElement('div');
  root.className = 'voice-note' + (isMine ? ' mine' : ' theirs') + (opts.preview ? ' preview' : '');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', opts.preview ? 'Voice note preview' : 'Voice note message');

  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  audio.src = src;
  audio.className = 'voice-note-audio';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'voice-play-btn';
  playBtn.setAttribute('aria-label', 'Play voice note');
  playBtn.innerHTML = '<i data-lucide="play"></i>';

  const body = document.createElement('div');
  body.className = 'voice-note-body';

  const top = document.createElement('div');
  top.className = 'voice-note-top';
  const title = document.createElement('span');
  title.className = 'voice-note-title';
  title.textContent = 'Voice note';
  const duration = document.createElement('span');
  duration.className = 'voice-note-duration';
  duration.textContent = opts.duration || '0:00';
  top.append(title, duration);

  const wave = document.createElement('div');
  wave.className = 'voice-waveform';
  wave.setAttribute('aria-hidden', 'true');
  const bars = [14, 22, 12, 28, 18, 34, 16, 25, 13, 30, 20, 36, 15, 26, 18, 32, 12, 24, 17, 29, 14, 21];
  bars.forEach((h, idx) => {
    const b = document.createElement('span');
    b.className = 'voice-wave-bar';
    b.style.setProperty('--bar-h', h + 'px');
    b.style.setProperty('--bar-delay', (idx * 28) + 'ms');
    wave.appendChild(b);
  });

  const meta = document.createElement('div');
  meta.className = 'voice-note-meta';
  const mic = document.createElement('span');
  mic.className = 'voice-note-mic';
  mic.innerHTML = '<i data-lucide="mic-2"></i>';
  const hint = document.createElement('span');
  hint.textContent = opts.preview ? 'Ready to send' : (isMine ? 'Sent audio' : 'Audio message');
  meta.append(mic, hint);

  body.append(top, wave, meta);
  root.append(playBtn, body, audio);

  const setIcon = (name) => {
    playBtn.innerHTML = '<i data-lucide="' + name + '"></i>';
    if (typeof refreshIcons === 'function') refreshIcons();
  };
  const updateProgress = () => {
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const pct = dur ? Math.min(1, Math.max(0, audio.currentTime / dur)) : 0;
    const activeBars = Math.round(pct * bars.length);
    wave.querySelectorAll('.voice-wave-bar').forEach((bar, idx) => bar.classList.toggle('played', idx < activeBars));
    if (dur) {
      duration.textContent = audio.paused || audio.ended
        ? formatAudioTime(dur)
        : formatAudioTime(audio.currentTime) + ' / ' + formatAudioTime(dur);
    }
  };

  playBtn.addEventListener('click', async () => {
    try {
      if (!audio.paused) {
        audio.pause();
        return;
      }
      const active = window.__privSpacaActiveVoiceAudio;
      if (active && active !== audio && !active.paused) active.pause();
      window.__privSpacaActiveVoiceAudio = audio;
      await audio.play();
    } catch (_) {
      toast('Could not play this voice note', 'error');
    }
  });
  wave.addEventListener('click', (e) => {
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    if (!dur) return;
    const rect = wave.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pct * dur;
    updateProgress();
  });
  audio.addEventListener('loadedmetadata', updateProgress);
  audio.addEventListener('durationchange', updateProgress);
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('play', () => { root.classList.add('playing'); setIcon('pause'); });
  audio.addEventListener('pause', () => { root.classList.remove('playing'); if (!audio.ended) setIcon('play'); updateProgress(); });
  audio.addEventListener('ended', () => { root.classList.remove('playing'); setIcon('rotate-ccw'); updateProgress(); });
  audio.addEventListener('error', () => { duration.textContent = 'Audio unavailable'; root.classList.add('voice-error'); });

  requestAnimationFrame(() => { if (typeof refreshIcons === 'function') refreshIcons(); });
  return root;
}

function renderMessage(m, meId, grouped) {
  const row = document.createElement('div');
  row.className = 'message';
  if (m.scheduledOriginally) row.classList.add('scheduled-tag');
  if (grouped) row.classList.add('grouped');
  const isMine = m.userId === meId;
  if (isMine) row.classList.add('mine');
  row.dataset.id = m.id;

  const author = resolveAuthor(m.author, m.userId, m.authorSnapshot);

  const av = document.createElement('span');
  av.className = 'avatar sm';
  renderAvatar(av, author);
  row.appendChild(av);

  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';

  // Author line (only for first in group, not mine)
  if (!isMine && !grouped) {
    const al = document.createElement('div');
    al.className = 'author-line';
    al.innerHTML = displayNameWithOwnerBadge(author, author.displayName || ('@' + author.username), 'inline');
    const tA = bubbleTintFor(m.userId);
    al.style.setProperty('--bubble-author', tA.author);
    wrap.appendChild(al);
  }

  const bubble = document.createElement('div');
  const hasAudioAttachment = isAudioAttachmentUrl(m.imageUrl);
  const isImageOnly = !!m.imageUrl && !hasAudioAttachment && !m.text && !m.replyTo;
  bubble.className = 'bubble' + (isImageOnly ? ' image-only' : '');
  // Per-user pastel bubble color (only for "their" messages)
  if (!isMine && !isImageOnly) {
    const tint = bubbleTintFor(m.userId);
    bubble.style.setProperty('--bubble-bg', tint.bg);
    bubble.style.setProperty('--bubble-fg', tint.fg);
  }

  if (m.replyTo) {
    const q = document.createElement('div');
    q.className = 'reply-quote';
    const previewText = m.replyTo.text ? m.replyTo.text : (isAudioAttachmentUrl(m.replyTo.imageUrl) ? '🎙️ Voice note' : (m.replyTo.imageUrl ? '📷 Photo' : '…'));
    q.innerHTML = `<strong>@${escapeHtml(m.replyTo.username || 'user')}</strong><div class="quoted-text">${escapeHtml(previewText.slice(0, 140))}</div>`;
    q.addEventListener('click', () => {
      const el = $('#messagesList .message[data-id="' + m.replyTo.id + '"]');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.transition = 'background .3s'; const b = el.querySelector('.bubble'); if (b) { b.style.boxShadow = '0 0 0 3px rgba(0,162,255,.4)'; setTimeout(() => b.style.boxShadow = '', 1500); } }
    });
    bubble.appendChild(q);
  }

  // Story reply context: a small card showing the story this message replied to.
  if (m.storyReply) {
    const sr = document.createElement('div');
    sr.className = 'story-reply-context';
    const label = isMine ? 'You replied to their story' : 'Replied to your story';
    const thumb = m.storyReply.imageUrl
      ? `<img src="${escapeHtml(m.storyReply.imageUrl)}" class="story-reply-thumb" alt="story" />`
      : `<span class="story-reply-thumb story-reply-thumb--text">Aa</span>`;
    sr.innerHTML = `${thumb}<div class="story-reply-ctx-meta"><span class="story-reply-ctx-label">${label}</span>${m.storyReply.text ? `<span class="story-reply-ctx-text">${escapeHtml(m.storyReply.text.slice(0, 60))}</span>` : ''}</div>`;
    bubble.appendChild(sr);
  }

  // === Encrypted (E2E) message rendering ===
  if (m.encrypted) {
    const t = document.createElement('div');
    t.className = 'text';
    if (typeof m._decrypted === 'string' && m._decrypted !== '__ERR__') {
      t.textContent = m._decrypted;
    } else if (m._decrypted === '__ERR__') {
      t.textContent = '🔒 (Can\'t decrypt — sent before you set up Secret Chat on this device)';
      bubble.classList.add('decrypt-error');
    } else {
      t.textContent = '🔒 Decrypting…';
      // Trigger async decrypt (peer = other DM participant)
      if (State.currentRoom && State.currentRoom.kind === 'dm' && State.currentRoom.target) {
        const peerId = (m.userId === (State.user && State.user.id))
          ? State.currentRoom.target.id   // I sent it → decrypt against peer
          : m.userId;                     // peer sent it → decrypt against peer
        _e2eDecryptInPlace(m, peerId);
      }
    }
    bubble.appendChild(t);
    // E2E badge
    const badge = document.createElement('div');
    badge.className = 'e2e-badge';
    badge.innerHTML = '<i data-lucide="shield-check"></i> End-to-end encrypted';
    bubble.appendChild(badge);
  } else if (m.text) {
    const t = document.createElement('div');
    t.className = 'text';
    t.textContent = m.text;
    bubble.appendChild(t);
  }
  // Disappearing-message badge + countdown bar
  if (m.disappearAt) {
    const remain = m.disappearAt - Date.now();
    if (remain > 0) {
      bubble.classList.add('disappearing');
      // Set animation duration = remaining ms
      bubble.style.setProperty('animation-duration', remain + 'ms');
      const db = document.createElement('div');
      db.className = 'disappear-badge';
      const sec = Math.ceil(remain / 1000);
      const human = sec < 60 ? sec + 's' : Math.ceil(sec / 60) + 'm';
      db.innerHTML = '<i data-lucide="timer"></i> Disappears in ' + human;
      bubble.appendChild(db);
      // The CSS animation runs on ::after, but we need to set its duration on the bubble.
      // Use inline style on the ::after via a CSS custom property:
      const styleId = 'disappear-style-' + m.id;
      if (!document.getElementById(styleId)) {
        const st = document.createElement('style');
        st.id = styleId;
        st.textContent = `.bubble[data-mid="${m.id}"]::after{animation-duration:${remain}ms}`;
        document.head.appendChild(st);
      }
      bubble.setAttribute('data-mid', m.id);
      // Schedule local removal when it expires
      setTimeout(() => {
        State.messages = State.messages.filter(x => x.id !== m.id);
        lastMessagesSignature = '';
        renderMessages(false);
      }, remain + 500);
    }
  }
  if (m.imageUrl) {
    if (hasAudioAttachment) {
      bubble.classList.add('has-audio-attach');
      if (!m.text && !m.replyTo && !m.storyReply && !m.encrypted) bubble.classList.add('voice-only');
      bubble.appendChild(createVoiceNoteElement(m.imageUrl, isMine));
    } else {
      const img = document.createElement('img');
      img.className = 'img-attach';
      img.src = m.imageUrl;
      img.alt = 'attachment';
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(m.imageUrl, author.displayName));
      img.addEventListener('error', () => { img.alt = '(image)'; img.style.display = 'none'; });
      bubble.appendChild(img);
    }
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'actions';
  const replyBtn = document.createElement('button');
  replyBtn.className = 'ghost-btn'; replyBtn.title = 'Reply';
  replyBtn.innerHTML = '<i data-lucide="corner-up-left"></i>';
  replyBtn.addEventListener('click', () => setReplyTo(m));
  actions.appendChild(replyBtn);
  if (isMine) {
    const delBtn = document.createElement('button');
    delBtn.className = 'ghost-btn'; delBtn.title = 'Delete';
    delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    delBtn.addEventListener('click', async () => {
      try {
        await api('/messages/delete', { method: 'POST', body: { messageId: m.id } });
        State.messages = State.messages.filter(x => x.id !== m.id);
        lastMessagesSignature = '';
        renderMessages(false);
        undoToast('Message deleted', async () => {
          try {
            await api('/messages/restore', { method: 'POST', body: { messageId: m.id } });
            lastMessagesSignature = ''; loadMessages(false);
            toast('Restored', 'success');
          } catch (e) { toast(e.message || 'Restore failed', 'error'); }
        });
      } catch (e) { toast(e.message || 'Delete failed', 'error'); }
    });
    actions.appendChild(delBtn);
  }
  bubble.appendChild(actions);

  wrap.appendChild(bubble);

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = timeFmt(m.createdAt);
  wrap.appendChild(time);

  row.appendChild(wrap);
  return row;
}

function setReplyTo(m) {
  const author = resolveAuthor(m.author, m.userId, m.authorSnapshot);
  State.replyTo = {
    id: m.id,
    text: m.text || (isAudioAttachmentUrl(m.imageUrl) ? '🎙️ Voice note' : (m.imageUrl ? '📷 Photo' : '')),
    username: author.username || 'user',
    imageUrl: m.imageUrl || null
  };
  $('#replyToName').textContent = '@' + State.replyTo.username;
  $('#replyToText').textContent = State.replyTo.text;
  $('#replyBanner').classList.remove('hidden');
  $('#composerInput').focus();
  refreshIcons();
}

function clearReply() {
  State.replyTo = null;
  $('#replyBanner').classList.add('hidden');
}

// ====== Composer ======
function bindComposer() {
  const input = $('#composerInput');
  const form = $('#composer');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    if (input._typeTm) clearTimeout(input._typeTm);
    input._typeTm = setTimeout(sendTyping, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !State.attach) return;
    const room = State.currentRoom;
    const secretOn = isSecretChatOn(room.id);
    const disappearMs = secretOn ? getDisappearMs(room.id) : 0;
    let payload = {
      roomId: room.id,
      text,
      imageUrl: State.attach ? State.attach.url : null,
      replyTo: State.replyTo,
    };
    // Encrypt text if Secret Chat is enabled for this DM
    if (secretOn && room.kind === 'dm' && room.target && text) {
      try {
        const enc = await E2E.encryptFor(room.target.id, text);
        payload.text = '';
        payload.encrypted = true;
        payload.cipher = enc.cipher;
        payload.iv = enc.iv;
      } catch (err) {
        toast(err.message || 'Encryption failed — turn off Secret Chat or wait for peer.', 'error');
        return;
      }
    }
    if (disappearMs > 0) payload.disappearAfterMs = disappearMs;

    input.value = ''; input.style.height = 'auto';
    const sentAttach = State.attach;
    const sentReply = State.replyTo;
    clearAttach();
    clearReply();
    try {
      const data = await api('/messages/send', { method: 'POST', body: payload });
      // Preload local cache so our own encrypted bubble shows plaintext immediately
      if (payload.encrypted && data.message && data.message.id) {
        _e2eDecryptCache.set(data.message.id, text);
        data.message._decrypted = text;
      }
      upsertMessageInState(data.message);
      State.messages = dedupeMessagesById(State.messages);
      lastMessagesSignature = '';
      renderMessages(true);
    } catch (err) {
      // Translate generic 500s into something the user understands
      let msg = err.message || 'Send failed';
      if (err && err.status === 500) msg = 'Server error — message not sent. Please try again.';
      else if (msg === 'Network error' || msg === 'Network timeout') msg = 'No connection — message not sent';
      toast(msg, 'error');
      // Restore the composer with the text the user just typed
      input.value = text;
      State.attach = sentAttach;
      State.replyTo = sentReply;
      if (sentAttach) showAttachPreview(sentAttach);
      if (sentReply) {
        $('#replyToName').textContent = '@' + sentReply.username;
        $('#replyToText').textContent = sentReply.text;
        $('#replyBanner').classList.remove('hidden');
      }
    }
  });

  $('#cancelReplyBtn').addEventListener('click', clearReply);
  $('#cancelAttachBtn').addEventListener('click', clearAttach);

  let mediaRecorder = null;
  let audioChunks = [];
  const micBtn = $('#micBtn');
  micBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      micBtn.classList.remove('recording');
      micBtn.innerHTML = '<i data-lucide="mic"></i>';
      refreshIcons();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];
      mediaRecorder.addEventListener('dataavailable', e => {
        if (e.data.size > 0) audioChunks.push(e.data);
      });
      mediaRecorder.addEventListener('stop', async () => {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        stream.getTracks().forEach(t => t.stop());
        if (audioBlob.size < 100) return;
        const reader = new FileReader();
        reader.onload = async () => {
          const base64data = reader.result;
          try {
            const data = await api('/upload-photo', { method: 'POST', body: { dataUrl: base64data, kind: 'media' } });
            State.attach = { file: new File([audioBlob], 'voice_note.webm', {type:'audio/webm'}), url: data.url, isAudio: true };
            showAttachPreview(State.attach);
          } catch(e) { toast('Audio upload failed', 'error'); }
        };
        reader.readAsDataURL(audioBlob);
      });
      mediaRecorder.start();
      micBtn.classList.add('recording');
      micBtn.innerHTML = '<i data-lucide="square" style="color:red"></i>';
      refreshIcons();
    } catch (err) {
      toast('Microphone access denied', 'error');
    }
  });

  $('#attachBtn').addEventListener('click', () => {
    $('#fileInput').click();
    const addMenu = $('#composerAddMenu'); if (addMenu) addMenu.classList.add('hidden');
  });
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    await handleAttach(f);
  });

  const addBtn = $('#composerAddBtn');
  const addMenu = $('#composerAddMenu');
  if (addBtn && addMenu) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!addMenu.contains(e.target) && e.target !== addBtn) addMenu.classList.add('hidden');
    });
    addMenu.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => addMenu.classList.add('hidden'));
    });
  }

  const moreBtn = $('#chatMoreMenuBtn');
  const moreDrop = $('#chatMoreDropdown');
  if (moreBtn && moreDrop) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreDrop.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!moreDrop.contains(e.target) && e.target !== moreBtn) moreDrop.classList.add('hidden');
    });
    moreDrop.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => moreDrop.classList.add('hidden'));
    });
  }

  const scroller = $('#messagesScroll');
  scroller.addEventListener('scroll', () => {
    const atBottom = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 80;
    lastMessagesScrollAtBottom = atBottom;
    $('#scrollBottomBtn').classList.toggle('hidden', atBottom);
  });
  $('#scrollBottomBtn').addEventListener('click', () => {
    scroller.scrollTop = scroller.scrollHeight;
  });
}

async function handleAttach(file) {
  if (!file.type.startsWith('image/')) { toast('Only image files', 'error'); return; }
  if (file.size > 15 * 1024 * 1024) { toast('Max 15MB', 'error'); return; }
  const localUrl = URL.createObjectURL(file);
  $('#attachThumb').src = localUrl;
  $('#attachName').textContent = file.name + ' · uploading…';
  $('#attachProgress').style.width = '0%';
  $('#attachPreview').classList.remove('hidden');
  try {
    // Permanent GitHub-CDN upload preferred
    const res = await uploadPermanentImage(file, { kind: 'post', maxDim: 1200, quality: 0.82, onProgress: (p) => { $('#attachProgress').style.width = p + '%'; }});
    State.attach = { url: res.url, name: file.name, size: file.size };
    $('#attachName').textContent = file.name + (res.persisted ? ' · ready (permanent)' : ' · ready');
    $('#attachProgress').style.width = '100%';
    refreshIcons();
  } catch (err) {
    // Fallback to tmpfiles temporary host
    try {
      const res2 = await uploadImage(file, (p) => { $('#attachProgress').style.width = p + '%'; });
      State.attach = { url: res2.url, name: res2.name, size: res2.size };
      $('#attachName').textContent = file.name + ' · ready (temp)';
      $('#attachProgress').style.width = '100%';
    } catch (err2) {
      toast('Upload failed: ' + (err2.message || err.message), 'error');
      clearAttach();
    }
  }
}

function showAttachPreview(att) {
  const isAudio = att.isAudio || (att.file && att.file.type && att.file.type.startsWith('audio/')) || isAudioAttachmentUrl(att.url);
  
  const previewEl = $('#attachPreview');
  if (previewEl) previewEl.classList.toggle('audio-attach', !!isAudio);
  const imgEl = $('#attachThumb');
  let audioBox = $('#attachAudioBox');
  if (!audioBox && imgEl) {
    audioBox = document.createElement('div');
    audioBox.id = 'attachAudioBox';
    imgEl.parentElement.insertBefore(audioBox, imgEl.nextSibling);
  }
  const infoEl = imgEl ? imgEl.parentElement.querySelector('.attach-info') : null;

  if (isAudio) {
    if (imgEl) imgEl.style.display = 'none';
    if (infoEl) infoEl.style.display = 'none';
    if (audioBox) {
      audioBox.className = 'attach-audio-box';
      audioBox.style.display = 'block';
      audioBox.innerHTML = '';
      audioBox.appendChild(createVoiceNoteElement(att.url, true, { preview: true }));
    }
  } else {
    if (imgEl) {
      imgEl.style.display = 'block';
      imgEl.src = att.url;
    }
    if (infoEl) infoEl.style.display = '';
    if (audioBox) {
      audioBox.style.display = 'none';
      audioBox.innerHTML = '';
    }
    $('#attachName').textContent = (att.name || (att.file && att.file.name) || 'Image') + ' · ready';
  }
  $('#attachProgress').style.width = '100%';
  $('#attachPreview').classList.remove('hidden');
}

function clearAttach() {
  State.attach = null;
  $('#attachPreview').classList.add('hidden');
  $('#attachPreview').classList.remove('audio-attach');
  const imgEl = $('#attachThumb');
  if (imgEl) {
    imgEl.src = '';
    imgEl.style.display = 'block';
    const infoEl = imgEl.parentElement.querySelector('.attach-info');
    if (infoEl) infoEl.style.display = '';
  }
  const audioBox = $('#attachAudioBox'); if (audioBox) { audioBox.style.display = 'none'; audioBox.innerHTML = ''; }
  $('#attachName').textContent = '';
  $('#attachProgress').style.width = '0%';
}

// ====== Typing & Heartbeat ======
let lastTypingSent = 0;
async function sendTyping() {
  const now = Date.now();
  if (now - lastTypingSent < 2000) return;
  lastTypingSent = now;
  try { await api('/user/typing', { method: 'POST', body: { roomId: State.currentRoom.id } }); } catch (_) {}
}

async function pollTyping() {
  try {
    const data = await api('/user/typing?roomId=' + encodeURIComponent(State.currentRoom.id));
    State.typingUsers = data.typing || [];
    const el = $('#typingIndicator');
    if (State.typingUsers.length === 0) {
      el.classList.add('hidden');
    } else {
      const names = State.typingUsers.map(u => u.displayName || ('@' + u.username)).join(', ');
      $('#typingText').textContent = names + (State.typingUsers.length === 1 ? ' is typing…' : ' are typing…');
      el.classList.remove('hidden');
    }
    renderMembers();
  } catch (_) {}
}

async function sendHeartbeat() {
  try { await api('/user/heartbeat', { method: 'POST' }); } catch (_) {}
}

/* ========== Adaptive polling ========== */
// Fast poll mode: after any user interaction we boost polling cadence so things feel
// near-real-time even when SSE isn't available (Netlify Functions buffers SSE).
let _fastPollUntil = 0;
function boostPolling(durationMs = 30000) { _fastPollUntil = Date.now() + durationMs; }
function isFastPolling() { return Date.now() < _fastPollUntil; }

// Idle-aware polling: slow down dramatically when user isn't touching the screen.
// Saves battery + bandwidth on mobile; SSE handles real-time when active.
let _lastUserActivity = Date.now();
['scroll', 'touchstart', 'mousedown', 'keydown', 'pointerdown'].forEach(evt => {
  document.addEventListener(evt, () => { _lastUserActivity = Date.now(); }, { passive: true });
});
function isUserIdle() { return Date.now() - _lastUserActivity > 30000; }
// Poll cadence multiplier: 1× when active, 3× when idle (3× slower)
function pollGap(activeMs, idleMs) { return isUserIdle() ? idleMs : activeMs; }

let _lastMsgPollAt = 0;
let _lastFeedPollAt = 0;
let _lastNotifPollAt = 0;
function isStorySurfaceOpen() {
  const ids = ['storyEditorModal', 'storyViewer', 'storyTextEditorScreen', 'storyMusicSheet', 'closeFriendsSheet', 'storyManageSheet'];
  return ids.some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}
function startPolls() {
  sendHeartbeat();
  loadMembers();
  pollTyping();
  pollNotifications();
  pollRTCSignals();
  State.pollTimers.hb = setInterval(sendHeartbeat, 20000);
  State.pollTimers.members = setInterval(() => {
    if (isStorySurfaceOpen()) return;
    loadMembers();
  }, 15000);
  // MESSAGES: keep a polling backstop on Cloudflare Pages/Workers because an
  // EventSource connection and the write request can land on different isolates.
  State.pollTimers.msg = setInterval(() => {
    if (State.currentTab !== 'chat') return;
    if (isStorySurfaceOpen()) return;
    if (_sseConnected && !_sseNeedsPollingBackstop) return;
    if (isUserIdle()) return; // skip entirely when idle — SSE handles it
    const now = Date.now();
    const minGap = pollGap(isFastPolling() ? 2000 : 4500, 15000);
    if ((now - _lastMsgPollAt) < minGap) return;
    _lastMsgPollAt = now;
    loadMessages(false);
  }, 1500);
  State.pollTimers.typing = setInterval(() => {
    if (State.currentTab !== 'chat') return;
    if (isStorySurfaceOpen()) return;
    if (isUserIdle()) return;
    pollTyping();
  }, 2500);
  // FEED: same safety-net logic as chat so posts still appear even if SSE misses an event.
  // Also make boostPolling() truly dynamic instead of locking the interval at startup.
  State.pollTimers.feed = setInterval(() => {
    if (State.currentTab !== 'feed') return;
    if (isStorySurfaceOpen()) return;
    if (_sseConnected && !_sseNeedsPollingBackstop) return;
    const now = Date.now();
    const minGap = pollGap(isFastPolling() ? 2500 : 5000, 15000);
    if ((now - _lastFeedPollAt) < minGap) return;
    _lastFeedPollAt = now;
    loadFeed();
  }, 1500);
  // NOTIFICATIONS: same dynamic fast-poll behavior as the feed.
  State.pollTimers.notif = setInterval(() => {
    if (isStorySurfaceOpen()) return;
    if (_sseConnected && !_sseNeedsPollingBackstop) return;
    const now = Date.now();
    const minGap = pollGap(isFastPolling() ? 3000 : 6000, 20000);
    if ((now - _lastNotifPollAt) < minGap) return;
    _lastNotifPollAt = now;
    pollNotifications();
  }, 2000);
  // RTC call signaling — poll every 1.5s for fast call pickup regardless of idle state
  State.pollTimers.rtc = setInterval(() => {
    if (isStorySurfaceOpen()) return;
    pollRTCSignals();
  }, 1500);
  // Try SSE — it'll auto-fall-back if not supported
  connectSSE();
}

/* ========== Real-time Server-Sent Events ========== */
let _sseConnected = false;
// Cloudflare Pages/Workers can route concurrent requests to different isolates,
// so the in-memory SSE fan-out may miss some events. Keep polling as a safety net.
const _sseNeedsPollingBackstop =
  location.hostname.endsWith('.pages.dev') || location.hostname.endsWith('.workers.dev');
let _sseSource = null;
let _sseLastEventId = null;
let _sseReconnectTimer = null;
let _sseAttempts = 0;

/**
 * Connect SSE. Falls back gracefully on serverless hosts that buffer streaming responses
 * (e.g. Netlify Functions on AWS Lambda). If we don't see ANY data within 3s of opening,
 * we mark it unsupported and rely on the aggressive polling fallback.
 */
function connectSSE() {
  if (!State.token) return;
  if (!('EventSource' in window)) return;
  if (_sseUnsupported) return;
  disconnectSSE();
  const url = '/api/stream?token=' + encodeURIComponent(State.token)
            + (_sseLastEventId ? '&lastEventId=' + encodeURIComponent(_sseLastEventId) : '');
  try {
    _sseSource = new EventSource(url);
  } catch (e) {
    console.warn('[sse] failed', e.message);
    _sseUnsupported = true;
    return;
  }
  // Fallback detection: if no `open` event within 3s, assume host doesn't support streaming
  const probeTimer = setTimeout(() => {
    if (!_sseConnected) {
      console.warn('[sse] no data within 3s — likely buffered by host; falling back to polling');
      _sseUnsupported = true;
      disconnectSSE();
      updateRealtimeStatus();
    }
  }, 3000);
  _sseSource.addEventListener('open', () => {
    clearTimeout(probeTimer);
    _sseConnected = true; _sseAttempts = 0;
    updateRealtimeStatus();
    console.log('[sse] connected');
  });
  const onAny = (type, e) => {
    clearTimeout(probeTimer);
    if (!_sseConnected) { _sseConnected = true; updateRealtimeStatus(); }
    if (e.lastEventId) _sseLastEventId = e.lastEventId;
    let data = null;
    try { data = JSON.parse(e.data); } catch (_) {}
    if (!data) return;
    handleRealtimeEvent(type, data);
  };
  ['notification','new_message','new_post','presence','typing','rtc_signal'].forEach(t => {
    _sseSource.addEventListener(t, (e) => onAny(t, e));
  });
  _sseSource.addEventListener('error', () => {
    _sseConnected = false;
    updateRealtimeStatus();
    if (_sseSource) { try { _sseSource.close(); } catch (_) {} _sseSource = null; }
    if (_sseUnsupported) return;
    _sseAttempts = Math.min(_sseAttempts + 1, 5);
    const backoff = Math.min(8000, 500 * Math.pow(2, _sseAttempts));
    if (_sseReconnectTimer) clearTimeout(_sseReconnectTimer);
    _sseReconnectTimer = setTimeout(connectSSE, backoff);
  });
}
let _sseUnsupported = false;

function disconnectSSE() {
  _sseConnected = false;
  if (_sseSource) { try { _sseSource.close(); } catch (_) {} _sseSource = null; }
  if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
}

function handleRealtimeEvent(type, evt) {
  const data = evt.data || {};
  if (type === 'new_message') {
    const msg = data.message; if (!msg) return;
    // Only render if user is currently viewing that room
    if (msg.roomId === State.currentRoom.id) {
      // Merge by id. This avoids the brief duplicate bubble that can happen
      // when SSE receives the same voice note before the send request resolves.
      upsertMessageInState(msg);
      State.messages = dedupeMessagesById(State.messages);
      lastMessagesSignature = '';
      renderMessages(false);
    }
    // Bust message cache so a manual switch will reload fresh
    if (_apiCache) {
      for (const k of [..._apiCache.keys()]) {
        if (k.startsWith('/messages')) _apiCache.delete(k);
      }
    }
    // Trigger notification refresh (chat dot)
    pollNotifications();
  } else if (type === 'new_post') {
    const post = data.post; if (!post) return;
    if (!State.posts.some(p => p.id === post.id)) {
      State.posts.unshift(post);
      lastPostsSignature = null; // force next loadPosts() to re-render even if list becomes empty
      if (State.currentTab === 'feed') { loadFeed(); renderPosts(); }
    }
    pollNotifications();
  } else if (type === 'notification') {
    // Refresh badge counts + show OS push notification if granted+inactive tab
    pollNotifications();
    maybeNativeNotify(data);
    // If it's a like/comment on a post, refresh feed so new counts/comments appear live
    if ((data.kind === 'like' || data.kind === 'comment') && data.postId) {
      if (_apiCache) {
        for (const k of [..._apiCache.keys()]) {
          if (k.startsWith('/posts')) _apiCache.delete(k);
        }
      }
      boostPolling(15000);
      if (State.currentTab === 'feed') loadFeed(true);
    }
  } else if (type === 'presence' || type === 'typing') {
    // Refresh members
    loadMembers();
  } else if (type === 'rtc_signal') {
    handleRTCSignal(data);
  }
}

function maybeNativeNotify(data) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // don't notify while user is actively viewing
  if (localStorage.getItem('ps_pushEnabled') !== '1') return;
  const from = (data.fromSnapshot && data.fromSnapshot.username) || 'Someone';
  let title = 'PRIV SPACA', body = '';
  if (data.kind === 'like')    body = `${from} liked your post`;
  if (data.kind === 'comment') body = `${from} commented: ${(data.text || '').slice(0, 80)}`;
  if (data.kind === 'follow')  body = `${from} started following you`;
  if (data.kind === 'message') body = `${from}: ${(data.text || '').slice(0, 80)}`;
  if (!body) return;
  try {
    const n = new Notification(title, {
      body, tag: 'priv-spaca-' + data.notifId,
      icon: '/manifest.json',
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) {}
}

/* ========== Notification dots ========== */
// "lastSeen" timestamps stored per-tab in localStorage.
// chat dot = any new message in #general-group or in any DM room I belong to,
//           created AFTER lastSeenChatAt AND not authored by me.
// feed dot = any post-like or post-comment on MY posts created AFTER lastSeenFeedAt,
//           OR any new post by someone else AFTER lastSeenFeedAt
//           OR any unviewed story (= a member's latest post the user hasn't opened).
function _getLastSeen(key) {
  const v = parseInt(localStorage.getItem(key) || '0', 10);
  return isNaN(v) ? 0 : v;
}
function _setLastSeen(key, ts) { try { localStorage.setItem(key, String(ts || Date.now())); } catch (_) {} }

function markTabSeen(tab) {
  const now = Date.now();
  if (tab === 'chat') _setLastSeen('ps_seenChatAt', now);
  if (tab === 'feed') _setLastSeen('ps_seenFeedAt', now);
  updateNotifDots();
}

let _lastNotif = { chatUnread: 0, feedUnread: 0 };
let _lastPostsLoadedAt = 0;
let _lastFollowNotifSig = '';
async function pollNotifications() {
  if (!State.token || !State.user) return;
  const meId = State.user.id;
  let chatUnread = 0, feedUnread = 0, headerUnread = 0;

  // 1) Server-side notifications (authoritative for like/comment/follow/message)
  try {
    const r = await api('/notifications');
    _notifData = r;
    headerUnread = r.unread || 0;
    (r.notifications || []).forEach(n => {
      if (n.seenAt) return;
      if (n.kind === 'message') chatUnread++;
      else feedUnread++;   // like / comment / follow → home dot
    });
    const followSig = (r.notifications || []).filter(n => n.kind === 'follow')
      .map(n => `${n.fromUserId || ''}:${n.createdAt || 0}`).sort().join('|');
    if (followSig !== _lastFollowNotifSig) {
      _lastFollowNotifSig = followSig;
      await loadMembers();
      if (State.currentTab === 'profile') updateOwnProfileStatCounts(State.user);
    }
  } catch (_) {}

  // 2) New general-group messages (client tracks per-tab lastSeen so unread is true unread)
  const seenChat = _getLastSeen('ps_seenChatAt') || (Date.now() - 24*3600*1000);
  try {
    const r = await api('/messages?roomId=general-group');
    (r.messages || []).forEach(m => {
      if (m.userId !== meId && m.createdAt > seenChat) chatUnread++;
    });
  } catch (_) {}

  // 3) Keep posts cached for stories rail + saved tab, but avoid re-fetching
  // them on every notification poll if we already refreshed recently.
  try {
    if (!_lastPostsLoadedAt || (Date.now() - _lastPostsLoadedAt) > 10000) {
      const r = await api('/posts');
      State.posts = r.posts || State.posts;
      _lastPostsLoadedAt = Date.now();
    }
  } catch (_) {}

  // 4) Unviewed active stories add to the feed dot
  try {
    (State.members || []).forEach(u => {
      if (u.id === meId) return;
      const theirLatestStory = getLatestStory(u.id);
      if (theirLatestStory && !isStoryViewed(u.id)) feedUnread++;
    });
  } catch (_) {}

  _lastNotif.chatUnread = chatUnread;
  _lastNotif.feedUnread = feedUnread;
  _lastNotif.headerUnread = headerUnread;
  updateNotifDots();
}

function updateNotifDots() {
  const showChat = (_lastNotif.chatUnread > 0) && (State.currentTab !== 'chat');
  const showFeed = (_lastNotif.feedUnread > 0) && (State.currentTab !== 'feed');
  // Top-bar heart icon shows red dot if any unread server notification
  const showHeader = (_lastNotif.headerUnread || 0) > 0;
  $$('[data-dot="chat"]').forEach(d => {
    const wasHidden = d.classList.contains('hidden');
    d.classList.toggle('hidden', !showChat);
    if (wasHidden && showChat) popIn(d, { duration: 0.32 });
  });
  $$('[data-dot="chat-top"]').forEach(d => {
    const wasHidden = d.classList.contains('hidden');
    d.classList.toggle('hidden', !showChat);
    if (wasHidden && showChat) popIn(d, { duration: 0.32 });
  });
  $$('[data-dot="feed"]').forEach(d => {
    const wasHidden = d.classList.contains('hidden');
    d.classList.toggle('hidden', !showFeed);
    if (wasHidden && showFeed) popIn(d, { duration: 0.32 });
  });
  // Top-bar heart icon dot (data-dot="feed-top") = headerUnread (server notifications)
  $$('[data-dot="feed-top"]').forEach(d => {
    const wasHidden = d.classList.contains('hidden');
    d.classList.toggle('hidden', !showHeader);
    if (wasHidden && showHeader) popIn(d, { duration: 0.32 });
  });
}

// ====== Feed ======
// Sentinel (null, not '') so the very first load — where a brand-new user has
// zero posts and the freshly-fetched signature is also '' — doesn't get
// treated as "unchanged" and skip renderPosts()/renderStoriesRail(). Without
// this fix, a new/empty account never sees the "Your story" cell appear.
let lastPostsSignature = null;
let _loadPostsPromise = null;
async function loadPosts(force = false) {
  if (_loadPostsPromise) return _loadPostsPromise;
  if (!force && _lastPostsLoadedAt && (Date.now() - _lastPostsLoadedAt) < 2500 && lastPostsSignature !== null) {
    if ($('#feedList') && $('#feedList').children.length === 0) renderPosts();
    return State.posts;
  }
  _loadPostsPromise = (async () => {
    try {
      const data = await api('/posts');
      const newPosts = data.posts || [];
      _lastPostsLoadedAt = Date.now();
      const sig = newPosts.map(p => p.id + ':' + p.likeCount + ':' + p.commentCount).join('|');
      if (lastPostsSignature !== null && sig === lastPostsSignature) return State.posts;
      lastPostsSignature = sig;
      State.posts = newPosts;
      renderPosts();
      return State.posts;
    } catch (_) {
      return State.posts;
    } finally {
      _loadPostsPromise = null;
    }
  })();
  return _loadPostsPromise;
}

// Optimized feed loader — uses the hybrid Turso fan-out endpoint for the
// main feed view.  Falls back gracefully to /api/posts when Turso is down.
// State.feedPosts holds the ranked feed; State.posts still holds ALL posts
// (used by stories rail, profile grid, notifications).
let _lastFeedLoadedAt = 0;
let _loadFeedPromise = null;
async function loadFeed(force = false) {
  if (_loadFeedPromise) return _loadFeedPromise;
  if (!force && _lastFeedLoadedAt && (Date.now() - _lastFeedLoadedAt) < 3000 && lastPostsSignature !== null) {
    return State.feedPosts || State.posts;
  }
  _loadFeedPromise = (async () => {
    try {
      const data = await api('/feed');
      const feedPosts = data.posts || [];
      _lastFeedLoadedAt = Date.now();
      State.feedPosts = feedPosts;
      // Merge feed posts into State.posts so stories rail + profile still work
      const existingIds = new Set(State.posts.map(p => p.id));
      feedPosts.forEach(p => { if (!existingIds.has(p.id)) State.posts.push(p); });
      renderPosts();
      return feedPosts;
    } catch (_) {
      // Fallback: if /api/feed fails, loadPosts() covers us
      if (!State.posts.length) await loadPosts(true);
      return State.feedPosts || State.posts;
    } finally {
      _loadFeedPromise = null;
    }
  })();
  return _loadFeedPromise;
}

const STORY_TTL_MS = 24 * 60 * 60 * 1000;
function isStoryRecord(p) {
  if (!p || p.deletedAt) return false;
  return !!(p.story === true || p.kind === 'story' || p.storyExpiresAt);
}
function storyExpiresAt(p) {
  return Number(p && p.storyExpiresAt) || ((p && p.createdAt) ? (p.createdAt + STORY_TTL_MS) : 0);
}
function isActiveStoryPost(p) {
  return isStoryRecord(p) && storyExpiresAt(p) > Date.now();
}
function getStoryPosts(userId = null) {
  return (State.posts || [])
    .filter(p => isActiveStoryPost(p) && (!userId || p.userId === userId))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
function getLatestStory(userId) {
  return getStoryPosts(userId)[0] || null;
}
function hasActiveStory(userId) {
  return !!getLatestStory(userId);
}
function getFeedPosts() {
  // Use the optimized feed (from /api/feed) when available; fall back to all posts
  const source = (State.feedPosts && State.feedPosts.length) ? State.feedPosts : State.posts;
  return source.filter(p => !isStoryRecord(p));
}

// "Stories" are kept separate from the main feed.
let _storiesRendered = false;
let _lastStoriesSig = '';
function renderStoriesRail() {
  const rail = $('#storiesRail');
  if (!rail || !State.user) return;
  const members = State.members || [];
  const meId = State.user.id;
  const me = members.find(m => m.id === meId) || State.user;
  const others = members
    .filter(m => m.id !== meId && hasActiveStory(m.id))
    .sort((a, b) => {
      const bt = (getLatestStory(b.id)?.createdAt || 0) - (getLatestStory(a.id)?.createdAt || 0);
      if (bt !== 0) return bt;
      return (b.online ? 1 : 0) - (a.online ? 1 : 0);
    });
  const hasMine = hasActiveStory(meId);
  const sig = [me && me.id + ':' + (hasMine ? '1' : '0'), ...others.map(o => o.id + ':' + (isStoryViewed(o.id) ? 'v' : 'u'))].join('|');
  if (sig === _lastStoriesSig && rail.children.length > 0) return;
  _lastStoriesSig = sig;
  rail.style.display = '';
  rail.innerHTML = '';
  rail.appendChild(buildStoryCell(me, true));
  others.forEach(m => rail.appendChild(buildStoryCell(m, false)));
  if (!_storiesRendered) {
    _storiesRendered = true;
    staggerIn([...rail.children], { delayPer: 0.05 });
  }
}

function buildStoryCell(user, isMe) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'story-cell' + (isMe ? ' me' : '');
  const ring = document.createElement('div');
  const hasStory = !!(user && hasActiveStory(user.id));
  const viewed = !isMe && isStoryViewed(user.id);
  ring.className = 'story-ring' + (isMe ? ' is-me' : (viewed ? ' viewed' : ''));
  if (!hasStory && !isMe) ring.classList.add('viewed');
  const inner = document.createElement('div');
  inner.className = 'avatar-inner';
  const url = user && user.photoUrl;
  const seed = user ? (user.username || user.displayName || user.id || '?') : '?';
  const setInitials = () => {
    inner.style.backgroundImage = '';
    inner.style.backgroundColor = colorOf(seed);
    inner.textContent = initialsOf(user ? (user.displayName || user.username) : '?');
  };
  if (url && !_brokenPhotoUrls.has(url)) {
    inner.style.backgroundImage = `url("${String(url).replace(/"/g, '%22')}")`;
    const probe = new Image();
    probe.onerror = () => { _markPhotoBroken(url); setInitials(); };
    probe.src = url;
  } else {
    setInitials();
  }
  ring.appendChild(inner);
  if (isMe) {
    const badge = document.createElement('span');
    badge.className = 'add-badge';
    badge.textContent = '+';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof openStoryCreator === 'function') openStoryCreator();
    });
    ring.appendChild(badge);
  }
  cell.appendChild(ring);
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  if (isMe) lbl.textContent = 'Your story'; else lbl.innerHTML = displayNameWithOwnerBadge(user, user.username || user.displayName || '', 'inline');
  cell.appendChild(lbl);
  cell.addEventListener('click', () => {
    if (isMe) {
      if (hasStory) openStoryFor(user);
      else if (typeof openStoryCreator === 'function') openStoryCreator();
      else { const ta = $('#postInput'); if (ta) ta.focus(); }
    } else if (hasStory) {
      openStoryFor(user);
    }
  });
  return cell;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 30) return 'now';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd';
  const w = Math.floor(d / 7);
  if (w < 5) return w + 'w';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function postDateLabel(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString([], { month: 'long', day: 'numeric' }).toUpperCase();
}

let _previousPostIds = new Set();
let _postCardCache = new Map(); // id -> { card, sig } so we only re-render when a post's data actually changed
function _postCardSignature(p) {
  // Anything visible on the card that can change:
  return [
    p.id,
    p.likeCount || (p.likes || []).length,
    p.commentCount || (p.comments || []).length,
    (p.likes || []).join(','),  // who liked (for "liked by"/dot)
    p.text || '',
    p.imageUrl || '',
  ].join('|');
}

function renderPosts() {
  renderStoriesRail();
  const list = $('#feedList');
  const meId = State.user && State.user.id;
  const feedPosts = getFeedPosts();
  const currentIds = new Set(feedPosts.map(p => p.id));
  const newOnes = new Set();
  currentIds.forEach(id => { if (!_previousPostIds.has(id)) newOnes.add(id); });
  const isFirstRender = _previousPostIds.size === 0;

  // ===== Smart incremental DOM diff (no flicker) =====
  // 1) Remove cards no longer in State.posts
  Array.from(list.children).forEach(child => {
    const id = child.dataset && child.dataset.id;
    if (id && !currentIds.has(id)) {
      child.remove();
      _postCardCache.delete(id);
    }
  });

  // Handle empty state
  if (feedPosts.length === 0) {
    list.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.innerHTML = `
      <div class="icon"><i data-lucide="newspaper"></i></div>
      <div class="title">Nothing here yet</div>
      <div class="sub">Share the first post with the community!</div>
    `;
    list.appendChild(e);
    springIn(e);
    _previousPostIds = currentIds;
    refreshIcons();
    return;
  } else {
    // Remove any leftover empty-state node
    const emptyState = list.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
  }

  // 2) For each post in order, ensure the right card is at the right position
  feedPosts.forEach((p, idx) => {
    const sig = _postCardSignature(p);
    let cached = _postCardCache.get(p.id);
    let card;
    if (cached && cached.sig === sig && cached.card.isConnected) {
      // Unchanged — reuse
      card = cached.card;
    } else {
      // Changed (or new) — build (or rebuild) the card
      card = renderPost(p);
      _postCardCache.set(p.id, { card, sig });
    }
    // Ensure correct position in DOM
    const existing = list.children[idx];
    if (existing !== card) {
      list.insertBefore(card, existing || null);
    }
    // Animate ONLY truly new posts (not reused or rebuilt-on-change)
    if (newOnes.has(p.id) && !isFirstRender) slideUp(card);
    else if (isFirstRender) springIn(card, { delay: 0.04 * Math.min(idx, 6) });
  });

  _previousPostIds = currentIds;
  refreshIcons();
  syncPostMusicUI();
}

function attachScratchOverlay(wrap) {
  const overlay = document.createElement('div');
  overlay.className = 'scratch-overlay';
  overlay.style.cssText = 'position:absolute; inset:0; z-index:5; display:flex; align-items:center; justify-content:center; cursor:pointer; border-radius:18px; overflow:hidden; background:#334155;';
  
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%; height:100%; display:block;';
  overlay.appendChild(canvas);
  wrap.appendChild(overlay);

  const initCanvas = () => {
    const rect = overlay.getBoundingClientRect();
    const w = Math.round(rect.width || wrap.clientWidth || 350);
    const h = Math.round(rect.height || wrap.clientHeight || 350);
    if (w < 50 || h < 50) return;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#334155'); grad.addColorStop(0.5, '#64748b'); grad.addColorStop(1, '#1e293b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (let i = 20; i < w; i += 25) {
      for (let j = 20; j < h; j += 25) {
        if ((i + j) % 50 === 0) { ctx.beginPath(); ctx.arc(i, j, 2, 0, Math.PI * 2); ctx.fill(); }
      }
    }

    const bw = Math.min(230, w - 30);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath();
    ctx.roundRect(w/2 - bw/2, h/2 - 20, bw, 40, 20);
    ctx.fill();
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 13px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('✨ Scratch to Reveal! ✨', w/2, h/2);
  };

  const img = wrap.querySelector('img');
  if (img && !img.complete) {
    img.addEventListener('load', initCanvas, { once: true });
  } else {
    setTimeout(initCanvas, 150);
  }

  let isScratching = false;
  let canvasInited = false;
  const scratchAt = (pos) => {
    if (!canvasInited || canvas.width < 50) { initCanvas(); canvasInited = true; }
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 38, 0, Math.PI * 2);
    ctx.fill();
  };

  const checkDone = () => {
    try {
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let cleared = 0, total = 0;
      for (let i = 3; i < data.length; i += 4 * 120) { total++; if (data[i] === 0) cleared++; }
      if (total > 0 && cleared / total > 0.38) {
        overlay.style.transition = 'opacity 0.5s ease';
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        setTimeout(() => overlay.remove(), 500);
      }
    } catch (_) {}
  };

  const getPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
    const cy = e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY;
    return { x: cx - rect.left, y: cy - rect.top };
  };

  const start = (e) => { isScratching = true; scratchAt(getPos(e)); };
  const move = (e) => { if (!isScratching) return; scratchAt(getPos(e)); };
  const end = () => { if (isScratching) { isScratching = false; checkDone(); } };

  canvas.addEventListener('mousedown', start);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start, { passive: true });
  canvas.addEventListener('touchmove', move, { passive: true });
  window.addEventListener('touchend', end);
}

let _postMusicPlayer = null;
const _postMusicState = { postId: null, src: '', title: '', artist: '' };
function getPostMusicPlayer() {
  if (_postMusicPlayer) return _postMusicPlayer;
  _postMusicPlayer = new Audio();
  _postMusicPlayer.preload = 'metadata';
  _postMusicPlayer.playsInline = true;
  if (!_postMusicPlayer.__bound) {
    _postMusicPlayer.__bound = true;
    ['play', 'pause', 'ended'].forEach(evt => _postMusicPlayer.addEventListener(evt, () => syncPostMusicUI()));
  }
  return _postMusicPlayer;
}
function isPostMusicPlaying() {
  return !!(_postMusicPlayer && !_postMusicPlayer.paused && !_postMusicPlayer.ended && _postMusicState.postId);
}
function syncPostMusicUI() {
  const playing = isPostMusicPlaying();
  $$('.post-card').forEach(card => {
    const active = !!(card && card.dataset && card.dataset.id && card.dataset.id === _postMusicState.postId);
    card.classList.toggle('music-playing', active && playing);
    const btn = card.querySelector('.post-music-toggle');
    if (btn) {
      btn.classList.toggle('is-active', active);
      btn.classList.toggle('is-playing', active && playing);
      btn.setAttribute('aria-label', active && playing ? 'Mute post music' : 'Unmute post music');
      // Instagram-style audio control: show speaker when audio is on,
      // muted-speaker when this post's audio is off.
      btn.innerHTML = `<i data-lucide="${active && playing ? 'volume-2' : 'volume-x'}"></i>`;
    }
    const meta = card.querySelector('.post-music-inline');
    if (meta) meta.classList.toggle('is-playing', active && playing);
  });
  refreshIcons();
}
async function playPostMusic(p) {
  if (!p || !p.music || !p.music.audio) return;
  const player = getPostMusicPlayer();
  const storyPlayer = $('#storyBgAudioPlayer');
  if (storyPlayer && !storyPlayer.paused) storyPlayer.pause();
  // If the same track is already playing, do nothing
  if (player.src === p.music.audio && !player.paused) return;
  // IMPORTANT: stop any OTHER post's music before starting this one,
  // so only one post's music is audible at a time (Instagram-style).
  if (_postMusicState.postId && _postMusicState.postId !== p.id && !player.paused) {
    player.pause();
    player.currentTime = 0;
  }
  try {
    if (player.src !== p.music.audio) player.src = p.music.audio;
    player.currentTime = 0;
    _postMusicState.postId = p.id;
    _postMusicState.src = p.music.audio;
    _postMusicState.title = p.music.title || '';
    _postMusicState.artist = p.music.artist || '';
    await player.play();
    syncPostMusicUI();
  } catch (_) {
    console.warn('Autoplay blocked or failed', _);
  }
}

async function stopPostMusic(p) {
  const player = getPostMusicPlayer();
  // Stop the music if this post is the one currently playing —
  // handles scroll-away cleanly even when another post's playPostMusic
  // has already changed _postMusicState.postId (in which case the
  // player is already playing a different track, so this is a safe no-op).
  if (_postMusicState.postId === p.id && !player.paused) {
    player.pause();
    player.currentTime = 0;
    _postMusicState.postId = null;
    _postMusicState.src = '';
    _postMusicState.title = '';
    _postMusicState.artist = '';
    syncPostMusicUI();
  }
}

const postMusicObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const card = entry.target;
    const postId = card.dataset.id;
    const post = State.posts.find(p => p.id === postId);
    if (!post) return;
    if (entry.isIntersecting) {
      playPostMusic(post);
    } else {
      stopPostMusic(post);
    }
  });
}, { threshold: 0.6 });

// Scroll-based safety net: on every feed scroll, check whether the
// currently-playing music post card is still visible.  If the user
// scrolled it completely out of view, stop the music immediately.
// This catches edge cases where the IntersectionObserver (0.6 threshold)
// doesn't fire soon enough (fast flick-scroll, mobile momentum, etc.).
{
  const feedView = document.getElementById('feedView');
  if (feedView) {
    let _musicScrollTick = false;
    feedView.addEventListener('scroll', () => {
      if (_musicScrollTick) return;
      _musicScrollTick = true;
      requestAnimationFrame(() => {
        _musicScrollTick = false;
        if (!_postMusicState.postId || !_postMusicPlayer || _postMusicPlayer.paused) return;
        const card = document.querySelector('.post-card[data-id="' + _postMusicState.postId + '"]');
        if (!card) return;
        const rect = card.getBoundingClientRect();
        const viewRect = feedView.getBoundingClientRect();
        // If the card is completely above or below the visible feed area, stop.
        const fullyOut = rect.bottom < viewRect.top || rect.top > viewRect.bottom;
        if (fullyOut) {
          _postMusicPlayer.pause();
          _postMusicPlayer.currentTime = 0;
          _postMusicState.postId = null;
          _postMusicState.src = '';
          _postMusicState.title = '';
          _postMusicState.artist = '';
          syncPostMusicUI();
        }
      });
    }, { passive: true });
  }
}

async function togglePostMusic(p) {
  if (!p || !p.music || !p.music.audio) return;
  const player = getPostMusicPlayer();
  const storyPlayer = $('#storyBgAudioPlayer');
  if (storyPlayer && !storyPlayer.paused) storyPlayer.pause();
  const sameTrack = _postMusicState.postId === p.id && player.src === p.music.audio;
  try {
    if (sameTrack) {
      if (!player.paused && !player.ended) player.pause();
      else await player.play();
      syncPostMusicUI();
      return;
    }
    // Stop any other post's music before starting this one
    if (_postMusicState.postId && _postMusicState.postId !== p.id && !player.paused) {
      player.pause();
      player.currentTime = 0;
    }
    if (player.src !== p.music.audio) player.src = p.music.audio;
    player.currentTime = 0;
    _postMusicState.postId = p.id;
    _postMusicState.src = p.music.audio;
    _postMusicState.title = p.music.title || '';
    _postMusicState.artist = p.music.artist || '';
    await player.play();
    syncPostMusicUI();
  } catch (_) {
    toast('Could not play post music', 'error');
  }
}

function renderPost(p) {
  const card = document.createElement('article');
  card.className = 'post-card';
  card.dataset.id = p.id;

  const author = resolveAuthor(p.author, p.userId, p.authorSnapshot);
  const meId = State.user && State.user.id;
  const isMine = p.userId === meId;
  const liked = Array.isArray(p.likes) && p.likes.includes(meId);
  const saved = !!getSaved()[p.id];

  const buildHead = () => {
    const head = document.createElement('div');
    head.className = 'post-header-row';
    const avRing = document.createElement('span');
    avRing.className = 'post-header-avatar';
    const av = document.createElement('span');
    av.className = 'avatar md';
    renderAvatar(av, author);
    avRing.appendChild(av);

    const meta = document.createElement('div');
    meta.className = 'post-header-info';
    const userLine = document.createElement('div');
    userLine.className = 'post-header-userline';
    const userName = document.createElement('span');
    userName.className = 'post-header-username';
    userName.textContent = author.username || author.displayName || 'member';
    userLine.appendChild(userName);
    if (isVerifiedUser(author)) {
      const badge = document.createElement('span');
      badge.className = 'post-verified-badge';
      badge.innerHTML = ownerVerifiedBadgeSvg('mini');
      userLine.appendChild(badge);
    }
    meta.appendChild(userLine);

    if (p.music && p.music.title) {
      const musicText = [p.music.title, p.music.artist].filter(Boolean).join(' · ');
      const musicLine = document.createElement('div');
      musicLine.className = 'post-music-inline' + (p.music.audio ? ' can-play' : '');
      musicLine.title = musicText;
      musicLine.innerHTML = `
        <i data-lucide="music-4"></i>
        <div class="post-music-marquee">
          <div class="post-music-marquee-track">
            <span>${escapeHtml(musicText)}</span>
            <span aria-hidden="true">${escapeHtml(musicText)}</span>
          </div>
        </div>
      `;
      meta.appendChild(musicLine);
    }

    const moreBtn = document.createElement('button');
    moreBtn.className = 'post-header-more';
    moreBtn.setAttribute('aria-label', 'More options');
    moreBtn.innerHTML = '<i data-lucide="more-vertical"></i>';
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openMoreMenu(p, isMine); });
    head.appendChild(avRing); head.appendChild(meta); head.appendChild(moreBtn);
    const openProfile = () => { if (p.userId !== (State.user && State.user.id)) openUserProfile(p.userId); else switchTab('profile'); };
    avRing.style.cursor = 'pointer';
    meta.style.cursor = 'pointer';
    avRing.addEventListener('click', (e) => { e.stopPropagation(); openProfile(); });
    meta.addEventListener('click', (e) => { e.stopPropagation(); openProfile(); });
    return head;
  };

  card.appendChild(buildHead());

  const imgs = Array.isArray(p.images) && p.images.length > 0 ? p.images : (p.imageUrl ? [p.imageUrl] : []);
  const attachMusicToggle = (wrap) => {
    if (!wrap || !p.music || !p.music.audio) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'post-music-toggle';
    btn.setAttribute('aria-label', 'Unmute post music');
    btn.innerHTML = '<i data-lucide="volume-x"></i>';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await togglePostMusic(p);
    });
    wrap.appendChild(btn);
  };

  // Image with double-tap to like
  if (imgs.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'post-img-wrap';
    if (p.music && p.music.audio) wrap.classList.add('has-post-music');

    const burst = document.createElement('div');
    burst.className = 'heart-burst';
    burst.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.35-7-10a4.5 4.5 0 0 1 8-2.83A4.5 4.5 0 0 1 21 11c0 5.65-9 10-9 10z"/></svg>';

    if (imgs.length === 1) {
      const img = lazyImg(imgs[0], 'post image', p.id);
      img.className = 'post-img';
      img.addEventListener('error', () => { wrap.style.display = 'none'; });
      let lastTap = 0, tapTimer = null;
      img.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastTap < 300) {
          if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
          burst.classList.remove('show'); void burst.offsetWidth; burst.classList.add('show');
          motionAnimate(burst,
            { opacity: [0, 1, 1, 0], transform: ['translate(-50%, -50%) scale(.4)', 'translate(-50%, -50%) scale(1.15)', 'translate(-50%, -50%) scale(1.0)', 'translate(-50%, -50%) scale(1.25)'] },
            { duration: 0.85, easing: [0.2, 0.85, 0.2, 1] }
          );
          if (!Array.isArray(p.likes) || !p.likes.includes(meId)) toggleLike(p, card);
          lastTap = 0;
        } else {
          lastTap = now;
          if (tapTimer) clearTimeout(tapTimer);
          tapTimer = setTimeout(() => { openLightbox(imgs[0], author.displayName); }, 290);
        }
      });
      wrap.appendChild(img);
      wrap.appendChild(burst);
      attachMusicToggle(wrap);
      card.appendChild(wrap);
    } else {
      // Instagram Multi-Photo Carousel
      const track = document.createElement('div');
      track.className = 'ig-carousel-track';
      track.style.cssText = 'display:flex; overflow-x:auto; scroll-snap-type:x mandatory; scroll-behavior:smooth; width:100%; -webkit-overflow-scrolling:touch; scrollbar-width:none;';

      const badge = document.createElement('div');
      badge.className = 'ig-carousel-badge';
      badge.style.cssText = 'position:absolute; top:14px; right:14px; background:rgba(0,0,0,0.75); color:#fff; font-size:12px; font-weight:700; padding:4px 9px; border-radius:12px; z-index:3; pointer-events:none;';
      badge.textContent = `1/${imgs.length}`;
      wrap.appendChild(badge);
      wrap.appendChild(burst);

      imgs.forEach((url, idx) => {
        const slide = document.createElement('div');
        slide.style.cssText = 'flex:0 0 100%; width:100%; scroll-snap-align:start; position:relative; display:flex; align-items:center; justify-content:center; background:#000;';
        const img = lazyImg(url, `slide ${idx+1}`, `${p.id}_${idx}`);
        img.className = 'post-img';
        img.style.cssText = 'max-height:75vh; width:100%; object-fit:cover;';
        let lastTap = 0, tapTimer = null;
        img.addEventListener('click', () => {
          const now = Date.now();
          if (now - lastTap < 300) {
            if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
            burst.classList.remove('show'); void burst.offsetWidth; burst.classList.add('show');
            motionAnimate(burst,
              { opacity: [0, 1, 1, 0], transform: ['translate(-50%, -50%) scale(.4)', 'translate(-50%, -50%) scale(1.15)', 'translate(-50%, -50%) scale(1.0)', 'translate(-50%, -50%) scale(1.25)'] },
              { duration: 0.85, easing: [0.2, 0.85, 0.2, 1] }
            );
            if (!Array.isArray(p.likes) || !p.likes.includes(meId)) toggleLike(p, card);
            lastTap = 0;
          } else {
            lastTap = now;
            if (tapTimer) clearTimeout(tapTimer);
            tapTimer = setTimeout(() => { openLightbox(url, author.displayName); }, 290);
          }
        });
        slide.appendChild(img);
        track.appendChild(slide);
      });

      track.addEventListener('scroll', () => {
        const idx = Math.round(track.scrollLeft / (track.clientWidth || 1));
        badge.textContent = `${idx + 1}/${imgs.length}`;
        const dots = card.querySelectorAll('.ig-carousel-dot');
        dots.forEach((d, i) => d.style.background = (i === idx ? '#38bdf8' : 'rgba(255,255,255,0.3)'));
      });

      wrap.appendChild(track);
      attachMusicToggle(wrap);
      if (p.isScratch) attachScratchOverlay(wrap);
      card.appendChild(wrap);
    }
    if (imgs.length === 1 && p.isScratch) attachScratchOverlay(card.querySelector('.post-img-wrap'));
  } else if (p.videoUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'post-img-wrap';
    const vid = document.createElement('video');
    vid.className = 'post-img';
    vid.src = p.videoUrl;
    vid.controls = true;
    vid.playsInline = true;
    vid.preload = 'metadata';
    wrap.appendChild(vid);
    attachMusicToggle(wrap);
    card.appendChild(wrap);
  }

  // Action toolbar
  const actions = document.createElement('div');
  actions.className = 'post-actions';
  const left = document.createElement('div'); left.className = 'action-grp';
  const center = document.createElement('div'); center.className = 'action-grp'; center.style.cssText = 'display:flex; gap:5px; align-items:center; justify-content:center; flex:1;';
  const right = document.createElement('div'); right.className = 'action-grp';

  const likeBtn = document.createElement('button');
  likeBtn.className = 'act-btn like-btn' + (liked ? ' liked' : '');
  likeBtn.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
  likeBtn.innerHTML = '<i data-lucide="heart"></i>';
  likeBtn.addEventListener('click', () => toggleLike(p, card));

  const commentBtn = document.createElement('button');
  commentBtn.className = 'act-btn';
  commentBtn.setAttribute('aria-label', 'Comment');
  commentBtn.innerHTML = '<i data-lucide="message-circle"></i>';
  commentBtn.addEventListener('click', () => openCommentsSheet(p));

  const shareBtn = document.createElement('button');
  shareBtn.className = 'act-btn';
  shareBtn.setAttribute('aria-label', 'Share');
  shareBtn.innerHTML = '<i data-lucide="send"></i>';
  shareBtn.addEventListener('click', () => sharePost(p));

  const saveBtn = document.createElement('button');
  saveBtn.className = 'act-btn' + (saved ? ' saved' : '');
  saveBtn.setAttribute('aria-label', saved ? 'Unsave' : 'Save');
  saveBtn.innerHTML = '<i data-lucide="bookmark"></i>';
  saveBtn.addEventListener('click', () => toggleSaved(p, saveBtn));

  left.appendChild(likeBtn); left.appendChild(commentBtn); left.appendChild(shareBtn);
  if (imgs.length > 1) {
    imgs.forEach((_, idx) => {
      const dot = document.createElement('span');
      dot.className = 'ig-carousel-dot';
      dot.style.cssText = `width:6px; height:6px; border-radius:50%; background:${idx === 0 ? '#38bdf8' : 'rgba(255,255,255,0.3)'}; transition:all 0.2s;`;
      center.appendChild(dot);
    });
  }
  right.appendChild(saveBtn);
  actions.appendChild(left); actions.appendChild(center); actions.appendChild(right);
  card.appendChild(actions);


  // Liked-by row
  if (p.likeCount > 0) {
    const lb = document.createElement('div');
    lb.className = 'liked-by';
    const liker = State.members.find(m => p.likes && p.likes.includes(m.id));
    if (liker) {
      const stack = document.createElement('span');
      stack.className = 'stack';
      const a = document.createElement('span');
      a.className = 'avatar';
      renderAvatar(a, liker);
      stack.appendChild(a);
      lb.appendChild(stack);
    }
    const txt = document.createElement('span');
    txt.className = 'txt';
    if (liker && p.likeCount === 1) {
      txt.innerHTML = `Liked by <strong>${displayNameWithOwnerBadge(liker, liker.username, 'inline')}</strong>`;
    } else if (liker && p.likeCount > 1) {
      const others = p.likeCount - 1;
      txt.innerHTML = `Liked by <strong>${displayNameWithOwnerBadge(liker, liker.username, 'inline')}</strong> and <strong>${others} other${others === 1 ? '' : 's'}</strong>`;
    } else {
      txt.innerHTML = `<strong>${p.likeCount}</strong> ${p.likeCount === 1 ? 'like' : 'likes'}`;
    }
    lb.appendChild(txt);
    card.appendChild(lb);
  }

  // Caption
  if (p.text) {
    const cap = document.createElement('div');
    cap.className = 'post-caption';
    const isLong = p.text.length > 140;
    const visible = isLong ? p.text.slice(0, 140) : p.text;
    const authorSpan = document.createElement('span');
    authorSpan.className = 'author';
    authorSpan.innerHTML = displayNameWithOwnerBadge(author, author.username || author.displayName, 'inline');
    cap.appendChild(authorSpan);
    const txtNode = document.createTextNode(visible);
    cap.appendChild(txtNode);
    if (isLong) {
      cap.appendChild(document.createTextNode('… '));
      const more = document.createElement('button');
      more.className = 'more-link';
      more.textContent = 'more';
      more.addEventListener('click', () => {
        cap.removeChild(more);
        txtNode.nodeValue = p.text;
      });
      cap.appendChild(more);
    }
    card.appendChild(cap);
  }

  // View all comments + preview
  const cc = (p.comments || []).length;
  if (cc > 2) {
    const vc = document.createElement('button');
    vc.className = 'view-comments';
    vc.textContent = `View all ${cc} comments`;
    vc.addEventListener('click', () => openCommentsSheet(p));
    card.appendChild(vc);
  }
  if (cc > 0) {
    const pv = document.createElement('div');
    pv.className = 'preview-comments';
    p.comments.slice(-2).forEach(c => {
      const cAuth = resolveAuthor(c.author, c.userId, c.authorSnapshot);
      const row = document.createElement('div');
      row.className = 'preview-comment';
      const a = document.createElement('span'); a.className = 'author';
      a.innerHTML = displayNameWithOwnerBadge(cAuth, cAuth.username || cAuth.displayName, 'inline');
      row.appendChild(a);
      // Space between author and text (bug fix: was missing → "Anushkahi there")
      row.appendChild(document.createTextNode(' ' + (c.text || '')));
      pv.appendChild(row);
    });
    card.appendChild(pv);
  }

  // Time stamp
  const t = document.createElement('div');
  t.className = 'post-time';
  t.textContent = postDateLabel(p.createdAt);
  card.appendChild(t);

  // Inline comment composer
  const addRow = document.createElement('form');
  addRow.className = 'post-add-comment';
  addRow.addEventListener('submit', (e) => e.preventDefault());
  const emoji = document.createElement('button');
  emoji.type = 'button';
  emoji.className = 'emoji-btn';
  emoji.textContent = '😊';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.placeholder = 'Add a comment…'; inp.maxLength = 600;
  const sb = document.createElement('button');
  sb.type = 'submit'; sb.className = 'post-btn'; sb.textContent = 'Post'; sb.disabled = true;
  emoji.addEventListener('click', () => { inp.value += '😊'; inp.focus(); sb.disabled = !inp.value.trim(); });
  inp.addEventListener('input', () => { sb.disabled = !inp.value.trim(); });
  const submit = async () => {
    const text = inp.value.trim();
    if (!text) return;
    sb.disabled = true;
    try {
      const data = await api('/posts/comment', { method: 'POST', body: { postId: p.id, text } });
      inp.value = '';
      p.comments = p.comments || [];
      p.comments.push(data.comment);
      p.commentCount = (p.commentCount || 0) + 1;
      // Update the cached signature so the diff-renderer doesn't rebuild this card
      // and destroy the focused composer mid-typing on the next refresh.
      const cached = _postCardCache.get(p.id);
      if (cached) cached.sig = _postCardSignature(p);
      // Patch just the comment-related UI in place (no full rebuild)
      patchCommentUI(card, p);
      // If a comments sheet is open for this post, refresh it too
      if (activeCommentsPost && activeCommentsPost.id === p.id) openCommentsSheet(p);
      // Bump polling cadence so other clients see it quickly
      boostPolling(20000);
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { sb.disabled = !inp.value.trim(); }
  };
  sb.addEventListener('click', submit);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  addRow.appendChild(emoji); addRow.appendChild(inp); addRow.appendChild(sb);
  card.appendChild(addRow);

  // Music autoplay observer
  postMusicObserver.observe(card);
  return card;
}

async function toggleLike(p, card) {
  const meId = State.user && State.user.id;
  const wasLiked = Array.isArray(p.likes) && p.likes.includes(meId);
  // === Optimistic UI: update local state + DOM in-place immediately (no flicker) ===
  p.likes = Array.isArray(p.likes) ? p.likes.slice() : [];
  if (wasLiked) p.likes = p.likes.filter(x => x !== meId);
  else if (!p.likes.includes(meId)) p.likes.push(meId);
  p.likeCount = p.likes.length;
  patchLikeUI(card, p, meId);
  try {
    const data = await api('/posts/like', { method: 'POST', body: { postId: p.id } });
    // Sync with server's authoritative count (in case of race)
    p.likeCount = data.likeCount;
    patchLikeUI(card, p, meId);
    // Mark signature so the next poll comparison doesn't re-render unnecessarily
    lastPostsSignature = _computePostsSignature(State.posts);
  } catch (e) {
    // Roll back optimistic change
    if (wasLiked && !p.likes.includes(meId)) p.likes.push(meId);
    else p.likes = p.likes.filter(x => x !== meId);
    p.likeCount = p.likes.length;
    patchLikeUI(card, p, meId);
    toast(e.message || 'Failed', 'error');
  }
}

/** Update only the like button + "Liked by" row inside a post card; no full re-render. */
function patchLikeUI(card, p, meId) {
  if (!card) return;
  const liked = Array.isArray(p.likes) && p.likes.includes(meId);
  const btn = card.querySelector('.act-btn.like-btn') || card.querySelectorAll('.post-actions .act-btn')[0];
  if (btn) {
    btn.classList.toggle('liked', liked);
    btn.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
    // Pop animation only on a NEW like (not on unlike)
    if (liked) pulseEl(btn.querySelector('i') || btn);
  }
  // Update liked-by row
  let lb = card.querySelector('.liked-by');
  if (p.likeCount > 0) {
    if (!lb) {
      // Insert after actions
      const actions = card.querySelector('.post-actions');
      lb = document.createElement('div');
      lb.className = 'liked-by';
      if (actions) actions.insertAdjacentElement('afterend', lb);
      else card.appendChild(lb);
    }
    const liker = (State.members || []).find(m => p.likes && p.likes.includes(m.id));
    lb.innerHTML = '';
    if (liker) {
      const stack = document.createElement('span'); stack.className = 'stack';
      const a = document.createElement('span'); a.className = 'avatar';
      renderAvatar(a, liker);
      stack.appendChild(a);
      lb.appendChild(stack);
    }
    const txt = document.createElement('span');
    txt.className = 'txt';
    if (liker && p.likeCount === 1) {
      txt.innerHTML = `Liked by <strong>${displayNameWithOwnerBadge(liker, liker.username, 'inline')}</strong>`;
    } else if (liker && p.likeCount > 1) {
      const others = p.likeCount - 1;
      txt.innerHTML = `Liked by <strong>${displayNameWithOwnerBadge(liker, liker.username, 'inline')}</strong> and <strong>${others} other${others === 1 ? '' : 's'}</strong>`;
    } else {
      txt.innerHTML = `<strong>${p.likeCount}</strong> ${p.likeCount === 1 ? 'like' : 'likes'}`;
    }
    lb.appendChild(txt);
  } else if (lb) {
    lb.remove();
  }
}

function _computePostsSignature(posts) {
  return (posts || []).map(p => p.id + ':' + (p.likeCount||0) + ':' + (p.commentCount||0)).join('|');
}

/** Update only the comments preview + "View all N comments" inside a post card; no full re-render. */
function patchCommentUI(card, p) {
  if (!card) return;
  const cc = (p.comments || []).length;
  // 1) "View all N comments" button
  let vc = card.querySelector('.view-comments');
  if (cc > 2) {
    if (!vc) {
      vc = document.createElement('button');
      vc.className = 'view-comments';
      vc.addEventListener('click', () => openCommentsSheet(p));
      const timeEl = card.querySelector('.post-time');
      if (timeEl) timeEl.insertAdjacentElement('beforebegin', vc);
      else card.appendChild(vc);
    }
    vc.textContent = `View all ${cc} comments`;
  } else if (vc) {
    vc.remove();
  }
  // 2) Preview comments (last 2)
  let pv = card.querySelector('.preview-comments');
  if (cc > 0) {
    if (!pv) {
      pv = document.createElement('div');
      pv.className = 'preview-comments';
      const timeEl = card.querySelector('.post-time');
      if (timeEl) timeEl.insertAdjacentElement('beforebegin', pv);
      else card.appendChild(pv);
    }
    pv.innerHTML = '';
    (p.comments || []).slice(-2).forEach(c => {
      const cAuth = resolveAuthor(c.author, c.userId, c.authorSnapshot);
      const row = document.createElement('div');
      row.className = 'preview-comment';
      const a = document.createElement('span'); a.className = 'author';
      a.innerHTML = displayNameWithOwnerBadge(cAuth, cAuth.username || cAuth.displayName, 'inline');
      row.appendChild(a);
      row.appendChild(document.createTextNode(' ' + (c.text || '')));
      pv.appendChild(row);
    });
  } else if (pv) {
    pv.remove();
  }
}


function openPostDetail(post) {
  const p = normalizeProfilePost(post);
  if (!p) return;
  const existing = $('#postDetailViewer');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.id = 'postDetailViewer';
  wrap.className = 'post-detail-viewer';
  wrap.innerHTML = `
    <div class="post-detail-top">
      <button type="button" id="postDetailBack" class="ghost-btn" aria-label="Back"><i data-lucide="arrow-left"></i></button>
      <strong>Posts</strong>
    </div>
    <div class="post-detail-body" id="postDetailBody"></div>`;
  document.body.appendChild(wrap);
  const body = $('#postDetailBody');
  const fullPost = (State.posts || []).find(x => x.id === p.id) || p;
  body.appendChild(renderPost({ ...fullPost, ...p }));
  $('#postDetailBack').addEventListener('click', () => wrap.remove());
  refreshIcons();
}

async function openSavedPostsSheet() {
  closeSettings();
  try { await loadPosts(); } catch (_) {}
  const saved = getSaved();
  const rows = (State.posts || []).filter(p => saved[p.id] && !isStoryRecord(p)).map(normalizeProfilePost).filter(Boolean);
  const existing = $('#savedPostsSheet');
  if (existing) existing.remove();
  const sheet = document.createElement('div');
  sheet.id = 'savedPostsSheet';
  sheet.className = 'sheet saved-posts-sheet';
  sheet.innerHTML = `
    <div class="sheet-card saved-posts-card">
      <div class="sheet-handle"></div>
      <div class="profile-relation-head">
        <strong>Saved posts</strong>
        <button type="button" class="ghost-btn" id="savedPostsClose" aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <div class="saved-posts-grid" id="savedPostsGrid"></div>
    </div>`;
  document.body.appendChild(sheet);
  const grid = $('#savedPostsGrid');
  if (!rows.length) {
    grid.innerHTML = '<div class="profile-relation-empty">No saved posts yet</div>';
  } else {
    rows.forEach(p => grid.appendChild(buildGridCell(p)));
  }
  $('#savedPostsClose').addEventListener('click', () => sheet.remove());
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.remove(); });
  refreshIcons();
}

function getSaved() {
  try { return JSON.parse(localStorage.getItem('ps_saved') || '{}'); }
  catch (_) { return {}; }
}
function toggleSaved(p, btn) {
  const all = getSaved();
  if (all[p.id]) { delete all[p.id]; btn.classList.remove('saved'); btn.setAttribute('aria-label', 'Save'); toast('Removed from saved'); }
  else { all[p.id] = true; btn.classList.add('saved'); btn.setAttribute('aria-label', 'Unsave'); toast('Saved', 'success'); }
  localStorage.setItem('ps_saved', JSON.stringify(all));
}

async function sharePost(p) {
  const url = location.origin + '/#post=' + encodeURIComponent(p.id);
  const text = p.text ? (p.text.slice(0, 80) + (p.text.length > 80 ? '…' : '')) : 'Check out this post on PRIV SPACA';
  try {
    if (navigator.share) {
      await navigator.share({ title: 'PRIV SPACA', text, url });
      return;
    }
  } catch (_) {}
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied', 'success');
  } catch (_) {
    toast('Share unavailable', 'error');
  }
}

function openMoreMenu(p, isMine) {
  const wrap = document.createElement('div');
  wrap.className = 'more-menu';
  const close = () => wrap.remove();
  wrap.innerHTML = '<div class="bd"></div>';
  wrap.querySelector('.bd').addEventListener('click', close);
  const card = document.createElement('div');
  card.className = 'card';
  const items = [];
  if (isMine) {
    items.push({ label: 'Delete', danger: true, action: async () => {
      close();
      try {
        await api('/posts/delete', { method: 'POST', body: { postId: p.id } });
        lastPostsSignature = null; loadPosts(); // force re-render even if list becomes empty
        undoToast('Post deleted', async () => {
          try {
            await api('/posts/restore', { method: 'POST', body: { postId: p.id } });
            lastPostsSignature = null; loadPosts(); // force re-render even if list becomes empty
            toast('Restored', 'success');
          } catch (e) { toast(e.message || 'Restore failed', 'error'); }
        });
      } catch (e) { toast(e.message || 'Delete failed', 'error'); }
    }});
  }
  items.push({ label: 'Share to…', action: () => { close(); sharePost(p); }});
  items.push({ label: 'Copy link', action: async () => {
    close();
    try { await navigator.clipboard.writeText(location.origin + '/#post=' + encodeURIComponent(p.id)); toast('Link copied', 'success'); }
    catch (_) { toast('Copy failed', 'error'); }
  }});
  if (!isMine) items.push({ label: 'Report', danger: true, action: () => { close(); toast('Reported. Thanks for keeping the community safe.'); }});
  items.push({ label: 'Cancel', cancel: true, action: close });
  items.forEach(it => {
    const b = document.createElement('button');
    b.className = 'item' + (it.danger ? ' danger' : '') + (it.cancel ? ' cancel' : '');
    b.textContent = it.label;
    b.addEventListener('click', it.action);
    card.appendChild(b);
  });
  wrap.appendChild(card);
  document.body.appendChild(wrap);
}

let activeCommentsPost = null;
function openCommentsSheet(p) {
  activeCommentsPost = p;
  const list = $('#commentsList');
  list.innerHTML = '';
  const cms = p.comments || [];
  if (cms.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No comments yet. Be the first!';
    list.appendChild(li);
  }
  cms.forEach(c => {
    const cAuth = resolveAuthor(c.author, c.userId, c.authorSnapshot);
    const li = document.createElement('li');
    const a = document.createElement('span'); a.className = 'avatar sm';
    renderAvatar(a, cAuth);
    const b = document.createElement('div'); b.className = 'body';
    const txt = document.createElement('div'); txt.className = 'text';
    const author = document.createElement('span'); author.className = 'author';
    author.innerHTML = displayNameWithOwnerBadge(cAuth, cAuth.username || cAuth.displayName, 'inline');
    txt.appendChild(author);
    // Space between author and text (bug fix)
    txt.appendChild(document.createTextNode(' ' + (c.text || '')));
    const meta = document.createElement('div'); meta.className = 'meta-row';
    meta.innerHTML = `<span>${escapeHtml(timeAgo(c.createdAt))}</span><span>Reply</span>`;
    b.appendChild(txt); b.appendChild(meta);
    li.appendChild(a); li.appendChild(b);
    list.appendChild(li);
  });
  renderAvatar($('#commentsMeAvatar'), State.user);
  $('#commentsInput').value = '';
  const sheet = $('#commentsSheet');
  sheet.classList.remove('hidden');
  const card = sheet.querySelector('.sheet-card');
  if (card) motionAnimate(card,
    { transform: ['translateY(100%)', 'translateY(0)'], opacity: [0.6, 1] },
    { duration: 0.36, easing: [0.2, 0.85, 0.15, 1] }
  );
  // Stagger the comments in
  const items = sheet.querySelectorAll('.comments-sheet-list li');
  if (items.length) staggerIn([...items].slice(0, 8), { delayPer: 0.03 });
  refreshIcons();
  setTimeout(() => $('#commentsInput').focus(), 220);
}

function closeCommentsSheet() {
  $('#commentsSheet').classList.add('hidden');
  activeCommentsPost = null;
}

function bindCommentsSheet() {
  $$('[data-close-sheet]').forEach(b => b.addEventListener('click', closeCommentsSheet));
  $('#commentsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeCommentsPost) return;
    const inp = $('#commentsInput');
    const text = inp.value.trim();
    if (!text) return;
    const sb = e.target.querySelector('.post-btn');
    sb.disabled = true;
    try {
      const data = await api('/posts/comment', { method: 'POST', body: { postId: activeCommentsPost.id, text } });
      inp.value = '';
      activeCommentsPost.comments = activeCommentsPost.comments || [];
      activeCommentsPost.comments.push(data.comment);
      activeCommentsPost.commentCount = (activeCommentsPost.commentCount || 0) + 1;
      // Re-render the sheet's comment list (keeps the composer focused)
      openCommentsSheet(activeCommentsPost);
      // Patch the original post card in-place (no flicker / no full feed rebuild)
      const cached = _postCardCache.get(activeCommentsPost.id);
      if (cached) {
        cached.sig = _postCardSignature(activeCommentsPost);
        patchCommentUI(cached.card, activeCommentsPost);
      }
      boostPolling(20000);
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { sb.disabled = false; }
  });
}

// ===== Story viewed-state (per user, persisted) =====
// Stores { userId: { lastPostTs: timestamp, viewedAt: timestamp } }
function _getStoryViewed() {
  try { return JSON.parse(localStorage.getItem('ps_storyViewed') || '{}'); }
  catch (_) { return {}; }
}
function _setStoryViewed(obj) {
  try { localStorage.setItem('ps_storyViewed', JSON.stringify(obj)); } catch (_) {}
}
function isStoryViewed(userId) {
  const map = _getStoryViewed();
  const entry = map[userId];
  if (!entry) return false;
  const latest = getLatestStory(userId)?.createdAt || 0;
  if (!latest) return !!entry.viewedAt;
  return entry.viewedAt >= latest;
}
function markStoryViewed(userId) {
  const latest = getLatestStory(userId)?.createdAt || 0;
  const map = _getStoryViewed();
  map[userId] = { lastPostTs: latest, viewedAt: Date.now() };
  _setStoryViewed(map);
}

let storyTimer = null;
const storyPlayback = {
  user: null,
  items: [],
  index: 0,
  durationMs: 6000,
  rafId: 0,
  startedAt: 0,
  progressFill: null,
  _pausedAt: 0,
  videoEl: null,
};

// Single source of truth for story text typography — used identically by the
// live editor preview AND the story viewer, so appearance is guaranteed to match.
const STORY_FONT_PRESETS = {
  modern:     { family: "'Inter', system-ui, -apple-system, sans-serif", weight: '700', style: 'normal', transform: 'none', spacing: '0',     shadow: '0 1px 8px rgba(0,0,0,.45)' },
  SQUEEZE:    { family: "'Bebas Neue', Impact, sans-serif",               weight: '400', style: 'normal', transform: 'uppercase', spacing: '1.5px', shadow: '0 2px 10px rgba(0,0,0,.55)', stroke: '1px rgba(0,0,0,.35)' },
  neon:       { family: "'Bebas Neue', Impact, sans-serif",               weight: '400', style: 'normal', transform: 'uppercase', spacing: '1.5px', shadow: '0 0 12px currentColor, 0 2px 10px rgba(0,0,0,.5)' },
  Bubble:     { family: "'Baloo 2', 'Trebuchet MS', sans-serif",          weight: '700', style: 'normal', transform: 'none', spacing: '0',     shadow: '0 3px 0 rgba(0,0,0,.18), 0 1px 10px rgba(0,0,0,.35)' },
  playful:    { family: "'Baloo 2', 'Trebuchet MS', sans-serif",          weight: '700', style: 'normal', transform: 'none', spacing: '0',     shadow: '0 3px 0 rgba(0,0,0,.18)' },
  Deco:       { family: "'Playfair Display', Georgia, serif",             weight: '600', style: 'italic', transform: 'none', spacing: '0.2px', shadow: '0 1px 8px rgba(0,0,0,.5)' },
  Typewriter: { family: "'Courier New', monospace",                       weight: '700', style: 'normal', transform: 'none', spacing: '0.5px', shadow: '0 1px 6px rgba(0,0,0,.5)' },
  typewriter: { family: "'Courier New', monospace",                       weight: '700', style: 'normal', transform: 'none', spacing: '0.5px', shadow: '0 1px 6px rgba(0,0,0,.5)' },
  script:     { family: "'Dancing Script', Georgia, cursive",             weight: '700', style: 'normal', transform: 'none', spacing: '0',     shadow: '0 2px 10px rgba(0,0,0,.4)' },
};
function applyStoryFontPreset(el, font = 'modern') {
  if (!el) return;
  const p = STORY_FONT_PRESETS[font] || STORY_FONT_PRESETS.modern;
  el.style.fontFamily = p.family;
  el.style.fontWeight = p.weight;
  el.style.fontStyle = p.style;
  el.style.textTransform = p.transform;
  el.style.letterSpacing = p.spacing;
  // Only apply the built-in readability shadow when the caller hasn't already
  // set an explicit background box (bgMode !== 'none') — otherwise the text
  // sits on a solid/soft fill and the drop shadow just looks muddy.
  if (!el.dataset || el.dataset.storyBgActive !== '1') {
    el.style.textShadow = p.shadow || '0 1px 8px rgba(0,0,0,.4)';
    if (p.stroke) el.style.webkitTextStroke = p.stroke; else el.style.webkitTextStroke = '';
  } else {
    el.style.textShadow = 'none';
    el.style.webkitTextStroke = '';
  }
}

function getStorySequence(userId) {
  return getStoryPosts(userId).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
function getStoryDurationMs(story) {
  if (story && story.music && story.music.clipDur) {
    return Math.max(5000, Math.min(15000, Number(story.music.clipDur) * 1000 || 6000));
  }
  if (story && story.text && !story.imageUrl) return 7000;
  if (story && story.text && story.imageUrl) return 6500;
  return 5500;
}
function stopStoryPlayback() {
  clearTimeout(storyTimer);
  storyTimer = null;
  if (storyPlayback.rafId) cancelAnimationFrame(storyPlayback.rafId);
  storyPlayback.rafId = 0;
  storyPlayback.startedAt = 0;
  storyPlayback.progressFill = null;
  storyPlayback._pausedAt = 0;
  // Tear down any active story video element so audio doesn't keep playing.
  if (storyPlayback.videoEl) {
    try { storyPlayback.videoEl.pause(); storyPlayback.videoEl.src = ''; } catch (_) {}
    storyPlayback.videoEl = null;
  }
  _isHoldingStory = false;
}
function renderStoryProgressBars(total, activeIndex) {
  const progress = $('#storyProgress');
  if (!progress) return;
  progress.innerHTML = '';
  storyPlayback.progressFill = null;
  for (let i = 0; i < total; i++) {
    const bar = document.createElement('div');
    bar.className = 'bar' + (i < activeIndex ? ' done' : (i === activeIndex ? ' active' : ''));
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = i < activeIndex ? '100%' : '0%';
    bar.appendChild(fill);
    progress.appendChild(bar);
    if (i === activeIndex) storyPlayback.progressFill = fill;
  }
}
function startStoryProgress() {
  stopStoryPlayback();
  const fill = storyPlayback.progressFill;
  if (!fill) return;
  storyPlayback.startedAt = performance.now();
  const step = (now) => {
    const pct = Math.max(0, Math.min(1, (now - storyPlayback.startedAt) / storyPlayback.durationMs));
    if (storyPlayback.progressFill) storyPlayback.progressFill.style.width = (pct * 100).toFixed(2) + '%';
    if (pct >= 1) {
      nextStoryItem();
      return;
    }
    storyPlayback.rafId = requestAnimationFrame(step);
  };
  storyPlayback.rafId = requestAnimationFrame(step);
}
// Small in-memory cache so we don't re-decode the same story image every time
// the user re-opens a story, and so the "next" item can be warmed ahead of time.
const _storyImagePreloadCache = new Set();
function preloadStoryImage(url) {
  if (!url || _storyImagePreloadCache.has(url)) return;
  _storyImagePreloadCache.add(url);
  const img = new Image();
  img.src = url;
}

function renderStoryItem() {
  if (_postMusicPlayer && !_postMusicPlayer.paused) _postMusicPlayer.pause();
  const user = storyPlayback.user;
  const recent = storyPlayback.items[storyPlayback.index];
  if (!user || !recent) return closeStory();
  const v = $('#storyViewer');
  const content = $('#storyContent');
  const st = recent.style || {};
  content.innerHTML = '';
  renderStoryProgressBars(storyPlayback.items.length, storyPlayback.index);
  renderAvatar($('#storyAvatar'), user);
  $('#storyName').innerHTML = displayNameWithOwnerBadge(user, user.displayName || user.username, 'inline');
  $('#storyMeta').textContent = recent ? timeAgo(recent.createdAt) : 'just now';
  const isMyStory = !!(State.user && user.id === State.user.id);
  const manageBtn = $('#storyManageBtn');
  if (manageBtn) manageBtn.classList.toggle('hidden', !isMyStory);
  // Footer UI: owners see a "Seen by" pill; viewers get the reply bar.
  updateStoryFooter(recent, isMyStory);

  // Normalize to a photo array so single- and multi-photo stories share one
  // render path. Multi-photo items become an in-item swipeable carousel.
  const storyImgs = Array.isArray(recent.images) && recent.images.length > 0
    ? recent.images
    : (recent.imageUrl ? [recent.imageUrl] : []);
  const firstImg = storyImgs[0] || null;

  // Only show a loading spinner + pause progress for image stories, and only
  // if the image genuinely isn't cached yet (avoids a flash on repeat views).
  const needsImageLoad = !!firstImg && !recent.videoUrl && !_storyImagePreloadCache.has(firstImg);
  v.classList.toggle('is-loading', needsImageLoad);

  if (recent.videoUrl) {
    // ---- Video story: <video> drives the progress bar via its own duration ----
    const vidWrap = document.createElement('div');
    vidWrap.style.cssText = 'position:relative; width:100%; height:100%; display:flex; align-items:center; justify-content:center;';
    const vid = document.createElement('video');
    vid.src = recent.videoUrl;
    vid.autoplay = true; vid.playsInline = true; vid.setAttribute('playsinline', '');
    vid.controls = false; vid.loop = false; vid.muted = false;
    vid.style.cssText = 'width:100%; height:100%; max-height:82vh; object-fit:contain; border-radius:6px; background:#000;';
    v.classList.add('is-loading');
    // Drive the progress bar from actual playback time.
    stopStoryPlayback();
    const syncProgress = () => {
      if (_isHoldingStory) return;
      const dur = vid.duration && isFinite(vid.duration) ? vid.duration : (getStoryDurationMs(recent) / 1000);
      const pct = dur > 0 ? Math.max(0, Math.min(1, vid.currentTime / dur)) : 0;
      if (storyPlayback.progressFill) storyPlayback.progressFill.style.width = (pct * 100).toFixed(2) + '%';
    };
    vid.addEventListener('loadeddata', () => { v.classList.remove('is-loading'); });
    vid.addEventListener('timeupdate', syncProgress);
    vid.addEventListener('ended', () => nextStoryItem());
    vid.addEventListener('error', () => { v.classList.remove('is-loading'); nextStoryItem(); });
    // Hold-to-pause should also pause/resume the video element.
    storyPlayback.videoEl = vid;
    vid.play().catch(() => {});
    vidWrap.appendChild(vid);
    if (recent.text) {
      const cap = document.createElement('div');
      cap.className = 'story-img-caption';
      const sz = st.size ? Math.min(52, Math.max(16, st.size)) : 22;
      const px = st.posX || 50; const py = st.posY || 68;
      const scale = st.scale ? Math.max(0.5, Math.min(2.5, st.scale)) : 1;
      cap.style.cssText = `position:absolute; top:${py}%; left:${px}%; transform:translate(-50%,-50%) scale(${scale}); transform-origin:center center; width:85%; font-size:${sz}px; z-index:15; word-break:break-word;`;
      cap.textContent = recent.text;
      applyStoryTextBoxStyle(cap, { color: st.color || '#ffffff', bgMode: st.bgMode || (st.bg ? 'solid' : 'none'), align: st.align || 'center' });
      applyStoryFontPreset(cap, st.font || 'modern');
      vidWrap.appendChild(cap);
    }
    content.appendChild(vidWrap);
  } else if (firstImg) {
    const imgWrap = document.createElement('div');
    imgWrap.style.cssText = 'position:relative; width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;';
    const img = document.createElement('img');
    img.alt = 'story';
    img.style.cssText = 'object-fit:contain; width:100%; height:100%; max-height:82vh; border-radius:6px; opacity:0; transition:opacity .2s ease;';
    let carouselIdx = 0;
    img.onload = () => {
      img.style.opacity = '1';
      _storyImagePreloadCache.add(firstImg);
      v.classList.remove('is-loading');
      // Restart the progress timer only once the image is actually visible,
      // so the bar doesn't race ahead of a slow-loading photo on weak networks.
      if (needsImageLoad) startStoryProgress();
    };
    img.onerror = () => { v.classList.remove('is-loading'); img.style.opacity = '1'; };
    img.src = firstImg;
    imgWrap.appendChild(img);

    // ---- Multi-photo carousel controls (dots + swipe), only when >1 photo ----
    if (storyImgs.length > 1) {
      // Preload the rest so switching is instant.
      storyImgs.slice(1).forEach(preloadStoryImage);
      const dots = document.createElement('div');
      dots.className = 'story-carousel-dots';
      storyImgs.forEach((_, i) => {
        const d = document.createElement('span');
        d.className = 'story-carousel-dot' + (i === 0 ? ' active' : '');
        dots.appendChild(d);
      });
      imgWrap.appendChild(dots);
      const showPhoto = (i) => {
        carouselIdx = Math.max(0, Math.min(storyImgs.length - 1, i));
        img.style.opacity = '0';
        img.src = storyImgs[carouselIdx];
        img.onload = () => { img.style.opacity = '1'; };
        dots.querySelectorAll('.story-carousel-dot').forEach((el, k) => el.classList.toggle('active', k === carouselIdx));
      };
      // Swipe within the image switches photos without leaving the story item.
      let sx = 0, sy = 0;
      imgWrap.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
      imgWrap.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
          e.stopPropagation();
          showPhoto(carouselIdx + (dx < 0 ? 1 : -1));
        }
      });
      // Dots are tappable too.
      dots.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Array.from(dots.children).indexOf(e.target);
        if (idx >= 0) showPhoto(idx);
      });
    }

    if (recent.text) {
      const cap = document.createElement('div');
      cap.className = 'story-img-caption';
      const sz = st.size ? Math.min(52, Math.max(16, st.size)) : 22;
      const px = st.posX || 50;
      const py = st.posY || 68;
      const scale = st.scale ? Math.max(0.5, Math.min(2.5, st.scale)) : 1;
      cap.style.cssText = `position:absolute; top:${py}%; left:${px}%; transform:translate(-50%,-50%) scale(${scale}); transform-origin:center center; width:85%; font-size:${sz}px; z-index:15; word-break:break-word;`;
      cap.textContent = recent.text;
      // Exact parity with the editor: same box-style + font-preset helpers.
      applyStoryTextBoxStyle(cap, { color: st.color || '#ffffff', bgMode: st.bgMode || (st.bg ? 'solid' : 'none'), align: st.align || 'center' });
      applyStoryFontPreset(cap, st.font || 'modern');
      imgWrap.appendChild(cap);
    }
    content.appendChild(imgWrap);
  } else if (recent.text) {
    const div = document.createElement('div');
    div.className = 'text-story';
    div.textContent = recent.text.slice(0, 280);
    const sz = st.size ? Math.min(52, Math.max(20, st.size)) : 28;
    const scale = st.scale ? Math.max(0.5, Math.min(2.5, st.scale)) : 1;
    div.style.fontSize = sz + 'px';
    div.style.transform = `scale(${scale})`;
    applyStoryTextBoxStyle(div, { color: st.color || '#ffffff', bgMode: st.bgMode || (st.bg ? 'solid' : 'none'), align: st.align || 'center' });
    applyStoryFontPreset(div, st.font || 'modern');
    content.appendChild(div);
  }
  v.classList.remove('hidden');
  const player = $('#storyBgAudioPlayer');
  if (player) { player.pause(); player.src = ''; }
  if (recent.music && recent.music.title) {
    const stk = document.createElement('div');
    const layout = ['pill', 'card', 'minimal'].includes(recent.music.layout) ? recent.music.layout : 'pill';
    stk.className = `story-music-sticker layout-${layout}`;
    stk.style.position = 'absolute';
    const mpx = recent.music.posX || 50;
    const mpy = recent.music.posY || 32;
    const mscale = recent.music.scale ? Math.max(0.5, Math.min(2.5, recent.music.scale)) : 1;
    stk.style.left = mpx + '%';
    stk.style.top = mpy + '%';
    stk.style.transform = `translate(-50%, -50%) scale(${mscale})`;
    stk.innerHTML = `
      <img src="${recent.music.art || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=120&q=80'}" class="story-music-art" alt="art" />
      <div class="story-music-meta">
        <div class="story-music-title">${escapeHtml(recent.music.title)}</div>
        <div class="story-music-artist">${escapeHtml(recent.music.artist || '')}</div>
      </div>
      <div class="story-eq-bars">
        <div class="story-eq-bar"></div><div class="story-eq-bar"></div><div class="story-eq-bar"></div>
      </div>
    `;
    content.appendChild(stk);
    if (player && recent.music.audio) {
      player.src = recent.music.audio;
      player.currentTime = recent.music.startTime || 0;
      player.play().catch(() => {});
    }
  }
  const contentEl = $('#storyContent');
  if (contentEl) motionAnimate(contentEl,
    { opacity: [0, 1], transform: ['scale(.96)', 'scale(1)'] },
    { duration: 0.28, easing: [0.2, 0.85, 0.2, 1] }
  );
  storyPlayback.durationMs = getStoryDurationMs(recent);
  // Video stories drive their own progress bar from playback time (handled in
  // the video branch above), so skip the RAF countdown timer for them.
  // Otherwise: don't start the countdown yet if we're still waiting on an image
  // decode — img.onload above will kick it off once the pixels are visible.
  if (!recent.videoUrl && !needsImageLoad) startStoryProgress();

  // Preload the very next item (within this user, or the first item of the
  // next user with an active story) so tapping forward feels instant.
  const nextInSeq = storyPlayback.items[storyPlayback.index + 1];
  if (nextInSeq && nextInSeq.imageUrl) preloadStoryImage(nextInSeq.imageUrl);
  else {
    const nextUser = getNextStoryUser(user.id);
    const nextUserFirst = nextUser ? getStorySequence(nextUser.id)[0] : null;
    if (nextUserFirst && nextUserFirst.imageUrl) preloadStoryImage(nextUserFirst.imageUrl);
  }
  // Analytics: record that we viewed this story item (server ignores self-views).
  if (!isMyStory) recordStoryView(recent);
  refreshIcons();
}

// ---- Story analytics + reply footer ----
const _recordedStoryViews = new Set(); // client-side de-dupe within a session
let _currentStoryItem = null;

function recordStoryView(story) {
  if (!story || !story.id || _recordedStoryViews.has(story.id)) return;
  _recordedStoryViews.add(story.id);
  api('/stories/' + encodeURIComponent(story.id) + '/view', { method: 'POST' }).catch(() => {
    _recordedStoryViews.delete(story.id); // allow a retry next open on failure
  });
}

function updateStoryFooter(story, isMyStory) {
  _currentStoryItem = story;
  const seenBtn = $('#storySeenBy');
  const replyBar = $('#storyReplyBar');
  const qr = $('#storyQuickReacts');
  const ai = $('#storyActionIcons');
  const snd = $('#storyReplySend');
  if (isMyStory) {
    if (replyBar) replyBar.classList.add('hidden');
    if (seenBtn) {
      const n = typeof story.viewCount === 'number' ? story.viewCount : (Array.isArray(story.views) ? story.views.length : 0);
      const cnt = $('#storySeenByCount');
      if (cnt) cnt.textContent = String(n);
      seenBtn.classList.remove('hidden');
    }
  } else {
    if (seenBtn) seenBtn.classList.add('hidden');
    if (replyBar) replyBar.classList.remove('hidden');
    if (qr) qr.classList.add('hidden');
    if (ai) ai.classList.remove('hidden');
    if (snd) snd.classList.add('hidden');
    const inp = $('#storyReplyInput');
    if (inp) inp.value = '';
    const lb = $('#storyLikeBtn');
    if (lb && story && State.user) {
      const liked = (story.likes || []).includes(State.user.id);
      lb.classList.toggle('liked', liked);
    }
  }
}

async function openStoryViewersSheet() {
  const story = _currentStoryItem;
  if (!story || !story.id) return;
  const sheet = $('#storyViewersSheet');
  const listEl = $('#storyViewersList');
  const titleEl = $('#storyViewersTitle');
  if (!sheet || !listEl) return;
  // Pause story playback while the sheet is open so the timer doesn't advance.
  pauseStoryForHold();
  listEl.innerHTML = '<div class="story-viewers-empty">Loading…</div>';
  sheet.classList.remove('hidden');
  const card = sheet.querySelector('.sheet-card');
  if (card) motionAnimate(card, { transform: ['translateY(100%)', 'translateY(0)'], opacity: [0.6, 1] }, { duration: 0.34, easing: [0.2, 0.85, 0.15, 1] });
  refreshIcons();
  try {
    const data = await api('/stories/' + encodeURIComponent(story.id) + '/viewers');
    const viewers = data.viewers || [];
    if (titleEl) titleEl.textContent = viewers.length ? ('Viewers · ' + viewers.length) : 'Viewers';
    if (!viewers.length) {
      listEl.innerHTML = '<div class="story-viewers-empty">No views yet. When people watch this story, they\'ll show up here.</div>';
      return;
    }
    listEl.innerHTML = '';
    viewers.forEach(v => {
      const row = document.createElement('div');
      row.className = 'story-viewer-row';
      const av = document.createElement('span');
      av.className = 'avatar sm';
      renderAvatar(av, v);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<div class="nm">${displayNameWithOwnerBadge(v, v.displayName || v.username || 'Member', 'inline')}</div><div class="sub">${escapeHtml(timeAgo(v.at))}</div>`;
      row.appendChild(av); row.appendChild(meta);
      listEl.appendChild(row);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="story-viewers-empty">Couldn\'t load viewers.</div>';
  }
}
function closeStoryViewersSheet() {
  const sheet = $('#storyViewersSheet');
  if (sheet) sheet.classList.add('hidden');
  resumeStoryFromHold();
}

async function sendStoryReply(emoji, text) {
  const story = _currentStoryItem;
  if (!story || !story.id) return;
  const body = {};
  if (emoji) body.emoji = emoji;
  if (text) body.text = text;
  try {
    await api('/stories/' + encodeURIComponent(story.id) + '/reply', { method: 'POST', body });
    toast(emoji && !text ? 'Reaction sent' : 'Reply sent', 'success');
  } catch (e) {
    toast('Reply failed: ' + (e.message || ''), 'error');
  }
}

function bindStoryReplyUI() {
  const seenBtn = $('#storySeenBy');
  if (seenBtn) seenBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openStoryViewersSheet(); });
  const vClose = $('#storyViewersClose');
  if (vClose) vClose.addEventListener('click', closeStoryViewersSheet);
  const vSheet = $('#storyViewersSheet');
  if (vSheet) vSheet.addEventListener('click', (e) => { if (e.target === vSheet) closeStoryViewersSheet(); });
  // Quick emoji reactions
  $$('#storyQuickReacts .story-react-emoji').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      btn.classList.remove('burst'); void btn.offsetWidth; btn.classList.add('burst');
      sendStoryReply(btn.dataset.emoji, '');
      const qr = $('#storyQuickReacts'); if (qr) qr.classList.add('hidden');
      const ai = $('#storyActionIcons'); if (ai) ai.classList.remove('hidden');
    });
  });
  // Reply text form
  const form = $('#storyReplyForm');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault(); e.stopPropagation();
      const inp = $('#storyReplyInput');
      const txt = (inp && inp.value || '').trim();
      if (!txt) return;
      if (inp) inp.value = '';
      const snd = $('#storyReplySend'); if (snd) snd.classList.add('hidden');
      const qr = $('#storyQuickReacts'); if (qr) qr.classList.add('hidden');
      const ai = $('#storyActionIcons'); if (ai) ai.classList.remove('hidden');
      sendStoryReply('', txt);
    });
    const inp = $('#storyReplyInput');
    if (inp) {
      inp.addEventListener('focus', () => {
        try { pauseStoryForHold(); } catch (_) {}
        const qr = $('#storyQuickReacts'); if (qr) qr.classList.remove('hidden');
        const ai = $('#storyActionIcons'); if (ai) ai.classList.add('hidden');
      });
      inp.addEventListener('blur', () => {
        try { resumeStoryFromHold(); } catch (_) {}
        setTimeout(() => {
          if (!inp.value.trim()) {
            const qr = $('#storyQuickReacts'); if (qr) qr.classList.add('hidden');
            const ai = $('#storyActionIcons'); if (ai) ai.classList.remove('hidden');
            const snd = $('#storyReplySend'); if (snd) snd.classList.add('hidden');
          }
        }, 150);
      });
      inp.addEventListener('input', () => {
        const snd = $('#storyReplySend');
        if (snd) snd.classList.toggle('hidden', !inp.value.trim());
      });
      inp.addEventListener('click', (e) => e.stopPropagation());
    }
  }
  const lb = $('#storyLikeBtn');
  if (lb) lb.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!_currentStoryItem) return;
    const liked = !lb.classList.contains('liked');
    lb.classList.toggle('liked', liked);
    if (liked && State.user) {
      if (!Array.isArray(_currentStoryItem.likes)) _currentStoryItem.likes = [];
      if (!_currentStoryItem.likes.includes(State.user.id)) _currentStoryItem.likes.push(State.user.id);
    } else if (State.user && _currentStoryItem.likes) {
      _currentStoryItem.likes = _currentStoryItem.likes.filter(id => id !== State.user.id);
    }
    try { await api('/posts/like', { method: 'POST', body: { postId: _currentStoryItem.id } }); } catch (_) {}
  });
  const cb = $('#storyCommentIconBtn');
  if (cb) cb.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const inp = $('#storyReplyInput'); if (inp) inp.focus();
  });
  const sb = $('#storyShareIconBtn');
  if (sb) sb.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    toast('Story link copied to clipboard!', 'success');
  });
}

// Ordered list of users that currently have an active story, in the same
// order they appear in the stories rail (me first, then others by recency).
// Lets the viewer advance from one user's last story straight into the next
// user's stories, like Instagram does, instead of just closing.
function getStoryUserOrder() {
  if (!State.user || !Array.isArray(State.members)) return [];
  const meId = State.user.id;
  const me = State.members.find(m => m.id === meId) || State.user;
  const others = State.members
    .filter(m => m.id !== meId && hasActiveStory(m.id))
    .sort((a, b) => {
      const bt = (getLatestStory(b.id)?.createdAt || 0) - (getLatestStory(a.id)?.createdAt || 0);
      if (bt !== 0) return bt;
      return (b.online ? 1 : 0) - (a.online ? 1 : 0);
    });
  const order = [];
  if (hasActiveStory(meId)) order.push(me);
  order.push(...others);
  return order;
}
function getNextStoryUser(currentUserId) {
  const order = getStoryUserOrder();
  const idx = order.findIndex(u => u.id === currentUserId);
  if (idx === -1 || idx === order.length - 1) return null;
  return order[idx + 1];
}
function getPrevStoryUser(currentUserId) {
  const order = getStoryUserOrder();
  const idx = order.findIndex(u => u.id === currentUserId);
  if (idx <= 0) return null;
  return order[idx - 1];
}

function openStoryFor(user, startIndex = 0) {
  const items = getStorySequence(user.id);
  if (!items.length) {
    if (user.id === (State.user && State.user.id) && typeof openStoryCreator === 'function') return openStoryCreator();
    toast('No active story right now');
    return;
  }
  storyPlayback.user = user;
  storyPlayback.items = items;
  storyPlayback.index = Math.max(0, Math.min(startIndex, items.length - 1));
  markStoryViewed(user.id);
  renderStoryItem();
}
function prevStoryItem() {
  if (!storyPlayback.items.length) return closeStory();
  if (storyPlayback.index > 0) {
    storyPlayback.index--;
    renderStoryItem();
    return;
  }
  // At the first story of this user — Instagram steps back to the *previous*
  // user's stories (their last unseen item) rather than closing outright.
  const prevUser = storyPlayback.user && getPrevStoryUser(storyPlayback.user.id);
  if (prevUser) {
    const items = getStorySequence(prevUser.id);
    openStoryFor(prevUser, items.length - 1);
  } else {
    closeStory();
  }
}
function nextStoryItem() {
  if (!storyPlayback.items.length) return closeStory();
  if (storyPlayback.index < storyPlayback.items.length - 1) {
    storyPlayback.index++;
    renderStoryItem();
    return;
  }
  // Last story for this user — advance straight into the next user with an
  // active story, matching Instagram's continuous story-to-story flow.
  const nextUser = storyPlayback.user && getNextStoryUser(storyPlayback.user.id);
  if (nextUser) {
    openStoryFor(nextUser, 0);
  } else {
    closeStory();
  }
}
function closeStory() {
  stopStoryPlayback();
  storyPlayback.user = null;
  storyPlayback.items = [];
  storyPlayback.index = 0;
  const player = $('#storyBgAudioPlayer');
  if (player) { player.pause(); player.src = ''; }
  const v = $('#storyViewer');
  v.classList.add('hidden');
  v.classList.remove('is-loading', 'holding', 'paused');
  const seenBtn = $('#storySeenBy'); if (seenBtn) seenBtn.classList.add('hidden');
  const replyBar = $('#storyReplyBar'); if (replyBar) replyBar.classList.add('hidden');
  const vSheet = $('#storyViewersSheet'); if (vSheet) vSheet.classList.add('hidden');
  _currentStoryItem = null;
  if (typeof renderStoriesRail === 'function') renderStoriesRail();
}

// ---- Hold-to-pause + edge tap feedback ----
// A press-and-hold anywhere on the story content pauses the progress bar and
// the background music (Instagram-style "hold to pause"), and releasing
// resumes both. A quick tap on the left/right 35% zones (via the existing
// .story-prev/.story-next buttons) still navigates as before; we only treat
// presses longer than a short threshold as a "hold".
const HOLD_THRESHOLD_MS = 180;
let _holdTimer = null;
let _isHoldingStory = false;

function pauseStoryForHold() {
  if (_isHoldingStory) return;
  _isHoldingStory = true;
  const v = $('#storyViewer');
  if (v) v.classList.add('holding', 'paused');
  if (storyPlayback.rafId) cancelAnimationFrame(storyPlayback.rafId);
  storyPlayback.rafId = 0;
  storyPlayback._pausedAt = performance.now();
  const player = $('#storyBgAudioPlayer');
  if (player && !player.paused) { player.pause(); player._resumeAfterHold = true; }
  // Pause a playing story video too.
  if (storyPlayback.videoEl && !storyPlayback.videoEl.paused) {
    try { storyPlayback.videoEl.pause(); storyPlayback.videoEl._resumeAfterHold = true; } catch (_) {}
  }
}
function resumeStoryFromHold() {
  if (!_isHoldingStory) return;
  _isHoldingStory = false;
  const v = $('#storyViewer');
  if (v) v.classList.remove('holding', 'paused');
  if (storyPlayback._pausedAt && storyPlayback.startedAt) {
    // Shift the "started at" reference forward by exactly how long we paused,
    // so the remaining time (and the visual fill) picks up seamlessly.
    const pausedFor = performance.now() - storyPlayback._pausedAt;
    storyPlayback.startedAt += pausedFor;
  }
  storyPlayback._pausedAt = 0;
  const player = $('#storyBgAudioPlayer');
  if (player && player._resumeAfterHold) { player.play().catch(() => {}); player._resumeAfterHold = false; }
  // Resume a paused story video, and let it keep driving its own progress bar
  // (don't start the RAF countdown loop for video items).
  if (storyPlayback.videoEl) {
    if (storyPlayback.videoEl._resumeAfterHold) { storyPlayback.videoEl.play().catch(() => {}); storyPlayback.videoEl._resumeAfterHold = false; }
    return;
  }
  resumeStoryProgressLoop();
}
function resumeStoryProgressLoop() {
  const fill = storyPlayback.progressFill;
  if (!fill) return;
  const step = (now) => {
    if (_isHoldingStory) return; // loop stops; resumeStoryFromHold restarts it
    const pct = Math.max(0, Math.min(1, (now - storyPlayback.startedAt) / storyPlayback.durationMs));
    if (storyPlayback.progressFill) storyPlayback.progressFill.style.width = (pct * 100).toFixed(2) + '%';
    if (pct >= 1) { nextStoryItem(); return; }
    storyPlayback.rafId = requestAnimationFrame(step);
  };
  storyPlayback.rafId = requestAnimationFrame(step);
}

function flashStoryEdge(side) {
  const el = $(side === 'left' ? '#storyEdgeFlashLeft' : '#storyEdgeFlashRight');
  if (!el) return;
  el.classList.add('show');
  clearTimeout(el._hideTm);
  el._hideTm = setTimeout(() => el.classList.remove('show'), 180);
}

function bindStoryViewer() {
  $('#storyClose').addEventListener('click', closeStory);
  $('#storyPrev').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); flashStoryEdge('left'); prevStoryItem(); });
  $('#storyNext').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); flashStoryEdge('right'); nextStoryItem(); });
  $('#storyViewer').addEventListener('click', (e) => {
    if (e.target.id === 'storyViewer') closeStory();
  });

  // Hold-to-pause: works with both mouse and touch, on the media area only
  // (not on the close/manage buttons or the invisible prev/next hit zones —
  // those still handle their own click/tap for navigation).
  const content = $('#storyContent');
  if (content) {
    let downAt = 0;
    const onDown = () => { downAt = Date.now(); clearTimeout(_holdTimer); _holdTimer = setTimeout(pauseStoryForHold, HOLD_THRESHOLD_MS); };
    const onUp = () => { clearTimeout(_holdTimer); if (Date.now() - downAt >= HOLD_THRESHOLD_MS) resumeStoryFromHold(); };
    content.addEventListener('mousedown', onDown);
    content.addEventListener('mouseup', onUp);
    content.addEventListener('mouseleave', onUp);
    content.addEventListener('touchstart', onDown, { passive: true });
    content.addEventListener('touchend', onUp);
    content.addEventListener('touchcancel', onUp);
  }
  // Also pause when the tab goes to background so audio/progress don't drift.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && storyPlayback.user) pauseStoryForHold();
  });
}

// ====== INSTAGRAM STORY MUSIC CREATOR ======
const storyMusicCatalog = [
  { id: 1, title: "Golden Hour Vibes (30s)", artist: "ChillHop Beats", category: "lofi", duration: "0:30", art: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=120&q=80", audio: "https://cdn.pixabay.com/download/audio/2022/05/16/audio_db6591201e.mp3?filename=lofi-study-112191.mp3" },
  { id: 2, title: "Summer Night Anthem 🔥", artist: "SynthWave Pro", category: "trending", duration: "0:30", art: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=120&q=80", audio: "https://cdn.pixabay.com/download/audio/2022/10/25/audio_291e018d9f.mp3?filename=upbeat-pop-vlog-124040.mp3" },
  { id: 3, title: "Acoustic Sunset Love", artist: "Guitar Dreams", category: "acoustic", duration: "0:30", art: "https://images.unsplash.com/photo-1510915361894-db8b60106cb1?auto=format&fit=crop&w=120&q=80", audio: "https://cdn.pixabay.com/download/audio/2022/03/15/audio_c8c7151a44.mp3?filename=acoustic-guitar-loop-f-91304.mp3" },
  { id: 4, title: "Midnight Drive Pop Hit", artist: "Neon Stars", category: "pop", duration: "0:30", art: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=120&q=80", audio: "https://cdn.pixabay.com/download/audio/2023/04/23/audio_4cf13fddf5.mp3?filename=electronic-rock-king-around-here-150452.mp3" },
  { id: 5, title: "Coffee Shop Rain & Jazz", artist: "Cozy Lofi", category: "lofi", duration: "0:30", art: "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=120&q=80", audio: "https://cdn.pixabay.com/download/audio/2021/09/06/audio_7314227f42.mp3?filename=empty-mind-118973.mp3" }
];
let activeStoryMusicCat = 'all';
let selectedStoryMusicId = null;

let activeStoryFont = 'modern';
let activeStoryTextColor = '#ffffff';
let activeStoryTextBg = false;       // legacy flag, kept in sync with bgMode !== 'none' for back-compat
let activeStoryTextBgMode = 'none';  // 'none' | 'solid' | 'soft' | 'outline'
let activeStoryTextAlign = 'center';
let activeStoryTextSize = 28;
let activeStoryText = '';
let activeStickerScales = { storyStageMusicSticker: 1.0, storyStageTextOverlay: 1.0 };
let activeMusicClipDur = 30;
let activeStoryMusicLayout = 'pill';

/**
 * Single source of truth for the text overlay's background/fill styling —
 * used identically by the live editor stage, the live editor textarea preview,
 * and the story viewer so appearance always matches exactly.
 */
function applyStoryTextBoxStyle(el, { color = '#ffffff', bgMode = 'none', align = 'center' } = {}) {
  if (!el) return;
  el.style.textAlign = align;
  const isDark = color === '#000000';
  if (!el.dataset) el.dataset = {};
  if (bgMode === 'solid') {
    el.dataset.storyBgActive = '1';
    el.style.color = color;
    el.style.background = isDark ? '#ffffff' : '#000000';
    el.style.border = 'none';
    el.style.borderRadius = '14px';
    el.style.padding = '9px 16px';
    el.style.boxShadow = '0 6px 20px rgba(0,0,0,.3)';
  } else if (bgMode === 'soft') {
    el.dataset.storyBgActive = '1';
    el.style.color = color;
    el.style.background = isDark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.55)';
    el.style.border = 'none';
    el.style.borderRadius = '14px';
    el.style.padding = '9px 16px';
    el.style.boxShadow = '0 6px 18px rgba(0,0,0,.22)';
    el.style.backdropFilter = 'blur(6px)';
  } else if (bgMode === 'outline') {
    el.dataset.storyBgActive = '1';
    el.style.color = color;
    el.style.background = 'transparent';
    el.style.border = `2px solid ${color}`;
    el.style.borderRadius = '14px';
    el.style.padding = '7px 14px';
    el.style.boxShadow = 'none';
    el.style.backdropFilter = 'none';
  } else {
    el.dataset.storyBgActive = '0';
    el.style.color = color;
    el.style.background = 'transparent';
    el.style.border = 'none';
    el.style.borderRadius = '0';
    el.style.padding = '0';
    el.style.boxShadow = 'none';
    el.style.backdropFilter = 'none';
  }
}

window.selectStorySticker = (e, el) => {
  if (e) e.stopPropagation();
  $$('#storyEditorStage .sticker').forEach(s => s.classList.remove('active-sticker'));
  if (el) el.classList.add('active-sticker');
};

window.startStickerScale = (e, id) => {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  const el = document.getElementById(id);
  if (!el) return;
  const startPos = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
  const startScale = activeStickerScales[id] || 1.0;
  let rafId = 0;
  let pendingScale = startScale;
  const guide = $('#storySafeAreaGuide');
  if (guide) guide.classList.remove('hidden');

  const flush = () => {
    rafId = 0;
    const newScale = Math.max(0.5, Math.min(2.5, pendingScale));
    activeStickerScales[id] = newScale;
    el.style.transform = `translate(-50%, -50%) scale(${newScale.toFixed(2)})`;
    if (id === 'storyStageMusicSticker') State.musicScale = newScale;
    if (id === 'storyStageTextOverlay') State.textScale = newScale;
  };

  const move = (ev) => {
    if (ev.cancelable) ev.preventDefault();
    const curPos = ev.touches && ev.touches[0] ? ev.touches[0].clientX : ev.clientX;
    const diff = curPos - startPos;
    pendingScale = startScale + diff * 0.008;
    if (!rafId) rafId = requestAnimationFrame(flush);
  };

  const end = () => {
    if (rafId) cancelAnimationFrame(rafId);
    flush();
    if (guide) guide.classList.add('hidden');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', end);
    window.removeEventListener('touchmove', move);
    window.removeEventListener('touchend', end);
  };

  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', end);
};

window.setStoryMusicLayout = (layout, el) => {
  activeStoryMusicLayout = layout;
  $$('#storyMusicLayoutRow .music-layout-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  const stk = $('#storyStageMusicSticker');
  if (stk) {
    stk.classList.remove('layout-pill', 'layout-card', 'layout-minimal');
    stk.classList.add('layout-' + layout);
  }
};

window.setMusicClipDuration = (dur, el) => {
  activeMusicClipDur = dur;
  State.musicClipDur = dur;
  $$('#storyMusicTrimmer .dur-pill').forEach(p => p.classList.remove('active'));
  if (el) el.classList.add('active');
  const lbl = $('#musicClipDurLbl');
  if (lbl) lbl.textContent = dur + 's';
  const slider = $('#musicStartTimeSlider');
  if (slider) window.updateMusicStartTime(slider.value);
};

function makeStickerDraggable(el, onMoveCallback) {
  if (!el || el._isDraggableAttached) return;
  el._isDraggableAttached = true;
  let isDragging = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;
  let rafId = 0;
  let pendingPctX = 50;
  let pendingPctY = 50;

  const getPos = (e) => {
    const cx = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
    const cy = e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY;
    return { cx, cy };
  };

  const applyMove = () => {
    rafId = 0;
    el.style.left = pendingPctX + '%';
    el.style.top = pendingPctY + '%';
    if (onMoveCallback) onMoveCallback(pendingPctX, pendingPctY);
  };

  let snappedX = false, snappedY = false;

  const start = (e) => {
    if (e.target.closest('button') || e.target.classList.contains('story-resize-handle') || e.target.classList.contains('sticker-del-handle')) return;
    window.selectStorySticker(e, el);
    isDragging = true;
    const pos = getPos(e);
    startX = pos.cx;
    startY = pos.cy;
    const rect = el.getBoundingClientRect();
    const stageRect = el.parentElement.getBoundingClientRect();
    initialLeft = rect.left - stageRect.left + rect.width / 2;
    initialTop = rect.top - stageRect.top + rect.height / 2;
    el.style.transition = 'none';
    const stageEl = el.closest('.story-editor-stage');
    if (stageEl) stageEl.classList.add('dragging-active');
    const guide = $('#storySafeAreaGuide');
    if (guide) guide.classList.remove('hidden');
  };

  const move = (e) => {
    if (!isDragging) return;
    if (e.cancelable) e.preventDefault();
    const pos = getPos(e);
    const dx = pos.cx - startX;
    const dy = pos.cy - startY;
    const stageRect = el.parentElement.getBoundingClientRect();
    let newLeft = Math.max(30, Math.min(stageRect.width - 30, initialLeft + dx));
    let newTop = Math.max(40, Math.min(stageRect.height - 40, initialTop + dy));

    const centerX = stageRect.width / 2;
    const centerY = stageRect.height / 2;
    const guideV = $('#storyAlignGuide');
    const guideH = $('#storyAlignGuideH');
    const wasSnappedX = snappedX, wasSnappedY = snappedY;
    if (Math.abs(newLeft - centerX) < 14) {
      newLeft = centerX;
      snappedX = true;
      if (guideV) guideV.classList.remove('hidden');
    } else {
      snappedX = false;
      if (guideV) guideV.classList.add('hidden');
    }
    if (Math.abs(newTop - centerY) < 14) {
      newTop = centerY;
      snappedY = true;
      if (guideH) guideH.classList.remove('hidden');
    } else {
      snappedY = false;
      if (guideH) guideH.classList.add('hidden');
    }
    // Subtle haptic tick on snap-in, if the device supports it (no-op elsewhere).
    if ((snappedX && !wasSnappedX) || (snappedY && !wasSnappedY)) {
      try { if (navigator.vibrate) navigator.vibrate(8); } catch (_) {}
    }

    pendingPctX = Math.round((newLeft / stageRect.width) * 100);
    pendingPctY = Math.round((newTop / stageRect.height) * 100);
    if (!rafId) rafId = requestAnimationFrame(applyMove);
  };

  const end = () => {
    if (!isDragging) return;
    isDragging = false;
    if (rafId) cancelAnimationFrame(rafId);
    applyMove();
    el.style.transition = 'transform 0.15s ease';
    const guideV = $('#storyAlignGuide');
    const guideH = $('#storyAlignGuideH');
    if (guideV) guideV.classList.add('hidden');
    if (guideH) guideH.classList.add('hidden');
    snappedX = false; snappedY = false;
    const stageEl = el.closest('.story-editor-stage');
    if (stageEl) stageEl.classList.remove('dragging-active');
    const guide = $('#storySafeAreaGuide');
    if (guide) guide.classList.add('hidden');
  };

  el.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  el.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', end);
}

window.openStoryTextEditor = () => {
  const screen = $('#storyTextEditorScreen');
  if (!screen) return;
  screen.classList.remove('hidden');
  const inp = $('#storyTextOverlayInput');
  if (inp) {
    inp.value = activeStoryText || $('#storyEditorCaptionInput')?.value || '';
    inp.focus();
  }
  window.updateStoryTextLivePreview();
};

window.closeStoryTextEditor = () => {
  const screen = $('#storyTextEditorScreen');
  if (screen) screen.classList.add('hidden');
};

window.finishStoryTextEditor = () => {
  const inp = $('#storyTextOverlayInput');
  activeStoryText = (inp?.value || '').trim();
  const stg = $('#storyStageTextOverlay');
  const txt = $('#storyStageTextSpan');
  if (stg) {
    if (!activeStoryText) {
      stg.classList.add('hidden');
    } else {
      if (txt) txt.textContent = activeStoryText;
      stg.style.fontSize = activeStoryTextSize + 'px';
      stg.style.left = (State.textPosX || 50) + '%';
      stg.style.top = (State.textPosY || 68) + '%';
      stg.style.transform = `translate(-50%, -50%) scale(${State.textScale || 1})`;
      // Box style first (sets dataset.storyBgActive), then font preset reads
      // that flag to decide whether to draw the readability drop-shadow.
      applyStoryTextBoxStyle(stg, { color: activeStoryTextColor, bgMode: activeStoryTextBgMode, align: activeStoryTextAlign });
      applyStoryFontPreset(stg, activeStoryFont || 'modern');
      stg.classList.remove('hidden');
      makeStickerDraggable(stg, (px, py) => { State.textPosX = px; State.textPosY = py; });
    }
  }
  window.closeStoryTextEditor();
};

window.removeStoryTextOverlay = (e) => {
  if (e) e.stopPropagation();
  const stg = $('#storyStageTextOverlay');
  if (stg) stg.classList.add('hidden');
  activeStoryText = '';
  const inp = $('#storyTextOverlayInput');
  if (inp) inp.value = '';
};

window.updateStoryTextLivePreview = () => {
  const inp = $('#storyTextOverlayInput');
  const slider = $('#storyTextSizeSlider');
  if (!inp) return;
  if (slider) activeStoryTextSize = parseInt(slider.value, 10) || 28;
  inp.style.fontSize = activeStoryTextSize + 'px';
  applyStoryTextBoxStyle(inp, { color: activeStoryTextColor, bgMode: activeStoryTextBgMode, align: activeStoryTextAlign });
  applyStoryFontPreset(inp, activeStoryFont || 'modern');
};

window.selectOverlayFont = (font, el) => {
  activeStoryFont = font;
  $$('#storyTextEditorScreen .story-font-pill').forEach(p => p.classList.remove('active'));
  if (el) el.classList.add('active');
  window.updateStoryTextLivePreview();
};

window.toggleTextColorsRow = () => {
  const row = $('#storyTextColorsRow');
  if (row) row.classList.toggle('hidden');
};

const STORY_TEXT_BG_MODES = ['none', 'solid', 'soft', 'outline'];
window.cycleOverlayTextBgMode = () => {
  const idx = STORY_TEXT_BG_MODES.indexOf(activeStoryTextBgMode);
  activeStoryTextBgMode = STORY_TEXT_BG_MODES[(idx + 1) % STORY_TEXT_BG_MODES.length];
  activeStoryTextBg = activeStoryTextBgMode !== 'none'; // legacy flag kept for back-compat consumers
  const btn = $('#storyTextBgToggleBtn');
  if (btn) {
    btn.classList.toggle('active-toggle', activeStoryTextBgMode !== 'none');
    const labels = { none: 'Aa', solid: 'Fill', soft: 'Soft', outline: 'Outline' };
    btn.innerHTML = activeStoryTextBgMode === 'none'
      ? 'A<span style="font-size:11px;">★</span>'
      : `<span style="font-size:10.5px;">${labels[activeStoryTextBgMode]}</span>`;
  }
  window.updateStoryTextLivePreview();
};
// Back-compat alias — some older bound handlers may still reference this name.
window.toggleOverlayTextBg = window.cycleOverlayTextBgMode;

window.cycleOverlayTextAlign = () => {
  if (activeStoryTextAlign === 'center') activeStoryTextAlign = 'left';
  else if (activeStoryTextAlign === 'left') activeStoryTextAlign = 'right';
  else activeStoryTextAlign = 'center';
  window.updateStoryTextLivePreview();
};

window.setOverlayTextColor = (color) => {
  activeStoryTextColor = color;
  window.updateStoryTextLivePreview();
};

window.setStoryFont = (font, el) => {
  activeStoryFont = font;
  if (el && el.closest('#storyTextEditorScreen')) {
    $$('#storyTextEditorScreen .story-font-pill').forEach(p => p.classList.remove('active'));
    if (el) el.classList.add('active');
    window.updateStoryTextLivePreview();
    return;
  }
  $$('.story-font-pill').forEach(p => {
    if (p.closest('#storyFontControls')) p.classList.remove('active');
  });
  if (el) el.classList.add('active');
  const inp = $('#storyEditorCaptionInput');
  if (!inp) return;
  applyStoryFontPreset(inp, font || 'modern');
};

window.openStoryCreator = () => {
  const mod = $('#storyEditorModal');
  if (!mod) return;
  mod.classList.remove('hidden');
  const inp = $('#storyEditorFileInput');
  const ph = $('#storyEditorPlaceholder');
  const prev = $('#storyEditorPreviewImg');
  const loadingEl = $('#storyEditorImgLoading');
  const stepLbl = $('#storyEditorStepLabel');
  if (stepLbl) stepLbl.textContent = 'Create Story';
  if (ph && inp) {
    ph.onclick = () => inp.click();
  }
  if (inp) {
    inp.onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = ''; // allow re-picking the same file later
      if (!files.length) return;
      // ---- Video story path (single clip, ~15s, ≤10MB) ----
      const vidFile = files.find(f => f.type && f.type.startsWith('video/'));
      if (vidFile) {
        await handleStoryVideoPick(vidFile, ph, prev, loadingEl);
        return;
      }
      // Multi-photo carousel: up to 3 images per story item. New picks are
      // appended to any existing selection (respecting the 3-photo cap).
      State.storyCreatorImages = Array.isArray(State.storyCreatorImages) ? State.storyCreatorImages : [];
      const slotsLeft = 3 - State.storyCreatorImages.length;
      if (slotsLeft <= 0) { toast('You can add up to 3 photos per story', 'error'); return; }
      const batch = files.slice(0, slotsLeft);
      if (files.length > slotsLeft) toast('Added first ' + slotsLeft + ' photo(s) — max 3 per story');
      if (ph) ph.classList.add('hidden');
      if (loadingEl) loadingEl.classList.remove('hidden');
      for (const f of batch) {
        if (!f.type || !f.type.startsWith('image/')) { toast('Skipped a non-image file', 'error'); continue; }
        if (f.size > 20 * 1024 * 1024) { toast('Skipped a photo over 20MB', 'error'); continue; }
        let url = null;
        try {
          const previewDataUrl = await resizeImageToDataUrl(f, 1280, 0.82);
          const res = await api('/upload-photo', { method: 'POST', body: { dataUrl: previewDataUrl, kind: 'post' } });
          url = res.url || previewDataUrl;
        } catch (err) {
          try {
            const r2 = await uploadPermanentImage(f, { kind: 'post', maxDim: 1200, quality: 0.82 });
            url = r2.url;
          } catch (_) {
            try { url = URL.createObjectURL(f); } catch (_) {}
          }
        }
        if (url) State.storyCreatorImages.push(url);
      }
      if (loadingEl) loadingEl.classList.add('hidden');
      // First image is the primary preview + legacy single-image field.
      State.storyCreatorImgUrl = State.storyCreatorImages[0] || null;
      if (prev && State.storyCreatorImgUrl) { prev.src = State.storyCreatorImgUrl; prev.classList.remove('hidden'); }
      renderStoryEditorPhotoStrip();
    };
  }
  const initSpan = $('#storyPubMeInitials');
  if (initSpan && State.user) {
    initSpan.textContent = (State.user.displayName || State.user.username || 'AJ').slice(0,2).toUpperCase();
  }
  // Show the safe-area guide only while a sticker is actively being dragged/scaled
  // (see makeStickerDraggable / startStickerScale) — kept hidden by default so the
  // canvas looks clean, matching the "cleaner preview/publish flow" goal.
  const guide = $('#storySafeAreaGuide');
  if (guide) guide.classList.add('hidden');
};

// Handle a video pick in the story editor: validate size/duration, preview it,
// and upload as a base64 data URL (durable GitHub media path, ≤10MB).
async function handleStoryVideoPick(file, ph, prev, loadingEl) {
  const MAX_BYTES = 10 * 1024 * 1024;      // 10 MB
  const MAX_SECONDS = 20;                    // short story clip
  if (file.size > MAX_BYTES) { toast('Video too large — keep it under 10MB', 'error'); return; }
  // Probe duration before committing.
  let durationOk = true;
  try {
    const localUrl = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata'; probe.src = localUrl;
    await new Promise((resolve) => {
      probe.onloadedmetadata = () => resolve();
      probe.onerror = () => resolve();
      setTimeout(resolve, 4000);
    });
    if (probe.duration && isFinite(probe.duration) && probe.duration > MAX_SECONDS + 0.5) durationOk = false;
    URL.revokeObjectURL(localUrl);
  } catch (_) {}
  if (!durationOk) { toast('Video is too long — max ' + MAX_SECONDS + 's for a story', 'error'); return; }

  // Clear any photo selection (a story item is video OR photos, not both).
  State.storyCreatorImages = [];
  renderStoryEditorPhotoStrip();
  if (ph) ph.classList.add('hidden');
  if (loadingEl) loadingEl.classList.remove('hidden');
  // Show a local preview immediately.
  const vidPrev = $('#storyEditorPreviewVideo');
  const localUrl = URL.createObjectURL(file);
  if (prev) { prev.src = ''; prev.classList.add('hidden'); }
  if (vidPrev) { vidPrev.src = localUrl; vidPrev.classList.remove('hidden'); vidPrev.play().catch(() => {}); }
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(file);
    });
    const res = await api('/upload-photo', { method: 'POST', body: { dataUrl, kind: 'post' } });
    State.storyCreatorVideoUrl = res.url || dataUrl;
    State.storyCreatorImgUrl = null;
    if (res.persisted === false) toast('Video will post but may not persist (no durable media host configured)');
  } catch (err) {
    toast('Video upload failed: ' + (err.message || ''), 'error');
    State.storyCreatorVideoUrl = null;
    if (vidPrev) { vidPrev.src = ''; vidPrev.classList.add('hidden'); }
    if (ph) ph.classList.remove('hidden');
  } finally {
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

// Render the multi-photo thumbnail strip + counter in the story editor.
// Tapping a thumb makes it the primary preview; the ✕ removes it; a trailing
// "+" tile lets the user add more (up to 3).
function renderStoryEditorPhotoStrip() {
  const strip = $('#storyEditorPhotoStrip');
  const countBadge = $('#storyEditorPhotoCount');
  const imgs = Array.isArray(State.storyCreatorImages) ? State.storyCreatorImages : [];
  if (!strip) return;
  if (imgs.length <= 1) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    if (countBadge) countBadge.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');
  if (countBadge) { countBadge.classList.remove('hidden'); countBadge.textContent = '1/' + imgs.length; }
  strip.innerHTML = '';
  imgs.forEach((url, idx) => {
    const t = document.createElement('div');
    t.className = 'story-strip-thumb' + (idx === 0 ? ' active' : '');
    t.innerHTML = `<img src="${String(url).replace(/"/g, '%22')}" alt="photo ${idx + 1}" />` +
      `<button type="button" class="story-strip-del" aria-label="Remove photo">✕</button>`;
    t.querySelector('img').addEventListener('click', () => {
      const prev = $('#storyEditorPreviewImg');
      if (prev) { prev.src = url; prev.classList.remove('hidden'); }
      strip.querySelectorAll('.story-strip-thumb').forEach((el, i) => el.classList.toggle('active', i === idx));
    });
    t.querySelector('.story-strip-del').addEventListener('click', (e) => {
      e.stopPropagation();
      State.storyCreatorImages.splice(idx, 1);
      State.storyCreatorImgUrl = State.storyCreatorImages[0] || null;
      const prev = $('#storyEditorPreviewImg');
      if (prev) {
        if (State.storyCreatorImgUrl) { prev.src = State.storyCreatorImgUrl; prev.classList.remove('hidden'); }
        else { prev.src = ''; prev.classList.add('hidden'); const phEl = $('#storyEditorPlaceholder'); if (phEl) phEl.classList.remove('hidden'); }
      }
      renderStoryEditorPhotoStrip();
    });
    strip.appendChild(t);
  });
  if (imgs.length < 3) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'story-strip-add';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Add photo');
    add.addEventListener('click', () => { const fi = $('#storyEditorFileInput'); if (fi) fi.click(); });
    strip.appendChild(add);
  }
}

window.closeStoryCreator = () => {
  const mod = $('#storyEditorModal');
  if (mod) mod.classList.add('hidden');
  State.storyCreatorImages = [];
  State.storyCreatorVideoUrl = null;
  const strip = $('#storyEditorPhotoStrip'); if (strip) { strip.classList.add('hidden'); strip.innerHTML = ''; }
  const countBadge = $('#storyEditorPhotoCount'); if (countBadge) countBadge.classList.add('hidden');
  const vidPrev = $('#storyEditorPreviewVideo'); if (vidPrev) { try { vidPrev.pause(); } catch (_) {} vidPrev.src = ''; vidPrev.classList.add('hidden'); }
  const player = $('#storyBgAudioPlayer');
  if (player) { player.pause(); player.src = ''; }
  selectedStoryMusicId = null;
  const stk = $('#storyStageMusicSticker');
  if (stk) {
    stk.classList.add('hidden');
    stk.style.left = '50%';
    stk.style.top = '32%';
    stk.style.transform = 'translate(-50%, -50%) scale(1)';
    stk.classList.remove('active-sticker');
    stk.className = 'story-music-sticker layout-pill sticker hidden';
  }
  const stgText = $('#storyStageTextOverlay');
  const stgTextSpan = $('#storyStageTextSpan');
  if (stgText) {
    stgText.classList.add('hidden');
    stgText.style.left = '50%';
    stgText.style.top = '68%';
    stgText.style.transform = 'translate(-50%, -50%) scale(1)';
    stgText.classList.remove('active-sticker');
    applyStoryTextBoxStyle(stgText, { color: '#ffffff', bgMode: 'none', align: 'center' });
    applyStoryFontPreset(stgText, 'modern');
  }
  if (stgTextSpan) stgTextSpan.textContent = 'Text';
  const trim = $('#storyMusicTrimmer');
  if (trim) trim.classList.add('hidden');
  const prev = $('#storyEditorPreviewImg');
  if (prev) { prev.src = ''; prev.classList.add('hidden'); }
  const loadingEl = $('#storyEditorImgLoading'); if (loadingEl) loadingEl.classList.add('hidden');
  const fc = $('#storyFontControls'); if (fc) fc.classList.add('hidden');
  const colorRow = $('#storyTextColorsRow'); if (colorRow) colorRow.classList.add('hidden');
  const slider = $('#storyTextSizeSlider'); if (slider) slider.value = '28';
  const guide = $('#storySafeAreaGuide'); if (guide) guide.classList.add('hidden');
  $$('#storyMusicLayoutRow .music-layout-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  activeStoryFont = 'modern'; activeStoryText = ''; activeStoryTextColor = '#ffffff';
  activeStoryTextBg = false; activeStoryTextBgMode = 'none'; activeStoryTextAlign = 'center'; activeStoryTextSize = 28;
  activeStoryMusicLayout = 'pill';
  activeStickerScales = { storyStageMusicSticker: 1.0, storyStageTextOverlay: 1.0 };
  State.musicPosX = 50; State.musicPosY = 32; State.musicStartTime = 0; State.musicScale = 1.0; State.musicClipDur = 30;
  State.textPosX = 50; State.textPosY = 68; State.textScale = 1.0;
  const ph = $('#storyEditorPlaceholder');
  if (ph) ph.classList.remove('hidden');
  const cap = $('#storyEditorCaptionInput');
  if (cap) { cap.value = ''; cap.style.fontFamily = ''; cap.style.fontWeight = ''; cap.style.fontStyle = ''; cap.style.textTransform = ''; cap.style.letterSpacing = ''; }
  State.storyCreatorImgUrl = null;
  const pubAll = $('#storyPubBtnAll'); if (pubAll) pubAll.disabled = false;
  const pubCf = $('#storyPubBtnCf'); if (pubCf) pubCf.disabled = false;
};

window.promptStoryCaption = () => {
  const cap = $('#storyEditorCaptionInput');
  if (cap) cap.focus();
};

window.promptStoryMention = () => {
  const cap = $('#storyEditorCaptionInput');
  if (cap) {
    cap.value = cap.value + (cap.value && !cap.value.endsWith(' ') ? ' ' : '') + '@';
    cap.focus();
  }
};

window.openStoryMusicSheet = () => {
  const sh = $('#storyMusicSheet');
  if (sh) sh.classList.remove('hidden');
  window.filterStorySongs();
};

window.closeStoryMusicSheet = () => {
  const sh = $('#storyMusicSheet');
  if (sh) sh.classList.add('hidden');
};

window.closeStoryMusicSheetOnBackdrop = (e) => {
  if (e && e.target && e.target.id === 'storyMusicSheet') window.closeStoryMusicSheet();
};

window.selectStoryMusicCategory = (cat, el) => {
  activeStoryMusicCat = cat;
  $$('.story-pill').forEach(p => p.classList.remove('active'));
  if (el) el.classList.add('active');
  window.filterStorySongs();
};

let storyMusicSearchTimer = null;
let liveSearchResults = [];

window.filterStorySongs = () => {
  const container = $('#storySongsListContainer');
  const q = ($('#storyMusicSearchInput')?.value || '').toLowerCase().trim();
  if (!container) return;

  if (q.length >= 2) {
    container.innerHTML = `<div style="text-align:center; padding:30px; color:#a3a3a3;">🔍 Searching 30s clips for "${escapeHtml(q)}"...</div>`;
    clearTimeout(storyMusicSearchTimer);
    storyMusicSearchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&limit=15`);
        const data = await res.json();
        if (data && data.results && data.results.length > 0) {
          liveSearchResults = data.results.filter(r => r.previewUrl).map(r => ({
            id: r.trackId || Math.floor(Math.random()*100000),
            title: r.trackName || 'Song',
            artist: r.artistName || 'Artist',
            category: 'search',
            duration: '0:30',
            art: r.artworkUrl100 || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=120&q=80',
            audio: r.previewUrl
          }));
          renderSongListItems(liveSearchResults);
        } else {
          container.innerHTML = `<div style="text-align:center; padding:30px; color:#737373;">No 30s clips found for "${escapeHtml(q)}".</div>`;
        }
      } catch (e) {
        renderSongListItems(storyMusicCatalog.filter(s => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)));
      }
    }, 350);
    return;
  }

  const list = storyMusicCatalog.filter(s => {
    const matchCat = activeStoryMusicCat === 'all' || s.category === activeStoryMusicCat;
    return matchCat;
  });
  renderSongListItems(list);
};

function renderSongListItems(list) {
  const container = $('#storySongsListContainer');
  if (!container) return;
  if (list.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:30px; color:#737373;">No songs found matching your search.</div>`;
    return;
  }
  container.innerHTML = list.map(s => {
    const isPlaying = selectedStoryMusicId === s.id && !($('#storyBgAudioPlayer')?.paused);
    return `
      <div class="story-song-item" onclick="pickStoryMusic(${s.id})">
        <div class="story-song-left">
          <img src="${s.art}" class="story-song-art" alt="art" />
          <div class="story-song-meta">
            <div class="story-song-name">${escapeHtml(s.title)}</div>
            <div class="story-song-artist">${escapeHtml(s.artist)}</div>
          </div>
        </div>
        <div class="story-song-right">
          <span class="story-song-dur">${s.duration}</span>
          <button type="button" class="story-play-btn ${isPlaying ? 'playing' : ''}" onclick="toggleStorySongPreview(event, ${s.id}, '${s.audio}')">
            ${isPlaying ? '⏸' : '▶'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

window.toggleStorySongPreview = (e, id, url) => {
  if (e) e.stopPropagation();
  const player = $('#storyBgAudioPlayer');
  if (!player) return;
  if (selectedStoryMusicId === id && !player.paused) {
    player.pause();
    selectedStoryMusicId = null;
  } else {
    player.src = url;
    player.play().catch(() => {});
    selectedStoryMusicId = id;
  }
  window.filterStorySongs();
};

window.pickStoryMusic = (id) => {
  let song = storyMusicCatalog.find(s => s.id === id);
  if (!song) song = liveSearchResults.find(s => s.id === id);
  if (!song) return;
  selectedStoryMusicId = id;
  const player = $('#storyBgAudioPlayer');
  if (player) { player.src = song.audio; player.currentTime = State.musicStartTime || 0; player.play().catch(() => {}); }
  
  const stk = $('#storyStageMusicSticker');
  if (stk) {
    $('#storyStageMusicArt').src = song.art;
    $('#storyStageMusicTitle').textContent = song.title;
    $('#storyStageMusicArtist').textContent = song.artist;
    stk.style.left = (State.musicPosX || 50) + '%';
    stk.style.top = (State.musicPosY || 32) + '%';
    stk.classList.remove('hidden', 'layout-pill', 'layout-card', 'layout-minimal');
    stk.classList.add('layout-' + (activeStoryMusicLayout || 'pill'));
    makeStickerDraggable(stk, (px, py) => { State.musicPosX = px; State.musicPosY = py; });
  }
  window.closeStoryMusicSheet();

  const trim = $('#storyMusicTrimmer');
  if (trim) {
    $('#trimmerSongTitle').textContent = song.title + ' · ' + song.artist;
    const bars = $('#trimmerWaveformBars');
    if (bars) {
      let html = '';
      for (let i = 0; i < 35; i++) {
        const h = Math.floor(Math.random() * 22) + 8;
        html += `<div class="waveform-bar-item ${i < 8 ? 'active' : ''}" style="height:${h}px;"></div>`;
      }
      bars.innerHTML = html;
    }
    trim.classList.remove('hidden');
  }
};

window.updateMusicStartTime = (val) => {
  const sec = parseInt(val, 10) || 0;
  State.musicStartTime = sec;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const lbl = $('#musicStartTimeLbl');
  if (lbl) lbl.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
  const player = $('#storyBgAudioPlayer');
  if (player && !player.paused) player.currentTime = sec;
};

window.closeMusicTrimmer = () => {
  const trim = $('#storyMusicTrimmer');
  if (trim) trim.classList.add('hidden');
};

window.removeStoryMusic = (e) => {
  if (e) e.stopPropagation();
  selectedStoryMusicId = null;
  const player = $('#storyBgAudioPlayer');
  if (player) { player.pause(); player.src = ''; }
  const stk = $('#storyStageMusicSticker');
  if (stk) stk.classList.add('hidden');
};

window.publishStoryWithMusic = async (isCf = false) => {
  const capVal = ($('#storyEditorCaptionInput')?.value || '').trim();
  const text = activeStoryText || capVal;
  const videoUrl = State.storyCreatorVideoUrl || null;
  const storyImages = videoUrl ? [] : (Array.isArray(State.storyCreatorImages) && State.storyCreatorImages.length > 0
    ? State.storyCreatorImages.slice(0, 3)
    : (State.storyCreatorImgUrl ? [State.storyCreatorImgUrl] : []));
  const imageUrl = storyImages[0] || State.storyCreatorImgUrl || null;
  let song = storyMusicCatalog.find(s => s.id === selectedStoryMusicId);
  if (!song) song = liveSearchResults.find(s => s.id === selectedStoryMusicId);
  const music = song ? {
    id: song.id, title: song.title, artist: song.artist, audio: song.audio, art: song.art,
    posX: State.musicPosX || 50, posY: State.musicPosY || 32, startTime: State.musicStartTime || 0,
    clipDur: State.musicClipDur || 30, scale: State.musicScale || 1.0, layout: activeStoryMusicLayout || 'pill',
  } : null;
  const style = {
    font: activeStoryFont, color: activeStoryTextColor, bg: activeStoryTextBg, bgMode: activeStoryTextBgMode,
    align: activeStoryTextAlign, size: activeStoryTextSize, posX: State.textPosX || 50, posY: State.textPosY || 68,
    scale: State.textScale || 1.0,
  };

  if (!text && !imageUrl && !videoUrl) {
    toast('Pick a photo/video or type a text caption first!', 'error');
    return;
  }
  if (isCf && (!Array.isArray(State.closeFriends) || State.closeFriends.length === 0)) {
    toast('Add at least one Close Friend first', 'error');
    setTimeout(() => openCloseFriendsSheet(), 120);
    return;
  }
  const pubAll = $('#storyPubBtnAll');
  const pubCf = $('#storyPubBtnCf');
  const targetBtn = isCf ? pubCf : pubAll;
  const originalHtml = targetBtn ? targetBtn.innerHTML : '';
  if (pubAll) pubAll.disabled = true;
  if (pubCf) pubCf.disabled = true;
  if (targetBtn) targetBtn.innerHTML = '<span class="story-pub-spinner"></span> Posting…';
  try {
    await api('/posts/create', {
      method: 'POST',
      body: {
        text,
        imageUrl,
        images: storyImages,
        videoUrl,
        music,
        style,
        story: true,
        audience: isCf ? 'close_friends' : 'all',
        storyExpiresAt: Date.now() + STORY_TTL_MS,
      }
    });
    window.closeStoryCreator();
    loadPosts();
    toast(music ? `🎉 Story published with 30s background song "${music.title}"!` : '🎉 Story published!', 'success');
  } catch (e) {
    toast(e.message || 'Story publish failed', 'error');
    if (pubAll) pubAll.disabled = false;
    if (pubCf) pubCf.disabled = false;
    if (targetBtn) targetBtn.innerHTML = originalHtml;
  }
};


let _postDraftMusic = null;
let _postSearchTimer = null;

function updatePostMusicUI() {
  const prev = $('#postMusicPreview');
  const title = $('#postMusicTitle');
  const artist = $('#postMusicArtist');
  if (!prev) return;
  if (_postDraftMusic && _postDraftMusic.title) {
    prev.classList.remove('hidden');
    if (title) title.textContent = _postDraftMusic.title;
    if (artist) artist.textContent = _postDraftMusic.artist || 'Song attached';
  } else {
    prev.classList.add('hidden');
    if (title) title.textContent = 'Music attached';
    if (artist) artist.textContent = '';
  }
}

function renderPostSongResults(list) {
  const box = $('#postSongList');
  if (!box) return;
  if (!list || !list.length) { box.innerHTML = '<div class="note-song-empty">Type to search songs…</div>'; return; }
  box.innerHTML = '';
  list.forEach(s => {
    const item = document.createElement('div');
    item.className = 'note-song-item';
    item.innerHTML = `
      <img src="${escapeHtml(s.art || '')}" class="nsi-art" alt="" />
      <div class="nsi-m"><div class="nsi-t">${escapeHtml(s.title)}</div><div class="nsi-a">${escapeHtml(s.artist || '')}</div></div>
      <span class="nsi-play">▶</span>`;
    item.querySelector('.nsi-play').addEventListener('click', (e) => { e.stopPropagation(); if (s.audio) playNotePreview(s.audio); });
    item.addEventListener('click', () => {
      stopNotePreviewAudio();
      _postDraftMusic = { title: s.title, artist: s.artist || '', audio: s.audio || '', art: s.art || '' };
      updatePostMusicUI();
      const picker = $('#postSongPicker'); if (picker) picker.classList.add('hidden');
    });
    box.appendChild(item);
  });
}

async function searchPostSongs(q) {
  if (!q || !q.trim()) { renderPostSongResults([]); return; }
  try {
    const res = await fetch('https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&media=music&limit=15');
    const data = await res.json();
    let list = (data.results || []).filter(r => r.previewUrl).map(r => ({
      title: r.trackName || 'Song', artist: r.artistName || 'Artist', art: r.artworkUrl100 || '', audio: r.previewUrl,
    }));
    if (list.length === 0 && typeof storyMusicCatalog !== 'undefined') {
      const ql = q.toLowerCase();
      list = storyMusicCatalog.filter(s => s.title.toLowerCase().includes(ql) || s.artist.toLowerCase().includes(ql));
    }
    renderPostSongResults(list);
  } catch (_) {
    if (typeof storyMusicCatalog !== 'undefined') {
      const ql = q.toLowerCase();
      const list = storyMusicCatalog.filter(s => s.title.toLowerCase().includes(ql) || s.artist.toLowerCase().includes(ql));
      renderPostSongResults(list);
    } else renderPostSongResults([]);
  }
}

function renderPostAttachGrid() {
  const grid = $('#postAttachGrid');
  const prev = $('#postAttachPreview');
  const btn = $('#postAttachBtn');
  if (!grid || !prev) return;
  State.postAttaches = State.postAttaches || [];
  if (State.postAttaches.length === 0) {
    prev.classList.add('hidden');
    if (btn) btn.innerHTML = '<i data-lucide="image"></i> Photo';
    return;
  }
  prev.classList.remove('hidden');
  if (btn) btn.innerHTML = `<i data-lucide="image"></i> Photo (${State.postAttaches.length}/3)`;
  grid.innerHTML = State.postAttaches.map((item, idx) => `
    <div style="position:relative; width:80px; height:80px; border-radius:10px; overflow:hidden; border:1px solid var(--line); flex-shrink:0; background:#000;">
      <img src="${item.url || item.localUrl}" style="width:100%; height:100%; object-fit:cover;" />
      <button type="button" onclick="window._removePostAttach(${idx})" style="position:absolute; top:4px; right:4px; background:rgba(0,0,0,0.7); color:#fff; border:none; border-radius:50%; width:20px; height:20px; font-size:12px; display:flex; align-items:center; justify-content:center; cursor:pointer;">✕</button>
    </div>
  `).join('');
  refreshIcons();
}

window._removePostAttach = (idx) => {
  if (State.postAttaches && State.postAttaches[idx]) {
    State.postAttaches.splice(idx, 1);
    renderPostAttachGrid();
  }
};

function bindFeedComposer() {
  $('#postAttachBtn').addEventListener('click', () => $('#postFileInput').click());
  const pmBtn = $('#postMusicBtn');
  if (pmBtn) pmBtn.addEventListener('click', () => {
    const picker = $('#postSongPicker'); if (!picker) return;
    const show = picker.classList.contains('hidden');
    picker.classList.toggle('hidden', !show);
    if (show) { renderPostSongResults([]); setTimeout(() => $('#postSongSearch')?.focus(), 80); }
    else stopNotePreviewAudio();
  });
  const pmRemove = $('#postMusicRemove');
  if (pmRemove) pmRemove.addEventListener('click', () => { _postDraftMusic = null; updatePostMusicUI(); stopNotePreviewAudio(); });
  const pmSearch = $('#postSongSearch');
  if (pmSearch) pmSearch.addEventListener('input', () => {
    clearTimeout(_postSearchTimer);
    _postSearchTimer = setTimeout(() => searchPostSongs(pmSearch.value), 350);
  });
  $('#postFileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []); e.target.value = '';
    if (files.length === 0) return;
    State.postAttaches = State.postAttaches || [];
    if (State.postAttaches.length >= 3) { toast('Maximum 3 photos per post', 'error'); return; }
    const availableSlot = 3 - State.postAttaches.length;
    const toUpload = files.slice(0, availableSlot);

    for (const f of toUpload) {
      if (!f.type.startsWith('image/')) { toast('Only images allowed', 'error'); continue; }
      if (f.size > 15 * 1024 * 1024) { toast('Max 15MB per image', 'error'); continue; }
      const localUrl = URL.createObjectURL(f);
      const tempItem = { localUrl, name: f.name };
      State.postAttaches.push(tempItem);
      renderPostAttachGrid();
      const st = $('#postAttachStatus'); if (st) st.textContent = 'Uploading ' + f.name + '…';
      const pr = $('#postAttachProgress'); if (pr) pr.style.width = '20%';
      try {
        const res = await uploadPermanentImage(f, { kind: 'post', maxDim: 1200, quality: 0.82, onProgress: (p) => { if (pr) pr.style.width = p + '%'; } });
        tempItem.url = res.url;
        if (st) st.textContent = 'Ready!';
        if (pr) pr.style.width = '100%';
      } catch (err) {
        try {
          const res2 = await uploadImage(f, (p) => { if (pr) pr.style.width = p + '%'; });
          tempItem.url = res2.url;
          if (st) st.textContent = 'Ready!';
          if (pr) pr.style.width = '100%';
        } catch (err2) {
          toast('Failed to upload ' + f.name, 'error');
          const i = State.postAttaches.indexOf(tempItem);
          if (i >= 0) State.postAttaches.splice(i, 1);
        }
      }
      renderPostAttachGrid();
    }
  });
  $('#postCancelAttachBtn').addEventListener('click', clearPostAttach);
  $('#postSubmitBtn').addEventListener('click', async () => {
    const text = $('#postInput').value.trim();
    const validAttaches = (State.postAttaches || []).filter(a => a.url);
    if (!text && validAttaches.length === 0) { toast('Write something or attach up to 3 photos', 'error'); return; }
    const btn = $('#postSubmitBtn');
    btn.disabled = true;
    try {
      const images = validAttaches.map(a => a.url);
      const imageUrl = images[0] || null;
      const chk = $('#postScratchCheckbox');
      const isScratch = !!(chk && chk.checked);
      await api('/posts/create', { method: 'POST', body: { text, imageUrl, images, isScratch, music: _postDraftMusic } });
      $('#postInput').value = '';
      if (chk) chk.checked = false;
      _postDraftMusic = null; updatePostMusicUI();
      const picker = $('#postSongPicker'); if (picker) picker.classList.add('hidden');
      clearPostAttach();
      lastPostsSignature = null; // force next loadPosts() to re-render even if list becomes empty
      loadPosts();
      closePostComposer();
      toast('Posted!', 'success');
    } catch (e) { toast(e.message || 'Post failed', 'error'); }
    finally { btn.disabled = false; }
  });
}

function clearPostAttach() {
  State.postAttach = null;
  State.postAttaches = [];
  renderPostAttachGrid();
  const st = $('#postAttachStatus'); if (st) st.textContent = '';
  const pr = $('#postAttachProgress'); if (pr) pr.style.width = '0%';
}

// ====== Profile ======

/**
 * Client-side resize + compress an image File to a JPEG data URL.
 * @param {File} file
 * @param {number} maxDim — max width/height in px
 * @param {number} quality — 0..1
 */
function resizeImageToDataUrl(file, maxDim = 600, quality = 0.85) {
  // Prefer createImageBitmap: on most mobile browsers it decodes off the main
  // thread, which avoids the "page freezes for a second" feeling that a
  // synchronous <img>.decode-on-load can cause for large camera photos
  // (e.g. 12MP+ shots) right when the story editor is trying to stay responsive.
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).then((bitmap) => {
      try {
        let width = bitmap.width, height = bitmap.height;
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close && bitmap.close();
        return canvas.toDataURL('image/jpeg', quality);
      } catch (e) {
        bitmap.close && bitmap.close();
        throw e;
      }
    }).catch(() => resizeImageToDataUrlLegacy(file, maxDim, quality));
  }
  return resizeImageToDataUrlLegacy(file, maxDim, quality);
}

function resizeImageToDataUrlLegacy(file, maxDim = 600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Read failed'));
    reader.onload = () => { img.src = reader.result; };
    img.onerror = () => reject(new Error('Decode failed'));
    img.onload = () => {
      try {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      } catch (e) { reject(e); }
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Permanent photo upload via /api/upload-photo (commits to GitHub repo → raw.githubusercontent.com CDN).
 * Returns: { url, persisted }
 */
async function uploadPermanentImage(file, { kind = 'avatar', maxDim = 600, quality = 0.85, onProgress } = {}) {
  if (onProgress) onProgress(10);
  const dataUrl = await resizeImageToDataUrl(file, maxDim, quality);
  if (onProgress) onProgress(40);
  const res = await api('/upload-photo', { method: 'POST', body: { dataUrl, kind } });
  if (onProgress) onProgress(100);
  return res;
}

function bindProfile() {
  $('#profilePhotoBtn').addEventListener('click', () => $('#profilePhotoInput').click());
  $('#profilePhotoInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Only images', 'error'); return; }
    if (f.size > 15 * 1024 * 1024) { toast('Max 15MB', 'error'); return; }
    const status = $('#profilePhotoStatus');
    status.textContent = 'Uploading 0%';
    try {
      const res = await uploadPermanentImage(f, { kind: 'avatar', maxDim: 500, quality: 0.85, onProgress: (p) => { status.textContent = 'Uploading ' + p + '%'; }});
      const data = await api('/user/update', { method: 'POST', body: { photoUrl: res.url } });
      State.user = data.user;
      localStorage.setItem('ps_user', JSON.stringify(State.user));
      hydrateMeChips();
      status.textContent = res.persisted ? 'Photo updated ✓ (permanent)' : 'Photo updated (inline fallback)';
      toast('Profile photo updated', 'success');
    } catch (err) { status.textContent = ''; toast('Upload failed: ' + (err.message || ''), 'error'); }
  });

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const status = $('#profileStatus');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    status.textContent = '';
    try {
      const data = await api('/user/update', { method: 'POST', body: {
        displayName: String(fd.get('displayName') || '').trim(),
        username: String(fd.get('username') || '').trim(),
        bio: String(fd.get('bio') || '').trim(),
        dateOfBirth: String(fd.get('dateOfBirth') || '').trim()
      }});
      State.user = data.user;
      localStorage.setItem('ps_user', JSON.stringify(State.user));
      hydrateMeChips();
      status.textContent = 'Saved ✓';
      toast('Profile updated', 'success');
    } catch (err) { status.textContent = ''; toast(err.message || 'Update failed', 'error'); }
    finally { btn.disabled = false; }
  });
}

// ====== Schedule ======
function bindSchedule() {
  $('#scheduleBtn').addEventListener('click', openSchedule);
  $('#scheduleOpenBtn').addEventListener('click', openSchedule);
  $$('[data-close-modal]').forEach(b => b.addEventListener('click', () => $('#scheduleModal').classList.add('hidden')));
  $('#scheduleModal').addEventListener('click', (e) => {
    if (e.target.id === 'scheduleModal') $('#scheduleModal').classList.add('hidden');
  });
  $('#scheduleSubmit').addEventListener('click', async () => {
    const text = $('#scheduleText').value.trim();
    const when = $('#scheduleAt').value;
    const err = $('#scheduleError');
    err.textContent = '';
    if (!text) { err.textContent = 'Message required'; return; }
    if (!when) { err.textContent = 'Pick a date/time'; return; }
    const ts = new Date(when).getTime();
    if (!ts || ts < Date.now() + 5000) { err.textContent = 'Must be at least 5s in future'; return; }
    try {
      await api('/messages/schedule', { method: 'POST', body: {
        roomId: State.currentRoom.id, text, deliverAt: ts
      }});
      $('#scheduleText').value = ''; $('#scheduleAt').value = '';
      toast('Scheduled!', 'success');
      loadScheduled();
    } catch (e) { err.textContent = e.message || 'Failed'; }
  });
}

function openSchedule() {
  $('#scheduleModal').classList.remove('hidden');
  refreshIcons();
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  $('#scheduleAt').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  loadScheduled();
}

async function loadScheduled() {
  const list = $('#scheduleList');
  list.innerHTML = '<li class="muted small">Loading…</li>';
  try {
    const data = await api('/messages/scheduled');
    State.scheduled = data.scheduled || [];
    if (State.scheduled.length === 0) { list.innerHTML = '<li class="muted small">No scheduled messages</li>'; return; }
    list.innerHTML = '';
    State.scheduled.forEach(s => {
      const li = document.createElement('li');
      const txt = document.createElement('span');
      txt.className = 'text';
      txt.textContent = (s.text || '(image)').slice(0, 60);
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = new Date(s.deliverAt).toLocaleString();
      const del = document.createElement('button');
      del.className = 'ghost-btn';
      del.innerHTML = '<i data-lucide="x"></i>';
      del.addEventListener('click', async () => {
        try { await api('/messages/scheduled/cancel', { method: 'POST', body: { id: s.id } }); loadScheduled(); }
        catch (e) { toast(e.message || 'Cancel failed', 'error'); }
      });
      li.appendChild(txt); li.appendChild(when); li.appendChild(del);
      list.appendChild(li);
    });
    refreshIcons();
  } catch (e) { list.innerHTML = '<li class="muted small">Error loading</li>'; }
}

// ====== Lightbox ======
function openLightbox(url, uploaderName) {
  $('#lightboxImg').src = url;
  $('#lightboxUploader').textContent = uploaderName ? ('Shared by ' + uploaderName) : '';
  $('#lightboxDownload').href = url;
  const lb = $('#lightbox');
  lb.classList.remove('hidden');
  const inner = lb.querySelector('.lightbox-inner');
  if (inner) motionAnimate(inner,
    { opacity: [0, 1], transform: ['scale(.92)', 'scale(1)'] },
    { duration: 0.28, easing: [0.2, 0.85, 0.2, 1] }
  );
  refreshIcons();
}

// ============================================================
// ===== Notifications panel
// ============================================================
let _notifData = { notifications: [], unread: 0 };

async function openNotifications() {
  const sheet = $('#notifSheet');
  const list = $('#notifList');
  list.innerHTML = '<li class="notif-empty"><div class="ico"><i data-lucide="bell"></i></div><div>Loading…</div></li>';
  sheet.classList.remove('hidden');
  const card = sheet.querySelector('.sheet-card');
  if (card) motionAnimate(card,
    { transform: ['translateY(100%)', 'translateY(0)'], opacity: [0.6, 1] },
    { duration: 0.36, easing: [0.2, 0.85, 0.15, 1] }
  );
  refreshIcons();
  try {
    const data = await api('/notifications');
    _notifData = data;
    renderNotifications();
    // Mark seen after a short delay so the unread highlight is visible first
    setTimeout(async () => {
      try { await api('/notifications/seen', { method: 'POST' }); }
      catch (_) {}
      // Force notif poller refresh
      pollNotifications();
    }, 1500);
  } catch (e) {
    list.innerHTML = '<li class="notif-empty"><div>Could not load notifications</div></li>';
  }
}

function closeNotifications() {
  $('#notifSheet').classList.add('hidden');
}

function renderNotifications() {
  const list = $('#notifList');
  list.innerHTML = '';
  const items = _notifData.notifications || [];
  if (items.length === 0) {
    list.innerHTML = `<li class="notif-empty">
      <div class="ico"><i data-lucide="bell"></i></div>
      <div><strong>No notifications yet</strong><div class="small muted" style="margin-top:4px">When someone likes, comments, follows or messages you, it'll show up here.</div></div>
    </li>`;
    refreshIcons();
    return;
  }
  items.forEach((n, i) => list.appendChild(buildNotifRow(n, i)));
  refreshIcons();
}

function buildNotifRow(n, i) {
  const li = document.createElement('li');
  if (!n.seenAt) li.classList.add('unread');

  // Avatar with kind badge
  const wrap = document.createElement('div');
  wrap.className = 'notif-avatar-wrap';
  const av = document.createElement('span');
  av.className = 'avatar md';
  renderAvatar(av, n.from);
  wrap.appendChild(av);
  const badge = document.createElement('span');
  badge.className = 'notif-kind-badge ' + n.kind;
  const ico = { like: 'heart', comment: 'message-circle', follow: 'user-plus', message: 'send', story_reply: 'reply' }[n.kind] || 'bell';
  badge.innerHTML = `<i data-lucide="${ico}"></i>`;
  wrap.appendChild(badge);
  li.appendChild(wrap);

  // Body
  const body = document.createElement('div');
  body.className = 'body';
  const fromName = (n.from && (n.from.username || n.from.displayName)) || 'Someone';
  let msg = '';
  if (n.kind === 'like')    msg = `<strong>${escapeHtml(fromName)}</strong> liked your post.`;
  if (n.kind === 'comment') msg = `<strong>${escapeHtml(fromName)}</strong> commented:`;
  if (n.kind === 'follow')  msg = `<strong>${escapeHtml(fromName)}</strong> started following you.`;
  if (n.kind === 'message') msg = `<strong>${escapeHtml(fromName)}</strong> sent you a message:`;
  if (n.kind === 'story_reply') msg = `<strong>${escapeHtml(fromName)}</strong> replied to your story:`;
  body.innerHTML = msg + `<div class="nm">${escapeHtml(timeAgo(n.createdAt))}</div>`;
  if (n.text) {
    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.textContent = '"' + n.text + '"';
    body.insertBefore(preview, body.querySelector('.nm'));
  }
  li.appendChild(body);

  // Thumbnail for post-related notifs
  if (n.postId) {
    const post = (State.posts || []).find(p => p.id === n.postId);
    if (post && post.imageUrl) {
      const t = document.createElement('div');
      t.className = 'thumb';
      t.style.backgroundImage = `url("${String(post.imageUrl).replace(/"/g, '%22')}")`;
      li.appendChild(t);
    }
  }

  // Click → navigate
  li.addEventListener('click', () => {
    closeNotifications();
    if (n.kind === 'follow' || n.kind === 'message' || n.kind === 'like' || n.kind === 'comment' || n.kind === 'story_reply') {
      if ((n.kind === 'message' || n.kind === 'story_reply') && n.fromUserId) {
        // Open DM with sender
        const member = (State.members || []).find(m => m.id === n.fromUserId) || n.from;
        if (member) { openDM(member); switchTab('chat'); return; }
      }
      // Open the user's profile
      if (n.fromUserId) openUserProfile(n.fromUserId);
    }
  });

  return li;
}

/* ====== Web Push subscription ====== */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

async function togglePushSubscription() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('Push notifications not supported on this browser', 'error');
    return;
  }
  // If already subscribed, unsubscribe
  if (localStorage.getItem('ps_pushEnabled') === '1') {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      localStorage.removeItem('ps_pushEnabled');
      toast('Push notifications turned off');
      updatePushStatus();
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    return;
  }
  // Ask permission
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    toast('Permission denied — enable notifications for this site in your browser settings', 'error');
    updatePushStatus();
    return;
  }
  // Fetch VAPID public key
  let keyRes;
  try { keyRes = await api('/push/vapid-public'); }
  catch (e) { toast('Server not ready for push', 'error'); return; }
  if (!keyRes || !keyRes.key) {
    toast('In-app notifications work. Phone push needs VAPID keys configured by admin.', 'info');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyRes.key),
    });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    localStorage.setItem('ps_pushEnabled', '1');
    toast('Push notifications enabled', 'success');
    updatePushStatus();
  } catch (e) {
    toast('Push subscribe failed: ' + (e.message || ''), 'error');
  }
}


async function pollRTCSignals() {
  if (!State.token) return;
  try {
    const data = await api('/rtc/signals?since=' + encodeURIComponent(State.rtcLastSignalAt || 0));
    const signals = data.signals || [];
    signals.forEach(sig => {
      if (sig.createdAt && sig.createdAt > State.rtcLastSignalAt) {
        State.rtcLastSignalAt = sig.createdAt;
        localStorage.setItem('ps_rtcLastSignalAt', String(State.rtcLastSignalAt));
      }
      handleRTCSignal(sig);
    });
  } catch (_) {}
}

/* ====== Settings sheet ====== */
function openSettings() {
  const sheet = $('#settingsSheet');
  sheet.classList.remove('hidden');
  const card = sheet.querySelector('.sheet-card');
  if (card) motionAnimate(card,
    { transform: ['translateY(100%)', 'translateY(0)'], opacity: [0.6, 1] },
    { duration: 0.36, easing: [0.2, 0.85, 0.15, 1] }
  );
  // Sync visual state of theme + accent inside the sheet
  const stored = localStorage.getItem('ps_theme') || 'auto';
  const cvs = $('#cardVisibilitySelect'); if (cvs && State.user) cvs.value = State.user.cardVisibility || 'everyone';
  $$('#settingsSheet [data-theme-set]').forEach(b => b.classList.toggle('active', b.dataset.themeSet === stored));
  const accent = localStorage.getItem('ps_accent') || '#00a2ff';
  $$('#settingsSheet [data-accent]').forEach(b => b.classList.toggle('active', b.dataset.accent === accent));
  updatePushStatus();
  updateRealtimeStatus();
  updateCloseFriendsStatus();
  if (State.token && (!Array.isArray(State.closeFriends) || State.closeFriends.length === 0)) loadCloseFriends().catch(() => {});
  refreshIcons();
}
function closeSettings() {
  $('#settingsSheet').classList.add('hidden');
}
function updatePushStatus() {
  const el = $('#pushStatus');
  if (!el) return;
  if (!('Notification' in window)) {
    el.textContent = 'Unsupported'; el.className = 'settings-chip';
  } else if (Notification.permission === 'granted' && localStorage.getItem('ps_pushEnabled') === '1') {
    el.textContent = 'On'; el.className = 'settings-chip on';
  } else {
    el.textContent = Notification.permission === 'denied' ? 'Blocked' : 'Off';
    el.className = 'settings-chip';
  }
}
function updateRealtimeStatus() {
  const el = $('#rtStatus');
  if (!el) return;
  if (typeof _sseConnected !== 'undefined' && _sseConnected) {
    el.textContent = _sseNeedsPollingBackstop ? 'Live+Polling' : 'Live';
    el.className = 'settings-chip live';
  } else {
    el.textContent = 'Polling'; el.className = 'settings-chip';
  }
}
function bindSettingsSheet() {
  const open = $('#topSettingsBtn');
  if (open) open.addEventListener('click', openSettings);
  // Profile-page gear (moved here when we removed the top-bar gear, IG-style)
  const pset = $('#profileSettingsBtn');
  if (pset) pset.addEventListener('click', openSettings);
  $$('[data-close-settings]').forEach(b => b.addEventListener('click', closeSettings));
  const push = $('#enablePushBtn');
  if (push) push.addEventListener('click', togglePushSubscription);
  const vipBtn = $('#vipActivateBtn');
  if (vipBtn) vipBtn.addEventListener('click', async () => {
    const inp = $('#vipKeyInput');
    const key = (inp && inp.value || '').trim();
    if (!key) { toast('Enter VIP key', 'error'); return; }
    vipBtn.disabled = true;
    const old = vipBtn.textContent;
    vipBtn.textContent = 'Checking…';
    try {
      const data = await api('/user/vip/redeem', { method: 'POST', body: { key } });
      if (data.user) {
        State.user = { ...State.user, ...data.user };
        try { localStorage.setItem('ps_user', JSON.stringify(State.user)); } catch (_) {}
        const selfMember = (State.members || []).find(u => u.id === State.user.id);
        if (selfMember) Object.assign(selfMember, data.user);
        hydrateMeChips();
        renderOwnProfile();
        renderMembers();
        renderPosts();
      }
      if (inp) inp.value = '';
      toast('Blue tick activated', 'success');
    } catch (e) { toast(e.message || 'Invalid VIP key', 'error'); }
    finally { vipBtn.disabled = false; vipBtn.textContent = old; }
  });
  const ep = $('#settingsEditProfile');
  if (ep) ep.addEventListener('click', () => {
    closeSettings();
    switchTab('profile');
    setTimeout(() => { const btn = $('#editProfileBtn'); if (btn) btn.click(); }, 200);
  });
  const cvs = $('#cardVisibilitySelect');
  if (cvs) {
    cvs.value = (State.user && State.user.cardVisibility) || 'everyone';
    cvs.addEventListener('change', async () => {
      cvs.disabled = true;
      try {
        const data = await api('/user/update', { method: 'POST', body: { cardVisibility: cvs.value } });
        State.user = data.user;
        localStorage.setItem('ps_user', JSON.stringify(State.user));
        toast('Profile card visibility updated', 'success');
      } catch (e) { toast(e.message || 'Visibility update failed', 'error'); }
      finally { cvs.disabled = false; }
    });
  }
  const savedPosts = $('#settingsSavedPosts');
  if (savedPosts) savedPosts.addEventListener('click', openSavedPostsSheet);
  const vt = $('#settingsViewTerms');
  if (vt) vt.addEventListener('click', () => {
    closeSettings();
    const m = $('#termsModal');
    m.classList.remove('hidden');
    refreshIcons();
  });
  const lo = $('#settingsLogout');
  if (lo) lo.addEventListener('click', () => {
    if (confirm('Sign out of PRIV SPACA?')) { closeSettings(); logout(false); }
  });
  // Bottom-sheet rebind for theme/accent buttons that live inside #settingsSheet (rebound by bindThemeToggle)
}

function updateCloseFriendsStatus() {
  const el = $('#closeFriendsCount');
  if (!el) return;
  el.textContent = String((State.closeFriends || []).length || 0);
}
async function loadCloseFriends() {
  if (!State.token) return [];
  try {
    const data = await api('/user/close-friends');
    State.closeFriends = Array.isArray(data.ids) ? data.ids : [];
    try { localStorage.setItem('ps_closeFriends', JSON.stringify(State.closeFriends)); } catch (_) {}
    updateCloseFriendsStatus();
    return State.closeFriends;
  } catch (_) {
    updateCloseFriendsStatus();
    return State.closeFriends || [];
  }
}
function openCloseFriendsSheet() {
  const sheet = $('#closeFriendsSheet');
  if (!sheet) return;
  renderCloseFriendsSheet();
  sheet.classList.remove('hidden');
  const card = sheet.querySelector('.sheet-card');
  if (card) motionAnimate(card,
    { transform: ['translateY(100%)', 'translateY(0)'], opacity: [0.6, 1] },
    { duration: 0.36, easing: [0.2, 0.85, 0.15, 1] }
  );
  refreshIcons();
}
function closeCloseFriendsSheet() {
  const sheet = $('#closeFriendsSheet');
  if (sheet) sheet.classList.add('hidden');
}
async function toggleCloseFriend(targetId) {
  try {
    const data = await api('/user/close-friends', { method: 'POST', body: { targetId, action: 'toggle' } });
    State.closeFriends = Array.isArray(data.ids) ? data.ids : [];
    try { localStorage.setItem('ps_closeFriends', JSON.stringify(State.closeFriends)); } catch (_) {}
    updateCloseFriendsStatus();
    renderCloseFriendsSheet();
    toast(data.added ? 'Added to Close Friends' : 'Removed from Close Friends', 'success');
  } catch (e) {
    toast(e.message || 'Update failed', 'error');
  }
}
function renderCloseFriendsSheet() {
  const list = $('#closeFriendsList');
  if (!list) return;
  const meId = State.user && State.user.id;
  const q = ($('#cfSearchInput')?.value || '').trim().toLowerCase();
  const selectedCount = (State.closeFriends || []).length;

  const summary = $('#cfSummaryRow');
  if (summary) {
    summary.innerHTML = selectedCount > 0
      ? `<span class="cf-summary-count"><i data-lucide="star"></i> ${selectedCount} close friend${selectedCount === 1 ? '' : 's'}</span>`
      : `<span class="cf-summary-empty">No close friends added yet — stories shared to this list stay private to them.</span>`;
    refreshIcons();
  }

  const users = (State.members || []).filter(u => u.id !== meId)
    .filter(u => {
      if (!q) return true;
      const hay = `${u.displayName || ''} ${u.username || ''}`.toLowerCase();
      return hay.includes(q);
    })
    .slice()
    .sort((a, b) => {
      const aSel = (State.closeFriends || []).includes(a.id) ? 1 : 0;
      const bSel = (State.closeFriends || []).includes(b.id) ? 1 : 0;
      if (bSel !== aSel) return bSel - aSel;
      if ((b.online ? 1 : 0) !== (a.online ? 1 : 0)) return (b.online ? 1 : 0) - (a.online ? 1 : 0);
      return String(a.username || '').localeCompare(String(b.username || ''));
    });
  list.innerHTML = '';
  if (!users.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.innerHTML = q
      ? `<i data-lucide="search-x"></i><span>No members match "${escapeHtml(q)}"</span>`
      : `<i data-lucide="users"></i><span>No other visible members yet.</span>`;
    list.appendChild(empty);
    refreshIcons();
    return;
  }
  users.forEach(u => {
    const li = document.createElement('li');
    const active = (State.closeFriends || []).includes(u.id);
    li.className = 'cf-row' + (active ? ' is-selected' : '');
    const av = document.createElement('span');
    av.className = 'avatar md';
    renderAvatar(av, u, { showStatus: true, online: !!u.online });
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<div class="nm">${displayNameWithOwnerBadge(u, u.displayName || u.username, 'inline')}</div><div class="sub">@${escapeHtml(u.username || '')}${u.online ? ' · online' : ''}</div>`;
    const btn = document.createElement('button');
    btn.className = 'cf-toggle-btn' + (active ? ' active' : '');
    btn.innerHTML = active ? '<i data-lucide="check"></i> Added' : '<i data-lucide="plus"></i> Add';
    btn.addEventListener('click', () => toggleCloseFriend(u.id));
    li.appendChild(av); li.appendChild(meta); li.appendChild(btn);
    list.appendChild(li);
  });
  refreshIcons();
}
function getOwnActiveStories() {
  if (!State.user) return [];
  return getStorySequence(State.user.id).slice().reverse();
}
function openStoryManageSheet() {
  const sheet = $('#storyManageSheet');
  if (!sheet) return;
  renderStoryManageSheet();
  sheet.classList.remove('hidden');
  const card = sheet.querySelector('.sheet-card');
  if (card) motionAnimate(card,
    { transform: ['translateY(100%)', 'translateY(0)'], opacity: [0.6, 1] },
    { duration: 0.36, easing: [0.2, 0.85, 0.15, 1] }
  );
  refreshIcons();
}
function closeStoryManageSheet() {
  const sheet = $('#storyManageSheet');
  if (sheet) sheet.classList.add('hidden');
}
function hoursUntilExpiry(story) {
  const exp = storyExpiresAt(story);
  if (!exp) return null;
  const ms = exp - Date.now();
  if (ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 3600000));
}

function renderStoryManageSheet() {
  const list = $('#storyManageList');
  const countLbl = $('#storyManageCountLbl');
  if (!list) return;
  const stories = getOwnActiveStories();
  if (countLbl) countLbl.textContent = stories.length ? `${stories.length} active` : '';
  list.innerHTML = '';
  if (!stories.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.innerHTML = '<i data-lucide="film"></i><span>No active stories right now — tap + to add one.</span>';
    list.appendChild(empty);
    refreshIcons();
    return;
  }
  stories.forEach((story) => {
    const li = document.createElement('li');
    li.className = 'story-manage-item';
    const thumb = document.createElement('div');
    thumb.className = 'story-manage-thumb';
    if (story.videoUrl) {
      const vid = document.createElement('video');
      vid.src = story.videoUrl;
      vid.muted = true; vid.playsInline = true; vid.preload = 'metadata';
      thumb.appendChild(vid);
      const vb = document.createElement('span');
      vb.className = 'thumb-video-badge';
      vb.textContent = '▶';
      thumb.appendChild(vb);
    } else if (story.imageUrl) {
      const img = document.createElement('img');
      img.src = story.imageUrl;
      img.alt = 'story';
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      thumb.textContent = (story.text || 'Story').slice(0, 24);
    }
    if (story.music && story.music.title) {
      const badge = document.createElement('span');
      badge.className = 'thumb-music-badge';
      badge.textContent = '🎵';
      thumb.appendChild(badge);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const chipCls = (story.audience === 'close_friends') ? 'story-audience-chip cf' : 'story-audience-chip';
    const chipLabel = (story.audience === 'close_friends') ? '★ Close Friends' : '🌐 Your story';
    const hrsLeft = hoursUntilExpiry(story);
    meta.innerHTML = `<div class="nm">${escapeHtml((story.text || 'Photo story').slice(0, 42) || 'Story')}</div>
      <div class="story-manage-stats">
        <span>${escapeHtml(timeAgo(story.createdAt))}</span>
        ${hrsLeft != null ? `<span>· expires in ${hrsLeft}h</span>` : ''}
      </div>
      <div class="${chipCls}">${chipLabel}</div>`;
    const actions = document.createElement('div');
    actions.className = 'story-manage-actions';
    const viewBtn = document.createElement('button');
    viewBtn.className = 'story-mini-btn icon-only';
    viewBtn.title = 'View';
    viewBtn.innerHTML = '<i data-lucide="eye"></i>';
    viewBtn.addEventListener('click', () => {
      closeStoryManageSheet();
      openStoryFor(State.user, Math.max(0, getStorySequence(State.user.id).findIndex(x => x.id === story.id)));
    });
    const saveBtn = document.createElement('button');
    saveBtn.className = 'story-mini-btn icon-only';
    saveBtn.title = 'Save media';
    saveBtn.innerHTML = '<i data-lucide="download"></i>';
    saveBtn.addEventListener('click', () => saveStoryMedia(story));
    if (!story.imageUrl) saveBtn.style.display = 'none';
    const delBtn = document.createElement('button');
    delBtn.className = 'story-mini-btn icon-only danger';
    delBtn.title = 'Delete';
    delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    delBtn.addEventListener('click', () => deleteStoryItem(story.id));
    actions.appendChild(viewBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(delBtn);
    li.appendChild(thumb); li.appendChild(meta); li.appendChild(actions);
    list.appendChild(li);
  });
  refreshIcons();
}

// "Save media" — downloads the story's photo locally. A lightweight nicety
// requested as an optional extra; text-only stories have nothing to save.
function saveStoryMedia(story) {
  if (!story || !story.imageUrl) { toast('Nothing to save for a text-only story', 'error'); return; }
  try {
    const a = document.createElement('a');
    a.href = story.imageUrl;
    a.download = `priv-spaca-story-${story.id || Date.now()}.jpg`;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Saving photo…', 'success');
  } catch (_) {
    toast('Could not save this photo', 'error');
  }
}
async function deleteStoryItem(postId) {
  if (!postId) return;
  if (!confirm('Delete this story?')) return;
  try {
    await api('/posts/delete', { method: 'POST', body: { postId } });
    State.posts = (State.posts || []).filter(p => p.id !== postId);
    lastPostsSignature = null; // force next loadPosts() to re-render even if list becomes empty
    _lastStoriesSig = '';
    const idx = storyPlayback.items.findIndex(x => x.id === postId);
    if (idx !== -1) {
      storyPlayback.items.splice(idx, 1);
      if (!storyPlayback.items.length) closeStory();
      else {
        if (storyPlayback.index >= storyPlayback.items.length) storyPlayback.index = storyPlayback.items.length - 1;
        renderStoryItem();
      }
    }
    renderStoryManageSheet();
    renderStoriesRail();
    loadPosts();
    toast('Story deleted', 'success');
  } catch (e) {
    toast(e.message || 'Delete failed', 'error');
  }
}
function bindCloseFriendsAndStoryManage() {
  $$('[data-close-close-friends]').forEach(b => b.addEventListener('click', closeCloseFriendsSheet));
  $$('[data-close-story-manage]').forEach(b => b.addEventListener('click', closeStoryManageSheet));
  const cf = $('#settingsCloseFriends');
  if (cf) cf.addEventListener('click', () => { closeSettings(); openCloseFriendsSheet(); });
  const ms = $('#settingsManageStories');
  if (ms) ms.addEventListener('click', () => { closeSettings(); openStoryManageSheet(); });
  const smb = $('#storyManageBtn');
  if (smb) smb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openStoryManageSheet(); });
  const smc = $('#storyManageCreateBtn');
  if (smc) smc.addEventListener('click', () => { closeStoryManageSheet(); openStoryCreator(); });
  const cfSearch = $('#cfSearchInput');
  if (cfSearch) cfSearch.addEventListener('input', () => renderCloseFriendsSheet());
}

function bindNotifSheet() {
  $$('[data-close-notif]').forEach(b => b.addEventListener('click', closeNotifications));
  const clr = $('#notifClearBtn');
  if (clr) clr.addEventListener('click', async () => {
    if (!confirm('Clear all notifications?')) return;
    try {
      await api('/notifications/clear', { method: 'POST' });
      _notifData = { notifications: [], unread: 0 };
      renderNotifications();
      pollNotifications();
    } catch (e) { toast(e.message || 'Failed', 'error'); }
  });
}

// ============================================================
// ===== Other-user profile sheet
// ============================================================
let _activeOtherProfile = null;

async function openUserProfile(userId) {
  if (!userId || userId === (State.user && State.user.id)) {
    switchTab('profile'); return;
  }
  const sheet = $('#userProfileSheet');
  sheet.classList.remove('hidden');
  springIn(sheet);
  // Show skeleton
  $('#upHeaderUsername').textContent = 'Loading…';
  $('#upDisplayName').textContent = '';
  $('#upBio').textContent = '';
  $('#upStatPosts').textContent = '·';
  $('#upStatFollowers').textContent = '·';
  $('#upStatFollowing').textContent = '·';
  $('#upPostsGrid').innerHTML = '';
  renderAvatar($('#upAvatar'), null);
  try {
    const data = await api('/user/' + encodeURIComponent(userId) + '/profile');
    _activeOtherProfile = data;
    renderOtherProfile(data);
  } catch (e) {
    $('#upDisplayName').textContent = e.message || 'Could not load profile';
    _activeOtherProfile = null;
  }
  refreshIcons();
}

function closeUserProfile() {
  $('#userProfileSheet').classList.add('hidden');
  _activeOtherProfile = null;
}

function renderOtherProfile(data) {
  const u = data.user;
  $('#upHeaderUsername').innerHTML = displayNameWithOwnerBadge(u, '@' + u.username, 'inline');
  $('#upDisplayName').textContent = u.displayName || '';
  $('#upBio').textContent = u.bio || '';
  $('#upStatPosts').textContent = String(u.postsCount || 0);
  $('#upStatFollowers').textContent = String(u.followers || 0);
  $('#upStatFollowing').textContent = String(u.following || 0);
  renderAvatar($('#upAvatar'), u);
  // Follow button
  const fb = $('#upFollowBtn');
  if (data.relationship.iFollow) {
    fb.textContent = 'Following';
    fb.classList.remove('primary'); fb.classList.add('following');
  } else {
    fb.textContent = data.relationship.followsMe ? 'Follow back' : 'Follow';
    fb.classList.add('primary'); fb.classList.remove('following');
  }
  fb.onclick = async () => {
    fb.disabled = true;
    try {
      const action = data.relationship.iFollow ? 'unfollow' : 'follow';
      const result = await api('/user/' + action, { method: 'POST', body: { targetId: u.id }});
      State.user.following = Array.isArray(State.user.following) ? State.user.following : [];
      if (action === 'follow') {
        if (!State.user.following.includes(u.id)) State.user.following.push(u.id);
      } else {
        State.user.following = State.user.following.filter(id => id !== u.id);
      }
      const member = (State.members || []).find(m => m.id === u.id);
      if (member) member.iFollow = action === 'follow';
      if (Array.isArray(result.followingIds)) State.user.following = result.followingIds;
      updateOwnProfileStatCounts(State.user);
      // Reload
      const fresh = await api('/user/' + encodeURIComponent(u.id) + '/profile');
      _activeOtherProfile = fresh;
      renderOtherProfile(fresh);
      pollNotifications();
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { fb.disabled = false; }
  };
  // Message
  const mb = $('#upMessageBtn');
  mb.onclick = () => {
    closeUserProfile();
    const member = (State.members || []).find(m => m.id === u.id) || u;
    openDM(member); switchTab('chat');
  };
  const cb = $('#upCardBtn');
  if (cb) {
    const canCard = !u.card || u.card.canView !== false;
    cb.disabled = !canCard;
    cb.title = canCard ? 'View profile card' : 'Profile card is private';
    cb.onclick = () => openProfileCard(data, u);
  }
  // Posts grid
  const grid = $('#upPostsGrid');
  grid.innerHTML = '';
  if (!data.posts || data.posts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ig-grid-empty';
    empty.innerHTML = '<i data-lucide="camera" style="width:36px;height:36px;color:var(--muted-2);display:block;margin:0 auto 8px"></i>No posts yet';
    grid.appendChild(empty);
  } else {
    data.posts.forEach(p => grid.appendChild(buildGridCell(p)));
  }
  refreshIcons();
}

function buildGridCell(p) {
  p = normalizeProfilePost(p) || p;
  const cell = document.createElement('div');
  cell.className = 'ig-grid-cell';
  if (p && p.id) cell.dataset.postId = p.id;
  if (p.videoUrl) {
    const vid = document.createElement('video');
    vid.src = p.videoUrl;
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = 'metadata';
    cell.appendChild(vid);
    const play = document.createElement('span');
    play.className = 'video-badge';
    play.textContent = '▶';
    cell.appendChild(play);
  } else if (p.imageUrl) {
    const ph = document.createElement('div');
    ph.className = 'profile-grid-placeholder';
    ph.textContent = (p.text || 'Post').slice(0, 80);
    cell.appendChild(ph);
    const img = document.createElement('img');
    img.alt = p.text || 'post';
    img.loading = 'eager';
    img.decoding = 'async';
    img.src = p.imageUrl;
    img.addEventListener('load', () => { ph.remove(); img.classList.add('loaded'); });
    img.addEventListener('error', () => {
      img.remove();
      ph.className = 'text-only';
      ph.textContent = p.text || 'Image unavailable';
    });
    cell.appendChild(img);
  } else {
    const div = document.createElement('div');
    div.className = 'text-only';
    div.textContent = (p.text || 'Post').slice(0, 200);
    cell.appendChild(div);
  }
  if (p.likeCount > 0 || p.commentCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.innerHTML = `<i data-lucide="heart"></i>${p.likeCount || 0}`;
    cell.appendChild(badge);
  }
  cell.addEventListener('click', () => openPostDetail(p));
  return cell;
}

function bindUserProfileSheet() {
  const back = $('#upBackBtn');
  if (back) back.addEventListener('click', closeUserProfile);
  const more = $('#upMoreBtn');
  if (more) more.addEventListener('click', () => {
    if (!_activeOtherProfile) return;
    const u = _activeOtherProfile.user;
    const rel = _activeOtherProfile.relationship;
    const wrap = document.createElement('div');
    wrap.className = 'more-menu';
    wrap.innerHTML = '<div class="bd"></div>';
    wrap.querySelector('.bd').addEventListener('click', () => wrap.remove());
    const card = document.createElement('div');
    card.className = 'card';
    const items = [];
    items.push({ label: rel.iBlocked ? 'Unblock' : 'Block', danger: true, action: async () => {
      wrap.remove();
      if (!confirm(`${rel.iBlocked ? 'Unblock' : 'Block'} @${u.username}?`)) return;
      try {
        await api('/user/' + (rel.iBlocked ? 'unblock' : 'block'), { method:'POST', body:{ targetId: u.id }});
        toast(rel.iBlocked ? 'Unblocked' : 'Blocked', 'success');
        if (!rel.iBlocked) {
          closeUserProfile();
          loadMembers();
          loadPosts();
        } else {
          openUserProfile(u.id);
        }
      } catch (e) { toast(e.message || 'Failed', 'error'); }
    }});
    items.push({ label: 'Copy username', action: async () => {
      wrap.remove();
      try { await navigator.clipboard.writeText('@' + u.username); toast('Copied'); }
      catch (_) { toast('Copy failed', 'error'); }
    }});
    items.push({ label: 'Report', danger: true, action: () => { wrap.remove(); toast('Reported. Thanks.'); }});
    items.push({ label: 'Cancel', cancel: true, action: () => wrap.remove() });
    items.forEach(it => {
      const b = document.createElement('button');
      b.className = 'item' + (it.danger ? ' danger' : '') + (it.cancel ? ' cancel' : '');
      b.textContent = it.label;
      b.addEventListener('click', it.action);
      card.appendChild(b);
    });
    wrap.appendChild(card);
    document.body.appendChild(wrap);
  });
}

// ============================================================

// ===== Reflective profile card (vanilla adaptation of React Bits ReflectiveCard)
// ============================================================
function formatProfileDob(dob) {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(String(dob))) return 'Not shared';
  try {
    return new Date(dob + 'T00:00:00').toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return dob; }
}
function profileCardFromUser(user, profileData = null) {
  const u = (profileData && profileData.user) || user || State.user || {};
  const c = (u && u.card) || {};
  const postsCount = Number(c.postsCount ?? u.postsCount ?? $('#statPosts')?.textContent ?? 0) || 0;
  const followers = Number(c.followers ?? u.followers ?? $('#statFollowers')?.textContent ?? 0) || 0;
  const following = Number(c.following ?? u.following ?? $('#statFollowing')?.textContent ?? 0) || 0;
  return {
    user: u,
    canView: c.canView !== false,
    visibility: c.visibility || u.cardVisibility || 'everyone',
    dateOfBirth: c.dateOfBirth || u.dateOfBirth || '',
    postsCount, followers, following,
  };
}
function openProfileCard(profileData = null, fallbackUser = null) {
  const data = profileCardFromUser(fallbackUser || (profileData && profileData.user) || State.user, profileData);
  const u = data.user || {};
  const sheet = $('#profileCardSheet');
  const mount = $('#profileCardMount');
  if (!sheet || !mount) return;
  if (!data.canView) {
    toast('This profile card is private', 'info');
    return;
  }
  const display = u.displayName || u.username || 'Member';
  const username = u.username ? '@' + u.username : '';
  const dob = formatProfileDob(data.dateOfBirth);
  const photo = u.photoUrl && isSafeUrlForCss(u.photoUrl) ? `style="background-image:url('${escapeHtml(u.photoUrl).replace(/'/g, '%27')}')"` : '';
  mount.innerHTML = `
    <div class="reflective-card-container ps-reflective-card" style="--blur-strength:10px;--metalness:.82;--roughness:.38;--overlay-color:rgba(0,0,0,.18);--text-color:#fff;--saturation:.55">
      <svg class="reflective-svg-filters" aria-hidden="true" focusable="false">
        <defs>
          <filter id="metallic-displacement" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="turbulence" baseFrequency="0.02" numOctaves="2" result="noise" />
            <feColorMatrix in="noise" type="luminanceToAlpha" result="noiseAlpha" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="18" xChannelSelector="R" yChannelSelector="G" result="rippled" />
            <feSpecularLighting in="noiseAlpha" surfaceScale="18" specularConstant="1.6" specularExponent="20" lightingColor="#ffffff" result="light"><fePointLight x="0" y="0" z="300" /></feSpecularLighting>
            <feComposite in="light" in2="rippled" operator="in" result="light-effect" />
            <feBlend in="light-effect" in2="rippled" mode="screen" result="metallic-result" />
          </filter>
        </defs>
      </svg>
      <div class="reflective-video reflective-card-photo" ${photo}></div>
      <div class="reflective-noise"></div>
      <div class="reflective-sheen"></div>
      <div class="reflective-border"></div>
      <div class="reflective-content">
        <div class="card-header">
          <div class="security-badge"><i data-lucide="lock"></i><span>PRIV CARD</span></div>
          <i data-lucide="activity" class="status-icon"></i>
        </div>
        <div class="card-body">
          <span class="avatar xl reflective-user-avatar"></span>
          <div class="user-info">
            <h2 class="user-name">${escapeHtml(display)}</h2>
            <p class="user-role">${escapeHtml(username || 'PRIVATE MEMBER')}</p>
          </div>
          <div class="reflective-stats">
            <div><strong>${data.postsCount}</strong><span>posts</span></div>
            <div><strong>${data.followers}</strong><span>followers</span></div>
            <div><strong>${data.following}</strong><span>following</span></div>
          </div>
        </div>
        <div class="card-footer">
          <div class="id-section"><span class="label">DATE OF BIRTH</span><span class="value">${escapeHtml(dob)}</span></div>
          <div class="fingerprint-section"><i data-lucide="fingerprint" class="fingerprint-icon"></i></div>
        </div>
      </div>
    </div>`;
  renderAvatar(mount.querySelector('.reflective-user-avatar'), u);
  sheet.classList.remove('hidden');
  // Keep reveal intentionally light: CSS handles a simple fade-in.
  // Avoid spring/blur transforms here because they jank on mobile GPUs.
  refreshIcons();
}
function closeProfileCard() {
  const sheet = $('#profileCardSheet');
  if (sheet) sheet.classList.add('hidden');
}
function isSafeUrlForCss(url) {
  return typeof url === 'string' && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url));
}

function buildProfileCardTile(profileData = null, fallbackUser = null) {
  const data = profileCardFromUser(fallbackUser || (profileData && profileData.user) || State.user, profileData);
  const u = data.user || {};
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'profile-card-tile profile-card-preview-tile fast-card-preview';
  if (!data.canView) tile.classList.add('is-private');
  tile.setAttribute('aria-label', data.canView ? 'Open profile card' : 'Profile card is private');
  const display = u.displayName || u.username || 'Member';
  const username = u.username ? '@' + u.username : '';
  const bg = u.photoUrl && isSafeUrlForCss(u.photoUrl) ? `style="background-image:url('${escapeHtml(u.photoUrl).replace(/'/g, '%27')}')"` : '';
  tile.innerHTML = `
    <div class="fast-reflective-preview-card">
      <div class="fast-card-bg" ${bg}></div>
      <div class="fast-card-sheen"></div>
      <div class="fast-card-content" aria-hidden="true">
        <div class="fast-card-head">
          <span class="avatar lg fast-card-avatar"></span>
          <div><strong>${escapeHtml(display)}</strong><span>${escapeHtml(username || 'PRIVATE MEMBER')}</span></div>
          <i data-lucide="contact"></i>
        </div>
        <div class="fast-card-stats">
          <span><b>${data.postsCount}</b> posts</span>
          <span><b>${data.followers}</b> followers</span>
          <span><b>${data.following}</b> following</span>
        </div>
        <div class="fast-card-dob">DOB · ${escapeHtml(data.canView ? formatProfileDob(data.dateOfBirth) : 'Hidden')}</div>
      </div>
      <div class="profile-card-preview-lock fast-card-lock">
        <i data-lucide="${data.canView ? 'sparkles' : 'lock'}"></i>
        <strong>${data.canView ? 'Tap to reveal' : 'Private card'}</strong>
        <span>${data.canView ? 'Reflective profile card' : 'Only allowed viewers can open it'}</span>
      </div>
    </div>
  `;
  renderAvatar(tile.querySelector('.fast-card-avatar'), u);
  tile.addEventListener('click', () => openProfileCard(profileData, u));
  return tile;
}
function renderProfileCardGrid(profileData = null, fallbackUser = null) {
  const grid = $('#profilePostsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  grid.appendChild(buildProfileCardTile(profileData, fallbackUser || State.user));
  refreshIcons();
}

// ===== Own profile view (IG-style) — render + edit toggle
// ============================================================
let _profileTab = 'posts';


function isOwnProfilePost(p, user = State.user) {
  if (!p || !user || isStoryRecord(p)) return false;
  const uid = user.id || '';
  const uname = String(user.username || '').toLowerCase();
  const author = p.author || p.authorSnapshot || {};
  return p.userId === uid
    || author.id === uid
    || (uname && String(author.username || '').toLowerCase() === uname)
    || (uname && String(p.username || '').toLowerCase() === uname);
}

function normalizeProfilePost(p) {
  if (!p) return null;
  const images = Array.isArray(p.images) ? p.images : [];
  return {
    ...p,
    imageUrl: p.imageUrl || images[0] || null,
    videoUrl: p.videoUrl || null,
    text: p.text || '',
    likeCount: Number(p.likeCount || (Array.isArray(p.likes) ? p.likes.length : 0)) || 0,
    commentCount: Number(p.commentCount || (Array.isArray(p.comments) ? p.comments.length : 0)) || 0,
  };
}

function mergeProfilePosts(primary, fallback, user = State.user) {
  const out = [];
  const seen = new Set();
  const add = (p, requireOwn = false) => {
    const n = normalizeProfilePost(p);
    if (!n || !n.id || seen.has(n.id)) return;
    if (requireOwn && !isOwnProfilePost(n, user)) return;
    seen.add(n.id);
    out.push(n);
  };
  (primary || []).forEach(p => add(p, false));
  (fallback || []).forEach(p => add(p, true));
  return out.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
}


function renderOwnProfileFromCache() {
  if (!State.user || State.currentTab !== 'profile') return;
  if (_profileTab === 'card') return;
  const grid = $('#profilePostsGrid');
  if (!grid) return;
  const cached = mergeProfilePosts([], State.posts || [], State.user);
  if (!cached.length) return;
  const existingIds = new Set(Array.from(grid.querySelectorAll('.ig-grid-cell[data-post-id]')).map(el => el.dataset.postId));
  if (cached.every(p => existingIds.has(p.id))) return;
  grid.innerHTML = '';
  cached.forEach(p => grid.appendChild(buildGridCell(p)));
  updateOwnProfileStatCounts({ ...State.user, postsCount: cached.length });
  refreshIcons();
}

async function renderOwnProfile() {
  if (!State.user) return;
  const cachedUsername = State.user.username || State.user.displayName || 'me';
  const titleU = $('#profileTitleUsername');
  // Never leave the design placeholder visible while fresh profile data loads.
  if (titleU) titleU.innerHTML = `${escapeHtml(cachedUsername)}${ownerBadgeHtml(State.user, 'title')}`;
  if ($('#profileDisplayName')) $('#profileDisplayName').textContent = State.user.displayName || '';
  if ($('#profileUsername')) $('#profileUsername').innerHTML = displayNameWithOwnerBadge(State.user, '@' + (State.user.username || cachedUsername), 'inline');
  // Render from the fresh profile endpoint first; relationship/feed refreshes run after,
  // so the grid does not feel slow or blank while /users and /posts load.
  if (_profileTab === 'card') {
    // Card preview should feel instant and must not kick off feed/member work.
    renderProfileCardGrid(null, State.user);
  } else {
    loadMembers().then(() => updateOwnProfileStatCounts(State.user)).catch(() => {});
    loadPosts().then(() => { if (State.currentTab === 'profile') renderOwnProfileFromCache(); }).catch(() => {});
  }
  // Fetch fresh data (own profile uses same endpoint)
  try {
    const data = await api('/user/' + encodeURIComponent(State.user.id) + '/profile');
    const u = data.user || State.user;
    if (u && u.id === State.user.id) {
      const localFollowers = Array.isArray(State.user.followers) ? State.user.followers : [];
      const localFollowing = Array.isArray(State.user.following) ? State.user.following : [];
      const serverFollowers = Array.isArray(u.followerIds) ? u.followerIds : localFollowers;
      const serverFollowing = Array.isArray(u.followingIds) ? u.followingIds : localFollowing;
      State.user = { ...State.user, ...u, followers: serverFollowers, following: serverFollowing };
      try { localStorage.setItem('ps_user', JSON.stringify(State.user)); } catch (_) {}
    }
    const realUsername = u.username || State.user.username || cachedUsername;
    $('#profileDisplayName').textContent = u.displayName || State.user.displayName || '';
    $('#profileUsername').textContent = '@' + realUsername + (u.bio ? '' : '');
    if (titleU) titleU.innerHTML = `${escapeHtml(realUsername)}${ownerBadgeHtml(u, 'title')}`;
    const mb = $('#profileMoodBubble');
    if (mb) {
      const note = activeNote(u);
      mb.innerHTML = note ? escapeHtml(note.text).slice(0, 30) : 'Current<br/>mood...';
    }
    $('#profileBio').textContent = u.bio || '';
    renderAvatar($('#profileAvatarPreview'), u);
    renderDiscoverPeople();
    // Grid
    const grid = $('#profilePostsGrid');
    grid.innerHTML = '';
    if (_profileTab === 'card') {
      updateOwnProfileStatCounts({ ...u, postsCount: u.postsCount || ((data.posts || []).length) });
      renderProfileCardGrid(data, u);
      return;
    }
    let postsToShow = mergeProfilePosts(data.posts || [], State.posts || [], State.user);
    if (_profileTab === 'saved') {
      // Use the bookmark localStorage to filter ALL posts
      const saved = getSaved();
      postsToShow = (State.posts || []).filter(p => !isStoryRecord(p) && saved[p.id]).map(normalizeProfilePost).filter(Boolean);
    }
    updateOwnProfileStatCounts({ ...u, postsCount: Array.isArray(postsToShow) ? postsToShow.length : (u.postsCount || 0) });
    if (!postsToShow || postsToShow.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ig-grid-empty';
      empty.innerHTML = _profileTab === 'saved'
        ? '<i data-lucide="bookmark" style="width:36px;height:36px;color:var(--muted-2);display:block;margin:0 auto 8px"></i>Posts you save appear here'
        : '<i data-lucide="camera" style="width:36px;height:36px;color:var(--muted-2);display:block;margin:0 auto 8px"></i>Share your first post';
      grid.appendChild(empty);
    } else {
      postsToShow.forEach(p => grid.appendChild(buildGridCell(p)));
    }
    refreshIcons();
  } catch (e) {
    console.warn('renderOwnProfile failed', e.message);
  }
}


function profileRelationLists() {
  const meId = State.user && State.user.id;
  const members = Array.isArray(State.members) ? State.members.filter(u => u && u.id !== meId) : [];
  const followerIds = new Set(Array.isArray(State.user && State.user.followers) ? State.user.followers : []);
  const followingIds = new Set(Array.isArray(State.user && State.user.following) ? State.user.following : []);
  members.forEach(u => {
    if (u.followsMe) followerIds.add(u.id);
    if (u.iFollow) followingIds.add(u.id);
  });
  return {
    followers: members.filter(u => followerIds.has(u.id) || u.followsMe),
    following: members.filter(u => followingIds.has(u.id) || u.iFollow),
  };
}

function updateOwnProfileStatCounts(profileUser) {
  const lists = profileRelationLists();
  const postsCount = Number(profileUser && profileUser.postsCount) || 0;
  const followerIdsCount = Array.isArray(profileUser && profileUser.followerIds) ? profileUser.followerIds.length : 0;
  const followingIdsCount = Array.isArray(profileUser && profileUser.followingIds) ? profileUser.followingIds.length : 0;
  const ownFollowerIdsCount = Array.isArray(State.user && State.user.followers) ? State.user.followers.length : 0;
  const ownFollowingIdsCount = Array.isArray(State.user && State.user.following) ? State.user.following.length : 0;
  const followerCount = Math.max(Number(profileUser && profileUser.followers) || 0, followerIdsCount, ownFollowerIdsCount, lists.followers.length);
  const followingCount = Math.max(Number(profileUser && profileUser.following) || 0, followingIdsCount, ownFollowingIdsCount, lists.following.length);
  const sp = $('#statPosts'); if (sp) sp.textContent = String(postsCount);
  const sf = $('#statFollowers'); if (sf) sf.textContent = String(followerCount);
  const sg = $('#statFollowing'); if (sg) sg.textContent = String(followingCount);
}

async function openProfileRelationSheet(kind) {
  if (!State.user) return;
  if (!Array.isArray(State.members) || State.members.length === 0) {
    await loadMembers();
  }
  const lists = profileRelationLists();
  const rows = kind === 'following' ? lists.following : lists.followers;
  const title = kind === 'following' ? 'Following' : 'Followers';
  const statEl = kind === 'following' ? $('#statFollowing') : $('#statFollowers');
  if (statEl) statEl.textContent = String(Math.max(Number(statEl.textContent) || 0, rows.length));
  const existing = $('#profileRelationSheet');
  if (existing) existing.remove();
  const sheet = document.createElement('div');
  sheet.id = 'profileRelationSheet';
  sheet.className = 'sheet profile-relation-sheet';
  sheet.innerHTML = `
    <div class="sheet-card profile-relation-card">
      <div class="sheet-handle"></div>
      <div class="profile-relation-head">
        <strong>${title}</strong>
        <button type="button" class="ghost-btn" id="profileRelationClose" aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <div class="profile-relation-list" id="profileRelationList"></div>
    </div>`;
  document.body.appendChild(sheet);
  const list = $('#profileRelationList');
  if (!rows.length) {
    list.innerHTML = `<div class="profile-relation-empty">No ${title.toLowerCase()} yet</div>`;
  } else {
    rows.sort((a,b) => String(a.username || '').localeCompare(String(b.username || ''))).forEach(u => {
      const row = document.createElement('div');
      row.className = 'profile-relation-row';
      row.innerHTML = `
        <span class="avatar md"></span>
        <button type="button" class="profile-relation-meta">
          <strong>${displayNameWithOwnerBadge(u, u.displayName || u.username || 'Member', 'inline')}</strong>
          <span>@${escapeHtml(u.username || '')}</span>
        </button>
        ${kind === 'following' ? '<button type="button" class="profile-relation-remove">Remove</button>' : ''}
      `;
      renderAvatar(row.querySelector('.avatar'), u, { showStatus: true, online: !!u.online });
      row.querySelector('.profile-relation-meta').addEventListener('click', () => { sheet.remove(); openUserProfile(u.id); });
      const rm = row.querySelector('.profile-relation-remove');
      if (rm) rm.addEventListener('click', async () => {
        rm.disabled = true; rm.textContent = 'Removing…';
        try {
          const result = await api('/user/unfollow', { method: 'POST', body: { targetId: u.id } });
          if (Array.isArray(result.followingIds)) State.user.following = result.followingIds;
          else if (State.user.following) State.user.following = State.user.following.filter(id => id !== u.id);
          const member = (State.members || []).find(m => m.id === u.id); if (member) member.iFollow = false;
          row.remove();
          updateOwnProfileStatCounts(State.user);
          const remaining = list.querySelectorAll('.profile-relation-row').length;
          const sg = $('#statFollowing'); if (sg) sg.textContent = String(remaining);
          if (!remaining) list.innerHTML = '<div class="profile-relation-empty">No following yet</div>';
          renderDiscoverPeople();
        } catch (e) { rm.disabled = false; rm.textContent = 'Remove'; toast(e.message || 'Remove failed', 'error'); }
      });
      list.appendChild(row);
    });
  }
  $('#profileRelationClose').addEventListener('click', () => sheet.remove());
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.remove(); });
  refreshIcons();
}

function renderDiscoverPeople() {
  const box = $('#profileDiscoverList');
  if (!box || !State.user) return;
  box.innerHTML = '';
  const meId = State.user.id;
  const myFollowing = new Set(State.user.following || []);
  const suggested = (State.members || []).filter(m => m.id !== meId && !myFollowing.has(m.id)).slice(0, 10);
  if (suggested.length === 0) {
    const sec = $('#profileDiscoverSection'); if (sec) sec.style.display = 'none';
    return;
  }
  const sec = $('#profileDiscoverSection'); if (sec) sec.style.display = '';
  suggested.forEach(m => {
    const card = document.createElement('div');
    card.className = 'discover-card';
    card.innerHTML = `
      <button type="button" class="discover-close" title="Dismiss"><i data-lucide="x"></i></button>
      <span class="avatar lg"></span>
      <div class="discover-name">${displayNameWithOwnerBadge(m, m.displayName || m.username, 'inline')}</div>
      <div class="discover-sub">Suggested for you</div>
      <button type="button" class="discover-follow-btn">Follow</button>
    `;
    renderAvatar(card.querySelector('.avatar'), m);
    card.querySelector('.discover-close').addEventListener('click', () => {
      card.remove(); if (box.children.length === 0) sec.style.display = 'none';
    });
    const fb = card.querySelector('.discover-follow-btn');
    fb.addEventListener('click', async () => {
      fb.disabled = true; fb.textContent = 'Following...';
      try {
        const result = await api('/user/follow', { method: 'POST', body: { targetId: m.id } });
        if (Array.isArray(result.followingIds)) State.user.following = result.followingIds;
        else {
          if (!State.user.following) State.user.following = [];
          if (!State.user.following.includes(m.id)) State.user.following.push(m.id);
        }
        const member = (State.members || []).find(x => x.id === m.id); if (member) member.iFollow = true;
        updateOwnProfileStatCounts(State.user);
        card.remove(); if (box.children.length === 0) sec.style.display = 'none';
        toast('Followed ' + (m.displayName || m.username));
      } catch (_) { fb.disabled = false; fb.textContent = 'Follow'; }
    });
    box.appendChild(card);
  });
  refreshIcons();
}

function bindProfileView() {
  const pap = $('#profileAddPostBtn');
  if (pap) pap.addEventListener('click', openPostComposer);
  const pas = $('#profileAddStoryBtn');
  if (pas) pas.addEventListener('click', openPostComposer);
  const pan = $('#profileAddNoteBtn');
  if (pan) pan.addEventListener('click', openNoteModal);
  const pmb = $('#profileMoodBubble');
  if (pmb) pmb.addEventListener('click', openNoteModal);
  const dtb = $('#discoverToggleBtn');
  if (dtb) dtb.addEventListener('click', () => {
    const sec = $('#profileDiscoverSection');
    if (sec) sec.style.display = sec.style.display === 'none' ? '' : 'none';
  });
  const dsa = $('#discoverSeeAllBtn');
  if (dsa) dsa.addEventListener('click', () => switchTab('search'));
  // Edit toggle
  const edit = $('#editProfileBtn');
  if (edit) edit.addEventListener('click', () => {
    $('#profileViewMode').classList.add('hidden');
    $('#profileEditMode').classList.remove('hidden');
    renderAvatar($('#profileEditAvatar'), State.user);
    // Populate form
    const f = $('#profileForm');
    if (f) {
      const dn = f.querySelector('[name="displayName"]');
      const un = f.querySelector('[name="username"]');
      const bio = f.querySelector('[name="bio"]');
      const dob = f.querySelector('[name="dateOfBirth"]');
      if (dn) dn.value = State.user.displayName || '';
      if (un) un.value = State.user.username || '';
      if (bio) bio.value = State.user.bio || '';
      if (dob) dob.value = State.user.dateOfBirth || '';
    }
    springIn($('#profileEditMode'));
  });
  const cancel = $('#cancelEditBtn');
  if (cancel) cancel.addEventListener('click', () => {
    $('#profileEditMode').classList.add('hidden');
    $('#profileViewMode').classList.remove('hidden');
    springIn($('#profileViewMode'));
  });
  // Share
  const sh = $('#shareProfileBtn');
  if (sh) sh.addEventListener('click', async () => {
    const url = location.origin + '/#user=' + encodeURIComponent(State.user.username);
    try {
      if (navigator.share) await navigator.share({ title: '@' + State.user.username, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied'); }
    } catch (_) {}
  });
  // Grid / card tabs
  $$('.ig-tab').forEach(t => t.addEventListener('click', () => {
    $$('.ig-tab').forEach(x => x.classList.toggle('active', x === t));
    _profileTab = t.dataset.grid;
    renderOwnProfile();
  }));
  $$('[data-close-profile-card]').forEach(b => b.addEventListener('click', closeProfileCard));
  // Stat buttons: open followers/following lists.
  $$('.stat-btn[data-stat]').forEach(btn => btn.addEventListener('click', () => {
    const stat = btn.dataset.stat;
    if (stat === 'followers' || stat === 'following') openProfileRelationSheet(stat);
    else if (stat === 'posts') $('#profilePostsGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

// ===== Search =====
function bindSearch() {
  const inp = $('#searchInput');
  const clear = $('#searchClearBtn');
  if (!inp) return;
  const unlock = () => {
    if (!inp.readOnly) return;
    inp.readOnly = false;
    inp.removeAttribute('aria-readonly');
    clearTimeout(_searchFocusReleaseTimer);
  };
  inp.addEventListener('pointerdown', unlock, { passive: true });
  inp.addEventListener('touchstart', unlock, { passive: true });
  inp.addEventListener('focus', () => {
    if (inp.readOnly) {
      inp.blur();
      return;
    }
  });
  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    clear.classList.toggle('hidden', !q);
    renderSearch(q);
  });
  clear.addEventListener('click', () => {
    inp.value = ''; clear.classList.add('hidden');
    renderSearch('');
    if (shouldAutoFocusSearch()) inp.focus();
  });
}

function renderSearch(query) {
  const list = $('#searchResults');
  if (!list) return;
  list.innerHTML = '';
  const meId = State.user && State.user.id;
  const all = (State.members || []).filter(u => u.id !== meId);
  const q = String(query || '').toLowerCase().trim();
  let shown = all;
  if (q) {
    shown = all.filter(u =>
      (u.username || '').toLowerCase().includes(q) ||
      (u.displayName || '').toLowerCase().includes(q) ||
      (u.bio || '').toLowerCase().includes(q)
    );
  } else {
    // Show "Suggested" header when empty
    const h = document.createElement('div');
    h.className = 'search-section-title';
    h.textContent = 'Suggested';
    list.appendChild(h);
    // Sort: online first
    shown = shown.slice().sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  }
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    if (q) {
      empty.textContent = `No members match "${escapeHtml(q)}"`;
      list.appendChild(empty);
      return;
    }
    // Empty state with a 'Refresh app' button so the user can self-heal
    // from a stale SW / broken cache without having to clear site data
    // manually. Common after deploys.
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn-secondary';
    refreshBtn.style.cssText = 'margin-top:14px;padding:10px 18px;border-radius:12px;border:1px solid var(--line);background:rgba(0,0,0,.04);color:inherit;font:600 13px/1 inherit;cursor:pointer';
    refreshBtn.textContent = '🔄 Refresh app';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true; refreshBtn.textContent = 'Refreshing…';
      try {
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
          await Promise.all(regs.map(r => r.unregister().catch(() => {})));
        }
        if (window.caches && caches.keys) {
          const keys = await caches.keys().catch(() => []);
          await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
        }
      } catch (_) {}
      const url = new URL(location.href);
      url.searchParams.set('heal', 'v68');
      location.replace(url.toString());
    });
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px';
    wrap.appendChild(empty);
    wrap.appendChild(refreshBtn);
    list.appendChild(wrap);
    return;
  }
  shown.forEach(u => {
    const li = document.createElement('li');
    const av = document.createElement('span');
    av.className = 'avatar md';
    renderAvatar(av, u);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <div class="nm">${escapeHtml(u.username || u.displayName)}</div>
      <div class="un">${escapeHtml(u.displayName || '')}${u.bio ? ' · ' + escapeHtml(u.bio) : ''}</div>
    `;
    li.appendChild(av);
    li.appendChild(meta);
    if (u.online) {
      const d = document.createElement('span');
      d.className = 'online-dot';
      d.title = 'Online';
      li.appendChild(d);
    }
    const send = document.createElement('button');
    send.className = 'ghost-btn';
    send.innerHTML = '<i data-lucide="send"></i>';
    send.title = 'Message';
    send.addEventListener('click', (e) => { e.stopPropagation(); openDM(u); switchTab('chat'); });
    li.appendChild(send);
    li.addEventListener('click', () => openUserProfile(u.id));
    list.appendChild(li);
  });
  refreshIcons();
}

function bindLightbox() {
  $('#lightboxClose').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#lightbox').classList.contains('hidden')) closeLightbox();
      if (!$('#scheduleModal').classList.contains('hidden')) $('#scheduleModal').classList.add('hidden');
      if (!$('#termsModal').classList.contains('hidden')) $('#termsModal').classList.add('hidden');
      if (!$('#commentsSheet').classList.contains('hidden')) closeCommentsSheet();
      if (!$('#notifSheet').classList.contains('hidden')) closeNotifications();
      if (!$('#settingsSheet').classList.contains('hidden')) closeSettings();
      if (!$('#closeFriendsSheet').classList.contains('hidden')) closeCloseFriendsSheet();
      if (!$('#storyManageSheet').classList.contains('hidden')) closeStoryManageSheet();
      if (!$('#userProfileSheet').classList.contains('hidden')) closeUserProfile();
      if (!$('#storyViewer').classList.contains('hidden')) closeStory();
      const mm = document.querySelector('.more-menu'); if (mm) mm.remove();
    }
  });
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lightboxImg').src = '';
}

// ====== Init ======
async function loadAll() {
  await loadMembers();
  await loadMessages(true);
}

/* ====== Toast with Undo button ====== */
function undoToast(msg, onUndo, durationMs = 6000) {
  const t = $('#toast');
  t.innerHTML = `<span>${escapeHtml(msg)}</span><button class="toast-undo">UNDO</button>`;
  t.className = 'toast with-undo';
  t.classList.remove('hidden');
  if (window.Motion && window.Motion.animate) {
    try {
      window.Motion.animate(t,
        { opacity: [0, 1], transform: ['translate(-50%, 14px) scale(.94)', 'translate(-50%, 0) scale(1)'] },
        { duration: 0.32, easing: [0.34, 1.4, 0.64, 1] });
    } catch (_) {}
  }
  let resolved = false;
  const btn = t.querySelector('.toast-undo');
  btn.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    clearTimeout(t._tm);
    t.classList.add('hidden');
    try { onUndo(); } catch (_) {}
  });
  clearTimeout(t._tm);
  t._tm = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    if (window.Motion && window.Motion.animate) {
      try {
        window.Motion.animate(t,
          { opacity: [1, 0], transform: ['translate(-50%, 0) scale(1)', 'translate(-50%, 8px) scale(.96)'] },
          { duration: 0.22, easing: 'ease-in' }).finished.then(() => t.classList.add('hidden')).catch(() => t.classList.add('hidden'));
      } catch (_) { t.classList.add('hidden'); }
    } else { t.classList.add('hidden'); }
  }, durationMs);
}

/* ====== Lazy image with blur-up placeholder ====== */
// Returns an <img> that shows a colored placeholder until the real image loads.
function lazyImg(src, alt = '', seed = '') {
  const img = document.createElement('img');
  img.alt = alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.style.background = `linear-gradient(135deg, ${colorOf(seed || src)}, ${colorOf((seed || src) + 'x')})`;
  img.style.opacity = '0';
  img.style.transition = 'opacity .35s ease';
  img.addEventListener('load', () => {
    img.style.opacity = '1';
    img.style.background = '';
  });
  img.addEventListener('error', () => {
    img.style.opacity = '1';   // keep placeholder color visible
    img.removeAttribute('src');
    img.alt = 'Image unavailable';
  });
  // Use IntersectionObserver to defer src assignment for off-screen images
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { img.src = src; obs.unobserve(img); }
      });
    }, { rootMargin: '200px' });
    requestAnimationFrame(() => io.observe(img));
  } else {
    img.src = src;
  }
  return img;
}

/* ====== Theme (dark/light/auto) + accent colour ====== */
function applyStoredTheme() {
  const stored = localStorage.getItem('ps_theme') || 'auto';
  if (stored === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', stored);
  $$('[data-theme-set]').forEach(b => b.classList.toggle('active', b.dataset.themeSet === stored));

  const accent = localStorage.getItem('ps_accent');
  if (accent) applyAccent(accent);
  $$('[data-accent]').forEach(b => b.classList.toggle('active', b.dataset.accent === (accent || '#00a2ff')));

  updateMetaThemeColor();
}
function setTheme(mode) {
  localStorage.setItem('ps_theme', mode);
  applyStoredTheme();
  toast('Theme: ' + (mode === 'auto' ? 'Auto (follow system)' : mode), 'success');
}
function applyAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-2', shadeColor(hex, -12));
  document.documentElement.style.setProperty('--accent-rgb', hexToRgb(hex));
  document.documentElement.style.setProperty('--accent-grad', `linear-gradient(135deg, ${shadeColor(hex, 12)} 0%, ${shadeColor(hex, -18)} 100%)`);
  updateMetaThemeColor(hex);
}
function setAccent(hex) {
  localStorage.setItem('ps_accent', hex);
  applyAccent(hex);
  $$('[data-accent]').forEach(b => b.classList.toggle('active', b.dataset.accent === hex));
}
function shadeColor(hex, percent) {
  const num = parseInt(hex.slice(1), 16);
  const r = (num >> 16) & 0xFF, g = (num >> 8) & 0xFF, b = num & 0xFF;
  const amt = Math.round(2.55 * percent);
  const cv = (v) => Math.max(0, Math.min(255, v + amt));
  return '#' + ((1 << 24) | (cv(r) << 16) | (cv(g) << 8) | cv(b)).toString(16).slice(1);
}
function hexToRgb(hex) {
  const num = parseInt(hex.slice(1), 16);
  return `${(num >> 16) & 255},${(num >> 8) & 255},${num & 255}`;
}
function updateMetaThemeColor(accentHex) {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
                 (document.documentElement.getAttribute('data-theme') !== 'light' &&
                  window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = isDark ? '#0b1620' : (accentHex || '#00a2ff');
}
function bindThemeToggle() {
  $$('[data-theme-set]').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.themeSet)));
  $$('[data-accent]').forEach(b => b.addEventListener('click', () => setAccent(b.dataset.accent)));
  const inst = $('#installAppBtn');
  if (inst) inst.addEventListener('click', showInstallPrompt);
  // React to OS theme change when in auto mode
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if ((localStorage.getItem('ps_theme') || 'auto') === 'auto') updateMetaThemeColor();
    });
  }
}

/* ====== PWA: service worker + install prompt ====== */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Skip on localhost without https — SW needs secure context
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js?v=72-rtc-fix').then((reg) => {
      try { reg.update(); } catch (_) {}
      // Listen for updates and activate quickly to remove any old stuck loader cache
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('[sw] new version waiting; activating now');
            try { sw.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
          }
          if (sw.state === 'activated' && navigator.serviceWorker.controller) {
            // If the old controller is still around, a reload is the only way
            // to switch to the new SW. Do it once, gracefully.
            if (!sessionStorage.getItem('ps_sw_reload_once')) {
              sessionStorage.setItem('ps_sw_reload_once', '1');
              console.log('[sw] activated new version; reloading once');
              setTimeout(() => location.reload(), 300);
            }
          }
        });
      });
      // If a new SW is already waiting (e.g. from a previous tab), activate it
      if (reg.waiting) {
        try { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
      }
    }).catch(err => console.warn('[sw] register failed', err.message));
  });
}

// ====== Self-healing utilities ======
const SelfHeal = {
  async clearCaches() {
    if (!window.caches || !caches.keys) return;
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
      console.log('[heal] cleared', keys.length, 'cache(s)');
    } catch (_) {}
  },
  async unregisterServiceWorkers() {
    if (!navigator.serviceWorker) return;
    try {
      const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
      console.log('[heal] unregistered', regs.length, 'SW registration(s)');
    } catch (_) {}
  },
  clearStorage() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && HEAL_STORAGE_PREFIXES.some(p => key.startsWith(p))) {
          localStorage.removeItem(key);
        }
      }
    } catch (_) {}
    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && HEAL_STORAGE_PREFIXES.some(p => key.startsWith(p))) {
          sessionStorage.removeItem(key);
        }
      }
    } catch (_) {}
    console.log('[heal] cleared app storage keys');
  },
  async clearIndexedDB() {
    if (!window.indexedDB || !indexedDB.databases) return;
    try {
      const dbs = await indexedDB.databases().catch(() => []);
      await Promise.all(dbs.map(db => {
        if (db && db.name && HEAL_STORAGE_PREFIXES.some(p => db.name.startsWith(p))) {
          return indexedDB.deleteDatabase(db.name);
        }
      }));
      console.log('[heal] cleared', dbs.length, 'IDB database(s)');
    } catch (_) {}
  },
  async probeApiHealth() {
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), HEAL_PROBE_TIMEOUT_MS) : null;
    try {
      const res = await fetch('/api/health', {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      return { ok: res && res.ok, status: res ? res.status : 0 };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, error: e && e.name };
    }
  },
  async probeSwVersion() {
    // Bypass SW cache by busting the URL. Old SW won't have cached this exact URL.
    const url = '/sw.js?__heal_probe=' + Date.now();
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), HEAL_PROBE_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) return { ok: false, reason: 'fetch-failed' };
      const text = await res.text();
      const match = text.match(/SW_VERSION\s*=\s*['"]([^'"]+)['"]/);
      const swVersion = match ? match[1] : null;
      return {
        ok: swVersion === APP_VERSION,
        swVersion,
        appVersion: APP_VERSION,
        reason: swVersion === APP_VERSION ? null : (swVersion ? 'version-mismatch' : 'no-version'),
      };
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, reason: 'exception', error: e && e.name };
    }
  },
  showManualReset(reason) {
    if (document.getElementById('ps-heal-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'ps-heal-overlay';
    overlay.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;">
        <div style="background:#111;color:#fff;max-width:420px;width:100%;border-radius:16px;padding:28px;font-family:system-ui,sans-serif;text-align:center;border:1px solid #333;">
          <h2 style="margin:0 0 12px;font-size:22px;">App needs a reset</h2>
          <p style="margin:0 0 20px;color:#bbb;line-height:1.5;">
            The app couldn't recover automatically (${reason || 'unknown issue'}).
            Tap below to clear cached data and reload.
          </p>
          <button id="ps-heal-reset" style="background:#00a2ff;color:#fff;border:none;border-radius:10px;padding:14px 28px;font-size:16px;cursor:pointer;font-weight:600;">
            Reset & Reload
          </button>
          <p style="margin:16px 0 0;font-size:12px;color:#777;">
            You will be signed out and the latest version will load.
          </p>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('ps-heal-reset').addEventListener('click', async () => {
      await SelfHeal.deepHeal('manual-reset');
    });
  },
  async deepHeal(reason) {
    console.warn('[heal] deep heal triggered:', reason);
    sessionStorage.setItem('ps_deep_heal_reason', reason || 'unknown');
    await SelfHeal.unregisterServiceWorkers();
    await SelfHeal.clearCaches();
    await SelfHeal.clearIndexedDB();
    SelfHeal.clearStorage();
    const url = new URL(location.href);
    url.searchParams.set('heal', 'done');
    try { location.replace(url.toString()); } catch (_) { location.reload(true); }
  },
  async bootHeal() {
    const attempts = parseInt(sessionStorage.getItem('ps_heal_attempts') || '0', 10);
    if (attempts >= HEAL_MAX_ATTEMPTS) {
      console.warn('[heal] too many heal attempts; showing manual reset');
      SelfHeal.showManualReset('too-many-auto-attempts');
      return { healed: false, reason: 'too-many-attempts' };
    }

    const [health, version] = await Promise.all([
      SelfHeal.probeApiHealth(),
      SelfHeal.probeSwVersion(),
    ]);

    const healthOk = health.ok;
    const versionOk = version.ok;

    if (healthOk && versionOk) {
      sessionStorage.removeItem('ps_heal_attempts');
      return { healed: false, healthy: true };
    }

    const reason = !healthOk
      ? ('health:' + (health.error || health.status || 'fail'))
      : ('version:' + (version.reason || 'mismatch'));

    sessionStorage.setItem('ps_heal_attempts', String(attempts + 1));
    await SelfHeal.deepHeal(reason);
    return { healed: true, reason };
  },
  startPeriodicCheck() {
    // After boot, keep an eye on API health. If it disappears while the tab
    // is active, it may be a wedged SW; try a lighter heal (clear caches,
    // unregister SW, reload) once per session.
    let lastHealthy = true;
    setInterval(async () => {
      if (document.hidden) return;
      const h = await SelfHeal.probeApiHealth();
      if (h.ok) {
        lastHealthy = true;
        return;
      }
      if (lastHealthy) {
        lastHealthy = false;
        console.warn('[heal] periodic check detected API loss');
        const attempts = parseInt(sessionStorage.getItem('ps_periodic_heal_attempts') || '0', 10);
        if (attempts < 1) {
          sessionStorage.setItem('ps_periodic_heal_attempts', String(attempts + 1));
          await SelfHeal.deepHeal('periodic-api-loss');
        }
      }
    }, 30000);
  },
};

let _installPrompt = null;
function bindInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _installPrompt = e;
    // Show our own "Install app" button in the profile view (added in HTML)
    const btn = $('#installAppBtn');
    if (btn) btn.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    _installPrompt = null;
    const btn = $('#installAppBtn');
    if (btn) btn.classList.add('hidden');
    toast('Installed! Find PRIV SPACA on your home screen.', 'success');
  });
}
async function showInstallPrompt() {
  if (!_installPrompt) {
    // iOS Safari: show instructions
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      toast('Tap the Share button → "Add to Home Screen"', '');
    } else {
      toast('Open this page in Chrome to install', '');
    }
    return;
  }
  _installPrompt.prompt();
  const choice = await _installPrompt.userChoice;
  _installPrompt = null;
  if (choice && choice.outcome === 'accepted') {
    toast('Installing…', 'success');
  }
}


window.addEventListener('resize', updateChatThreadChrome);

window.addEventListener('error', (e) => {
  const splash = $('#splash');
  const authHidden = $('#authShell') && $('#authShell').classList.contains('hidden');
  const appHidden = $('#appShell') && $('#appShell').classList.contains('hidden');
  if (splash && !splash.classList.contains('hidden') && authHidden && appHidden) {
    try { showAuth(); toast('Startup recovered. Please continue.', 'info'); } catch (_) {}
  }
});
window.addEventListener('unhandledrejection', () => {
  const splash = $('#splash');
  const authHidden = $('#authShell') && $('#authShell').classList.contains('hidden');
  const appHidden = $('#appShell') && $('#appShell').classList.contains('hidden');
  if (splash && !splash.classList.contains('hidden') && authHidden && appHidden) {
    try { showAuth(); } catch (_) {}
  }
});

/**
 * Global audio-pause guard.
 *
 * Whenever the user leaves the tab (switches tabs, minimises the browser,
 * backgrounds the app on mobile) or navigates away from the page, EVERY
 * audio/video source must stop immediately. Otherwise the music keeps
 * playing in the background, which is jarring and burns battery/data.
 *
 * Wired to:
 *   - `visibilitychange` -> tab/app backgrounded or foregrounded
 *   - `pagehide`         -> user is navigating away / closing the tab
 *   - `blur`             -> user switched to another window
 *
 * On return (visible) we do NOT auto-resume -- silence is the expected UX,
 * matching Instagram/WhatsApp. The user can re-tap the music button to
 * resume if they want it back.
 */
let _audioPauseGuardInstalled = false;
function pauseAllAudioForHide() {
  try {
    // 1. Post music in the feed (main player)
    if (typeof getPostMusicPlayer === 'function' && typeof isPostMusicPlaying === 'function' && isPostMusicPlaying()) {
      const player = getPostMusicPlayer();
      try { player.pause(); } catch (_) {}
      try { player.currentTime = 0; } catch (_) {}
      if (typeof _postMusicState !== 'undefined') {
        _postMusicState.postId = null;
        _postMusicState.src = '';
        _postMusicState.title = '';
        _postMusicState.artist = '';
      }
      if (typeof syncPostMusicUI === 'function') { try { syncPostMusicUI(); } catch (_) {} }
    }
  } catch (_) {}
  try {
    // 2. Note preview audio (top of profile / note editor)
    if (typeof stopNotePreviewAudio === 'function') { try { stopNotePreviewAudio(); } catch (_) {} }
  } catch (_) {}
  try {
    // 3. Story music preview in the editor (#storyBgAudioPlayer)
    const storyBg = document.getElementById('storyBgAudioPlayer');
    if (storyBg && !storyBg.paused) {
      try { storyBg.pause(); } catch (_) {}
      try { storyBg.currentTime = 0; } catch (_) {}
    }
  } catch (_) {}
  try {
    // 4. Inline <audio> elements (voice notes, #notePreviewAudio, etc.)
    const audios = document.querySelectorAll('audio');
    audios.forEach(a => {
      try {
        if (a && !a.paused) {
          a.pause();
          try { a.currentTime = 0; } catch (_) {}
        }
      } catch (_) {}
    });
  } catch (_) {}
  try {
    // 5. Reels + story playback <video> elements (they should also stop
    //    playing audio when the tab is hidden).
    const videos = document.querySelectorAll('video');
    videos.forEach(v => {
      try { if (v && !v.paused) { v.pause(); } } catch (_) {}
    });
  } catch (_) {}
  try {
    // 6. Incoming-call ringtone (WebAudio oscillator loop). It's an
    //    intrusive alert that must stop the moment the tab is hidden.
    if (typeof stopIncomingCallAlert === 'function') { try { stopIncomingCallAlert(); } catch (_) {} }
  } catch (_) {}
  try {
    // 7. Story playback (already handled in its own visibilitychange
    //    handler, but call again as a belt-and-braces).
    if (typeof pauseStoryForHold === 'function' && typeof storyPlayback !== 'undefined' && storyPlayback && storyPlayback.user) {
      try { pauseStoryForHold(); } catch (_) {}
    }
  } catch (_) {}
}

function installAudioPauseGuard() {
  if (_audioPauseGuardInstalled) return;
  _audioPauseGuardInstalled = true;
  const onHide = () => { if (document.hidden) pauseAllAudioForHide(); };
  document.addEventListener('visibilitychange', onHide);
  // pagehide fires on real navigations / tab close (more reliable than
  // beforeunload in modern browsers and during bfcache eviction).
  window.addEventListener('pagehide', pauseAllAudioForHide);
  // When the user alt-tabs to another window on desktop, blur also fires.
  window.addEventListener('blur', pauseAllAudioForHide);
}
// Install immediately so it covers any audio that starts before boot() runs.
installAudioPauseGuard();



function boot() {
  const yr = $('#yr');
  if (yr) yr.textContent = String(new Date().getFullYear());

  // v68-improved self-heal: detect both API unreachability AND stale SW/app
  // version mismatches. Deep-heal by unregistering SWs, clearing caches,
  // wiping app storage/IDB, and reloading. Caps attempts to avoid loops and
  // falls back to a manual reset overlay if auto-heal keeps failing.
  try { SelfHeal.bootHeal(); } catch (_) {}

  // Hard anti-stuck guard: if any startup/network/cache problem leaves the splash
  // visible, move to the login screen instead of showing an endless loader.
  startupFallback = setTimeout(() => {
    const splash = $('#splash');
    const authHidden = $('#authShell') && $('#authShell').classList.contains('hidden');
    const appHidden = $('#appShell') && $('#appShell').classList.contains('hidden');
    if (splash && !splash.classList.contains('hidden') && authHidden && appHidden) {
      try { showAuth(); } catch (_) { splash.classList.add('hidden'); }
      toast('Startup was slow. Showing login screen now.', 'info');
    }
  }, 5000);

  bindAuth();
  // Wrap each UI-binding step so a bug in any single one (e.g. a missing
  // handler function) can't crash the whole boot sequence and silently skip
  // session restore below — that was causing "logged out on every refresh".
  const bindSteps = [
    bindTabs, bindScrollMemory, bindRooms, bindInboxSegment, bindNotes, bindComposer, bindFeedComposer, bindProfile,
    bindSchedule, bindLightbox, bindCommentsSheet, bindSecretChat,
    bindStoryViewer, bindStoryReplyUI, bindCloseFriendsAndStoryManage, bindSearch, bindNotifSheet, bindUserProfileSheet,
    bindProfileView, bindInstallPrompt, bindThemeToggle, bindSettingsSheet,
  ];
  for (const step of bindSteps) {
    try { step(); } catch (e) { console.error('[boot] ' + (step.name || 'bind step') + ' failed:', e); }
  }
  try { registerServiceWorker(); } catch (e) { console.error('[boot] registerServiceWorker failed:', e); }
  try { SelfHeal.startPeriodicCheck(); } catch (e) { console.error('[boot] startPeriodicCheck failed:', e); }
  try { applyStoredTheme(); } catch (e) { console.error('[boot] applyStoredTheme failed:', e); }
  try { refreshIcons(); } catch (e) { console.error('[boot] refreshIcons failed:', e); }

  // Pause/resume polls when the tab is hidden to save data
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      initWebRTC();

  if (State.token && State.user) {
        loadMembers();
        pollNotifications();
        if (State.currentTab === 'chat') loadMessages(false);
        if (State.currentTab === 'feed') loadFeed(true);
        if (!_sseConnected) connectSSE();
      }
    } else {
      // When tab is hidden, drop SSE to save battery; reconnect on return
      disconnectSSE();
    }
  });

  initWebRTC();

  if (State.token && State.user) {
    // We have a stored session — show the app immediately so the user
    // doesn't see a flash of the login screen. Then validate the token
    // in the background; only log out on a real 401 (token rejected),
    // NOT on network errors (transient failures shouldn't kick the user out).
    showApp();
    api('/auth/me').then(d => {
      if (d && d.user) {
        State.user = d.user;
        try { localStorage.setItem('ps_user', JSON.stringify(State.user)); } catch (_) {}
        hydrateMeChips();
      } else {
        // Got a response but no user object -- treat as 401, kick out
        logout(true);
      }
    }).catch((e) => {
      // Network error / timeout: keep the user logged in with the cached
      // session, just show a soft warning. They'll revalidate as soon as
      // the next API call succeeds. This fixes the "any blip logs me out"
      // bug.
      if (e && e.status === 401) {
        logout(true);
      } else {
        console.warn('[boot] /auth/me failed but session kept (will revalidate on next call):', e && e.message);
      }
    });
  } else {
    showAuth();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
// ====== WEBRTC — Clean rewrite ======
let rtcPeerConnection = null;
let rtcLocalStream = null;
let rtcRemoteStream = null;
let rtcCurrentPeer = null;
let isVideoCall = false;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

// ====== Call state ======
let _callMuted = false;
let _callSpeakerOn = false;
let _callFacingMode = 'user';
let _callTimerInterval = null;
let _callConnectedAt = 0;
let _callConnected = false;   // single source of truth
let _callConnecting = false;
let _incomingCallAlertTimer = null;
let _incomingCallAudioCtx = null;
let _rtcInitialized = false;

function initWebRTC() {
  if (_rtcInitialized) return;
  _rtcInitialized = true;
  const callBtn = $('#rtcCallBtn');
  const chooser = $('#rtcCallChooser');
  if (callBtn && chooser) {
    callBtn.addEventListener('click', (e) => { e.stopPropagation(); chooser.classList.toggle('hidden'); refreshIcons(); });
    document.addEventListener('click', (e) => { if (!chooser.contains(e.target) && e.target !== callBtn) chooser.classList.add('hidden'); });
  }
  const btnAudio = $('#rtcAudioBtn');
  const btnVideo = $('#rtcVideoBtn');
  if (btnAudio) btnAudio.addEventListener('click', () => { if ($('#rtcCallChooser')) $('#rtcCallChooser').classList.add('hidden'); startCall(false); });
  if (btnVideo) btnVideo.addEventListener('click', () => { if ($('#rtcCallChooser')) $('#rtcCallChooser').classList.add('hidden'); startCall(true); });
  const btnAccept = $('#rtcAcceptBtn');
  const btnReject = $('#rtcRejectBtn');
  if (btnAccept) btnAccept.addEventListener('click', acceptCall);
  if (btnReject) btnReject.addEventListener('click', rejectOrEndCall);
  // In-call controls
  const muteBtn = $('#callMuteBtn');
  const speakerBtn = $('#callSpeakerBtn');
  const videoToggleBtn = $('#callVideoToggleBtn');
  const flipBtn = $('#callFlipBtn');
  if (muteBtn) muteBtn.addEventListener('click', toggleMute);
  if (speakerBtn) speakerBtn.addEventListener('click', toggleSpeaker);
  if (videoToggleBtn) videoToggleBtn.addEventListener('click', toggleVideoUpgrade);
  if (flipBtn) flipBtn.addEventListener('click', flipCamera);
}

// ---- Call UI state machine ----
function showCallUI(status, user, incoming) {
  const overlay = $('#callOverlay');
  overlay.classList.remove('hidden', 'video-active');
  _callConnected = false;
  _callConnecting = !incoming;

  // Info section
  $('#callInfo').classList.remove('minimized');
  $('#callName').textContent = (user.displayName || user.username || 'User');
  renderAvatar($('#callAvatar'), user);
  $('#callStatusText').textContent = status;
  $('#callTimer').classList.add('hidden');
  $('#callTimer').textContent = '00:00';
  $('#callVideos').classList.add('hidden');

  // Reset control button states
  resetCallControlBtns();

  // Hide controls during incoming ring so accept/reject buttons fit cleanly on mobile screens
  if (incoming) {
    $('#callActiveControls').classList.add('hidden');
    $('#rtcAcceptBtn').classList.remove('hidden');
  } else {
    $('#callActiveControls').classList.remove('hidden');
    $('#rtcAcceptBtn').classList.add('hidden');
  }
  $('#rtcRejectBtn').classList.remove('hidden');

  refreshIcons();
}

function onCallConnected() {
  if (_callConnected) return; // prevent double-fire
  _callConnected = true;
  _callConnecting = false;
  _disarmCallTimeout();

  $('#callStatusText').textContent = 'Connected';
  $('#callTimer').classList.remove('hidden');
  startCallTimer();

  // NOW show the in-call controls
  $('#callActiveControls').classList.remove('hidden');
  $('#rtcAcceptBtn').classList.add('hidden'); // hide accept if it was visible

  // Show video layer if video call
  if (isVideoCall) {
    $('#callVideos').classList.remove('hidden');
    $('#callOverlay').classList.add('video-active');
    $('#callVideoToggleBtn').classList.remove('hidden');
    $('#callFlipBtn').classList.remove('hidden');
  } else {
    // Audio call — show camera button so user can upgrade to video
    $('#callVideoToggleBtn').classList.remove('hidden');
    $('#callFlipBtn').classList.add('hidden');
  }

  refreshIcons();
}

function resetCallControlBtns() {
  // v73-icon-fix: query by [data-lucide] instead of the 'i' tag name. Lucide's
  // createIcons() (run once at boot, before any call is ever placed) replaces
  // every <i data-lucide="..."> placeholder with a real <svg data-lucide="...">
  // element. After that runs, querySelector('i') finds nothing and .setAttribute()
  // on null throws a TypeError — which used to happen synchronously inside
  // showCallUI() -> resetCallControlBtns(), i.e. BEFORE the caller ever created
  // or sent the WebRTC offer. That is why the caller's screen showed "Calling..."
  // while the callee never received anything: the call was aborted by this
  // exception before signaling even started. [data-lucide] matches both the
  // original <i> placeholder and Lucide's rendered <svg> replacement.
  _callMuted = false; _callSpeakerOn = false; _callFacingMode = 'user';
  const muteBtn = $('#callMuteBtn');
  if (muteBtn) { muteBtn.classList.remove('active'); muteBtn.querySelector('[data-lucide]')?.setAttribute('data-lucide', 'mic'); muteBtn.querySelector('span').textContent = 'Mute'; }
  const speakerBtn = $('#callSpeakerBtn');
  if (speakerBtn) { speakerBtn.classList.remove('active'); speakerBtn.querySelector('[data-lucide]')?.setAttribute('data-lucide', 'volume-2'); speakerBtn.querySelector('span').textContent = 'Speaker'; }
  const videoBtn = $('#callVideoToggleBtn');
  if (videoBtn) { videoBtn.classList.add('hidden'); videoBtn.classList.remove('active'); videoBtn.querySelector('[data-lucide]')?.setAttribute('data-lucide', 'video'); videoBtn.querySelector('span').textContent = 'Camera'; }
  const flipBtn = $('#callFlipBtn');
  if (flipBtn) { flipBtn.classList.add('hidden'); }
}

function callPeerName(user) {
  return (user && (user.displayName || user.username)) || 'Someone';
}

function maybeNotifyIncomingCall(user, video) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  if (localStorage.getItem('ps_pushEnabled') !== '1') return;
  try {
    const n = new Notification('Incoming PRIV SPACA ' + (video ? 'video call' : 'voice call'), {
      body: callPeerName(user) + ' is calling…',
      tag: 'priv-spaca-incoming-call',
      renotify: true,
      silent: false,
    });
    n.onclick = () => { try { window.focus(); } catch (_) {} try { n.close(); } catch (_) {} };
  } catch (_) {}
}

function playIncomingCallBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!_incomingCallAudioCtx) _incomingCallAudioCtx = new AudioCtx();
    const ctx = _incomingCallAudioCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.045, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.35);
  } catch (_) {}
}

function startIncomingCallAlert(user, video) {
  stopIncomingCallAlert();
  maybeNotifyIncomingCall(user, video);
  const pulse = () => {
    try { if (navigator.vibrate) navigator.vibrate([240, 80, 240]); } catch (_) {}
    playIncomingCallBeep();
  };
  pulse();
  _incomingCallAlertTimer = setInterval(pulse, 1800);
}

function stopIncomingCallAlert() {
  if (_incomingCallAlertTimer) clearInterval(_incomingCallAlertTimer);
  _incomingCallAlertTimer = null;
  try { if (navigator.vibrate) navigator.vibrate(0); } catch (_) {}
}

function showVideoCallChrome({ localCamera = false } = {}) {
  $('#callVideos')?.classList.remove('hidden');
  $('#callOverlay')?.classList.add('video-active');
  $('#callVideoToggleBtn')?.classList.remove('hidden');
  if (localCamera) $('#callFlipBtn')?.classList.remove('hidden');
}

async function handleRenegotiationOffer(peerId, signal) {
  if (!rtcPeerConnection || rtcCurrentPeer !== peerId || !signal || !signal.offer) return;
  try {
    await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.offer));
    const answer = await rtcPeerConnection.createAnswer();
    await rtcPeerConnection.setLocalDescription(answer);
    isVideoCall = !!signal.video || isVideoCall;
    sendRTCSignal(peerId, { type: 'answer', answer, video: isVideoCall });
    if (isVideoCall) showVideoCallChrome({ localCamera: !!(rtcLocalStream && rtcLocalStream.getVideoTracks().length) });
  } catch (e) {
    console.warn('[RTC] renegotiation failed', e && e.message);
    toast('Call update failed', 'error');
  }
}

function rejectOrEndCall() {
  const peerId = rtcCurrentPeer;
  const isIncomingPending = !!window._rtcPendingOffer && !_callConnected;
  if (isIncomingPending && peerId) {
    sendRTCSignal(peerId, { type: 'reject' });
    toast('Call declined', 'info');
    endCall(true);
    return;
  }
  endCall(false);
}

// ---- Signal sender ----
function sendRTCSignal(targetId, signal) {
  api('/rtc/signal', { method: 'POST', body: { targetId, signal } }).catch(e => {
    console.error('Signal error', e);
    console.warn('[rtc] signal failed (non-fatal):', e && e.message);
  });
}

// ---- Start outgoing call ----
async function startCall(video) {
  if (!State.currentRoom || State.currentRoom.kind !== 'dm' || !State.currentRoom.target) return;
  if (rtcPeerConnection) { toast('Already in a call', 'error'); return; }

  isVideoCall = video;
  rtcCurrentPeer = State.currentRoom.target.id;
  _callConnecting = true;

  try {
    rtcLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideoCall ? { facingMode: _callFacingMode } : false
    });
    if (isVideoCall) $('#rtcLocalVideo').srcObject = rtcLocalStream;
  } catch (err) {
    toast('Camera/Microphone access denied.', 'error');
    _callConnecting = false;
    return;
  }

  showCallUI('Calling...', State.currentRoom.target, false);
  createPeerConnection();
  rtcLocalStream.getTracks().forEach(t => rtcPeerConnection.addTrack(t, rtcLocalStream));

  try {
    const offer = await rtcPeerConnection.createOffer();
    await rtcPeerConnection.setLocalDescription(offer);
    sendRTCSignal(rtcCurrentPeer, { type: 'offer', offer, video: isVideoCall });
    _armCallTimeout();
  } catch (err) {
    toast('Failed to start call', 'error');
    endCall(false);
  }
}

// ---- Handle incoming signals ----
async function handleRTCSignal(data) {
  if (!data || !data.signal) return;
  const peerId = data.fromId;
  const signal = data.signal;
  const author = data.author;

  if (signal.type === 'offer') {
    // Reject stale offers (>45s old — allows for DB write lag + polling delay)
    const age = Date.now() - (data.createdAt || 0);
    if (data.createdAt && age > 45000) return;

    // Deduplicate offers delivered through both SSE and polling. SSE events do
    // not carry the rtcSignals row id, so also key by SDP fingerprint.
    const offerFingerprint = signal.offer && signal.offer.sdp
      ? String(signal.offer.sdp).slice(0, 180)
      : JSON.stringify(signal.offer || {}).slice(0, 180);
    const offerKey = data.id || (peerId + ':' + offerFingerprint);
    if (!window._handledRtcOffers) window._handledRtcOffers = new Set();
    if (offerKey && window._handledRtcOffers.has(offerKey)) return;
    if (offerKey) {
      window._handledRtcOffers.add(offerKey);
      // v66: bound the dedup set so it doesn't grow unboundedly over a
      // long session. When we hit 50 entries, drop the oldest half.
      if (window._handledRtcOffers.size > 50) {
        const drop = Math.floor(window._handledRtcOffers.size / 2);
        const it = window._handledRtcOffers.values();
        for (let i = 0; i < drop; i++) window._handledRtcOffers.delete(it.next().value);
      }
    }

    // A second *new* offer from the active peer is WebRTC renegotiation (used by
    // audio → video upgrade). Do not mark that as "busy".
    if (rtcPeerConnection && rtcCurrentPeer === peerId && signal.offer) {
      await handleRenegotiationOffer(peerId, signal);
      return;
    }

    // If we are already showing this same caller's incoming screen, ignore
    // duplicated offers rather than telling the caller we are busy.
    if (window._rtcPendingOffer && rtcCurrentPeer === peerId) return;

    // Busy or already ringing? Send busy signal so the caller gets immediate
    // feedback instead of waiting for the 30s no-answer timeout.
    if (rtcPeerConnection || _callConnecting || window._rtcPendingOffer) {
      sendRTCSignal(peerId, { type: 'busy' });
      return;
    }
    rtcCurrentPeer = peerId;
    isVideoCall = !!signal.video;
    window._rtcPendingOffer = signal.offer;
    showCallUI('Incoming ' + (isVideoCall ? 'Video' : 'Voice') + ' Call', author, true);
    startIncomingCallAlert(author, isVideoCall);
    // Arm a timeout: if user doesn't accept within 30s, auto-reject
    _armCallTimeout();

  } else if (signal.type === 'answer') {
    if (!rtcPeerConnection || rtcCurrentPeer !== peerId) return;
    // v76-fix: the SAME answer signal can be delivered twice — once via SSE
    // and once via the 1.5s pollRTCSignals() fallback (both are active at
    // once; see _sseNeedsPollingBackstop). The first delivery correctly
    // moves the connection to 'stable'. Calling setRemoteDescription()
    // again with that same (now stale) answer while already 'stable' is
    // invalid per the WebRTC spec and throws "Called in wrong state:
    // stable" — which the old code treated as fatal and used to hang up an
    // otherwise healthy, already-connected call right after pickup. An
    // answer is only ever valid to apply once, while we're still waiting
    // for one (signalingState === 'have-local-offer'); any other state
    // means this is a stale duplicate we should just ignore.
    if (rtcPeerConnection.signalingState !== 'have-local-offer') {
      console.warn('[RTC] ignoring duplicate/stale answer signal (signalingState=' + rtcPeerConnection.signalingState + ')');
      return;
    }
    try {
      await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
      if (window._pendingIceCandidates) {
        for (const c of window._pendingIceCandidates) {
          try { await rtcPeerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
        }
        window._pendingIceCandidates = null;
      }
      if (signal.video) {
        isVideoCall = true;
        showVideoCallChrome({ localCamera: !!(rtcLocalStream && rtcLocalStream.getVideoTracks().length) });
      }
    } catch (e) {
      console.warn('[RTC] setRemoteDescription(answer) failed', e.message);
      // Only tear down the call if we aren't already connected — a failure
      // here while already connected/stable would otherwise kill a working
      // call over what is, in practice, always a stale/duplicate signal.
      if (!_callConnected) endCall(false);
    }

  } else if (signal.type === 'candidate') {
    if ((window._rtcPendingOffer || !rtcPeerConnection || !rtcPeerConnection.remoteDescription) && rtcCurrentPeer === peerId) {
      window._pendingIceCandidates = window._pendingIceCandidates || [];
      window._pendingIceCandidates.push(signal.candidate);
      return;
    }
    if (!rtcPeerConnection || rtcCurrentPeer !== peerId) return;
    try {
      await rtcPeerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (e) {
      console.warn('[RTC] addIceCandidate failed', e.message);
    }

  } else if (signal.type === 'end' || signal.type === 'busy' || signal.type === 'reject') {
    if (rtcCurrentPeer === peerId) {
      const msg = signal.type === 'busy' ? 'User is busy' : (signal.type === 'reject' ? 'Call declined' : 'Call ended');
      toast(msg, 'info');
      endCall(true);
    }
  }
}

// ---- Accept incoming call ----
async function acceptCall() {
  if (!window._rtcPendingOffer) { toast('No pending call', 'error'); endCall(false); return; }
  stopIncomingCallAlert();
  $('#rtcAcceptBtn').classList.add('hidden');
  $('#callStatusText').textContent = 'Connecting...';
  _callConnecting = true;

  try {
    rtcLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideoCall ? { facingMode: _callFacingMode } : false
    });
    if (isVideoCall) $('#rtcLocalVideo').srcObject = rtcLocalStream;
  } catch (err) {
    toast('Camera/Microphone access denied.', 'error');
    rejectOrEndCall();
    return;
  }

  createPeerConnection();
  rtcLocalStream.getTracks().forEach(t => rtcPeerConnection.addTrack(t, rtcLocalStream));

  try {
    await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(window._rtcPendingOffer));
    if (window._pendingIceCandidates) {
      for (const c of window._pendingIceCandidates) {
        try { await rtcPeerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      }
      window._pendingIceCandidates = null;
    }
    const answer = await rtcPeerConnection.createAnswer();
    await rtcPeerConnection.setLocalDescription(answer);
    sendRTCSignal(rtcCurrentPeer, { type: 'answer', answer });
    window._rtcPendingOffer = null;
    // Connection confirmed by oniceconnectionstatechange → 'connected'
  } catch (err) {
    console.warn('[RTC] accept failed', err.message);
    endCall(false);
  }
}

// ---- Peer connection factory ----
function createPeerConnection() {
  rtcPeerConnection = new RTCPeerConnection(ICE_SERVERS);
  rtcRemoteStream = new MediaStream();
  $('#rtcRemoteVideo').srcObject = rtcRemoteStream;

  // Send ICE candidates to peer
  rtcPeerConnection.onicecandidate = (e) => {
    if (e.candidate && rtcCurrentPeer) {
      sendRTCSignal(rtcCurrentPeer, { type: 'candidate', candidate: e.candidate });
    }
  };

  // Remote track arrives → show media
  rtcPeerConnection.ontrack = (e) => {
    if (e.track) rtcRemoteStream.addTrack(e.track);
    else if (e.streams && e.streams[0]) e.streams[0].getTracks().forEach(track => rtcRemoteStream.addTrack(track));
    const remoteVid = $('#rtcRemoteVideo');
    if (remoteVid) {
      remoteVid.srcObject = rtcRemoteStream;
      remoteVid.play().catch(() => {});
    }
    if (isVideoCall) {
      $('#callVideos').classList.remove('hidden');
      $('#callOverlay').classList.add('video-active');
    }
  };

  // ICE connection state — SINGLE source of truth for connection status
  rtcPeerConnection.oniceconnectionstatechange = () => {
    if (!rtcPeerConnection) return;
    const st = rtcPeerConnection.iceConnectionState;

    if (st === 'connected' || st === 'completed') {
      onCallConnected();
    } else if (st === 'failed') {
      toast('Call connection failed. Try switching networks.', 'error');
      endCall(true);
    } else if (st === 'disconnected') {
      // Grace period — mobile networks flicker briefly
      setTimeout(() => {
        if (rtcPeerConnection && rtcPeerConnection.iceConnectionState === 'disconnected') {
          toast('Call connection lost.', 'error');
          endCall(true);
        }
      }, 8000);
    } else if (st === 'checking') {
      $('#callStatusText').textContent = 'Connecting...';
    }
  };
}

// ---- In-call controls ----
function toggleMute() {
  if (!rtcLocalStream) return;
  const tracks = rtcLocalStream.getAudioTracks();
  if (!tracks.length) return;
  _callMuted = !_callMuted;
  tracks.forEach(t => { t.enabled = !_callMuted; });
  const btn = $('#callMuteBtn');
  if (btn) {
    btn.classList.toggle('active', _callMuted);
    btn.querySelector('[data-lucide]')?.setAttribute('data-lucide', _callMuted ? 'mic-off' : 'mic');
    btn.querySelector('span').textContent = _callMuted ? 'Unmute' : 'Mute';
    refreshIcons();
  }
}

function toggleSpeaker() {
  _callSpeakerOn = !_callSpeakerOn;
  try {
    const el = $('#rtcRemoteVideo');
    if (el && el.setSinkId) {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const outs = devices.filter(d => d.kind === 'audiooutput');
        const loud = outs.find(d => /speaker|loud/i.test(d.label));
        const ear = outs.find(d => /earpiece|default/i.test(d.label));
        const target = _callSpeakerOn ? (loud || outs[0]) : (ear || outs[0]);
        if (target) el.setSinkId(target.deviceId).catch(() => {});
      }).catch(() => {});
    }
  } catch (_) {}
  const btn = $('#callSpeakerBtn');
  if (btn) {
    btn.classList.toggle('active', _callSpeakerOn);
    btn.querySelector('[data-lucide]')?.setAttribute('data-lucide', _callSpeakerOn ? 'volume-x' : 'volume-2');
    btn.querySelector('span').textContent = _callSpeakerOn ? 'Earpiece' : 'Speaker';
    refreshIcons();
  }
}

async function toggleVideoUpgrade() {
  if (!rtcPeerConnection || !rtcCurrentPeer) return;
  if (isVideoCall) {
    // Toggle camera on/off
    const tracks = rtcLocalStream ? rtcLocalStream.getVideoTracks() : [];
    if (tracks.length) {
      tracks[0].enabled = !tracks[0].enabled;
      const btn = $('#callVideoToggleBtn');
      if (btn) {
        btn.classList.toggle('active', !tracks[0].enabled);
        btn.querySelector('[data-lucide]')?.setAttribute('data-lucide', tracks[0].enabled ? 'video' : 'video-off');
        btn.querySelector('span').textContent = tracks[0].enabled ? 'Camera' : 'Cam Off';
        refreshIcons();
      }
    }
    return;
  }
  // Upgrade audio → video
  try {
    const vidStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: _callFacingMode } });
    const vidTrack = vidStream.getVideoTracks()[0];
    if (rtcLocalStream) rtcLocalStream.addTrack(vidTrack);
    const sender = rtcPeerConnection.addTrack(vidTrack, rtcLocalStream);
    $('#rtcLocalVideo').srcObject = rtcLocalStream;
    isVideoCall = true;
    // Re-negotiate
    const offer = await rtcPeerConnection.createOffer();
    await rtcPeerConnection.setLocalDescription(offer);
    sendRTCSignal(rtcCurrentPeer, { type: 'offer', offer, video: true });
    // Show video UI
    $('#callVideos').classList.remove('hidden');
    $('#callOverlay').classList.add('video-active');
    $('#callFlipBtn').classList.remove('hidden');
    const btn = $('#callVideoToggleBtn');
    if (btn) { btn.querySelector('[data-lucide]')?.setAttribute('data-lucide', 'video'); btn.querySelector('span').textContent = 'Camera'; }
    refreshIcons();
  } catch (err) {
    toast('Could not access camera', 'error');
  }
}

async function flipCamera() {
  if (!rtcLocalStream) return;
  const oldTrack = rtcLocalStream.getVideoTracks()[0];
  if (!oldTrack) return;
  _callFacingMode = _callFacingMode === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: _callFacingMode } });
    const newTrack = newStream.getVideoTracks()[0];
    const sender = rtcPeerConnection.getSenders().find(s => s.track === oldTrack);
    if (sender) await sender.replaceTrack(newTrack);
    rtcLocalStream.removeTrack(oldTrack); oldTrack.stop();
    rtcLocalStream.addTrack(newTrack);
    $('#rtcLocalVideo').srcObject = rtcLocalStream;
  } catch (_) {
    _callFacingMode = _callFacingMode === 'user' ? 'environment' : 'user';
    toast('Could not flip camera', 'error');
  }
}

// ---- Call timer ----
function startCallTimer() {
  _callConnectedAt = Date.now();
  clearInterval(_callTimerInterval);
  const el = $('#callTimer');
  if (el) el.classList.remove('hidden');
  _callTimerInterval = setInterval(() => {
    if (!el) return;
    const s = Math.floor((Date.now() - _callConnectedAt) / 1000);
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}

function stopCallTimer() {
  clearInterval(_callTimerInterval); _callTimerInterval = null;
  const el = $('#callTimer');
  if (el) { el.textContent = '00:00'; el.classList.add('hidden'); }
}

// ---- Call timeout (30s no answer) ----
let _rtcConnectTimeout = null;
function _armCallTimeout() {
  clearTimeout(_rtcConnectTimeout);
  _rtcConnectTimeout = setTimeout(() => {
    if (!_callConnected) {
      toast('No answer. They may be offline.', 'error');
      endCall(false);
    }
  }, 30000);
}
function _disarmCallTimeout() { clearTimeout(_rtcConnectTimeout); _rtcConnectTimeout = null; }

// ---- End call (full cleanup) ----
function endCall(remote) {
  _disarmCallTimeout();
  stopIncomingCallAlert();
  stopCallTimer();
  if (rtcPeerConnection) { try { rtcPeerConnection.close(); } catch (_) {} rtcPeerConnection = null; }
  if (rtcLocalStream) { rtcLocalStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} }); rtcLocalStream = null; }
  if (!remote && rtcCurrentPeer) sendRTCSignal(rtcCurrentPeer, { type: 'end' });
  rtcCurrentPeer = null; rtcRemoteStream = null;
  _callMuted = false; _callSpeakerOn = false; _callFacingMode = 'user';
  _callConnected = false; _callConnecting = false;
  window._rtcPendingOffer = null;
  window._pendingIceCandidates = null;
  isVideoCall = false;
  const overlay = $('#callOverlay');
  if (overlay) { overlay.classList.add('hidden'); overlay.classList.remove('video-active'); }
  const videos = $('#callVideos'); if (videos) videos.classList.add('hidden');
  const controls = $('#callActiveControls'); if (controls) controls.classList.add('hidden');
  const localVid = $('#rtcLocalVideo'); if (localVid) localVid.srcObject = null;
  const remoteVid = $('#rtcRemoteVideo'); if (remoteVid) remoteVid.srcObject = null;
}

})();
