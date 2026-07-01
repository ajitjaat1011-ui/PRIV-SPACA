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
  replyTo: null,
  attach: null,
  postAttach: null,
  pollTimers: {},
  rtcLastSignalAt: Math.max(Number(safeLocalGet('ps_rtcLastSignalAt', 0) || 0), Date.now() - 5000),
};

const API_BASE = '/api';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ====== API helper ======
function authHeaders() {
  return State.token ? { 'Authorization': 'Bearer ' + State.token } : {};
}
// Tiny GET cache (1.5s TTL) + in-flight de-duplication so notification poller
// and view loaders don't double-fetch the same endpoint within the same tick.
const _apiCache = new Map();      // key -> { ts, data }
const _apiInflight = new Map();   // key -> Promise
const API_CACHE_TTL_MS = 300;
let startupFallback = null;

async function api(path, options = {}) {
  const opts = Object.assign({ method: 'GET', headers: {} }, options);
  opts.headers = Object.assign({}, opts.headers, authHeaders());
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const isGet = (opts.method || 'GET').toUpperCase() === 'GET';
  const cacheKey = isGet ? path : null;
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
      if (path.startsWith('/messages')) {
        for (const k of [..._apiCache.keys()]) if (k.startsWith('/messages')) _apiCache.delete(k);
      } else if (path.startsWith('/posts')) {
        for (const k of [..._apiCache.keys()]) if (k.startsWith('/posts')) _apiCache.delete(k);
      } else if (path.startsWith('/user')) {
        _apiCache.delete('/users'); _apiCache.delete('/auth/me');
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
function resolveAuthor(rawAuthor, fallbackUserId) {
  if (rawAuthor && rawAuthor.username && rawAuthor.username !== 'unknown') return rawAuthor;
  // Try members directory
  if (fallbackUserId) {
    const m = State.members.find(u => u.id === fallbackUserId);
    if (m) return m;
  }
  // Embedded snapshot from server
  if (rawAuthor && (rawAuthor.displayName || rawAuthor.id)) return rawAuthor;
  // Synthetic fallback — derive short id label
  const id = fallbackUserId || (rawAuthor && rawAuthor.id) || 'member';
  const short = String(id).slice(-6);
  return { id, displayName: 'Member ' + short, username: 'member_' + short, photoUrl: '' };
}

// ====== Image upload (multi-provider with fallback) ======
async function uploadImage(file, onProgress) {
  if (!file) throw new Error('No file');
  if (file.size > 15 * 1024 * 1024) throw new Error('File too large (max 15MB)');
  // Try tmpfiles.org first
  try {
    return await uploadToTmpfiles(file, onProgress);
  } catch (e) {
    console.warn('tmpfiles failed, falling back to base64', e.message);
    // Fallback: embed as data URL (works always, but bloats DB)
    if (file.size > 800 * 1024) throw new Error('Image upload service unavailable. Please use a smaller image (<800KB) or try again later.');
    if (onProgress) onProgress(50);
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Read failed'));
      r.readAsDataURL(file);
    });
    if (onProgress) onProgress(100);
    return { url: dataUrl, name: file.name, size: file.size };
  }
}

function uploadToTmpfiles(file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://tmpfiles.org/api/v1/upload', true);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 95));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          let url = data && data.data && data.data.url;
          if (!url) return reject(new Error('Upload returned no URL'));
          url = url.replace('://tmpfiles.org/', '://tmpfiles.org/dl/');
          if (onProgress) onProgress(100);
          resolve({ url, name: file.name, size: file.size });
        } catch (e) { reject(new Error('Upload parse failed')); }
      } else reject(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('Timeout'));
    xhr.timeout = 60000;
    xhr.send(form);
  });
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
  _previousMessageIds = new Set();
  _previousPostIds = new Set();
  _storiesRendered = false;
  try { localStorage.removeItem('ps_token'); } catch (_) {}
  try { localStorage.removeItem('ps_user'); } catch (_) {}
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

  $$('.auth-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.authTab;
      $$('.auth-tab').forEach(b => b.classList.toggle('active', b === btn));
      $$('.auth-form').forEach(f => f.classList.remove('active'));
      const map = { login: '#loginForm', signup: '#signupForm', reset: '#resetForm' };
      $(map[tab]).classList.add('active');
      $$('.auth-error').forEach(el => el.textContent = '');
    });
  });

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
          $('[data-auth-tab="login"]').click();
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
  const chk = $('#postScratchCheckbox');
  if (chk) chk.checked = false;
  if (typeof clearPostAttach === 'function') clearPostAttach();
  const pm = $('#postComposerModal');
  if (pm) pm.classList.add('hidden');
}

function bindTabs() {
  $$('.bn-btn[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  // Legacy top-chat button is gone; keep guard in case markup is cached
  const tc = $('#topChatBtn');
  if (tc) tc.addEventListener('click', () => switchTab('chat'));
  const tn = $('#topNotifBtn');
  if (tn) tn.addEventListener('click', openNotifications);
  // New IG-style top "+" — jump to feed, focus composer, open photo picker
  const ta = $('#topAddBtn');
  if (ta) ta.addEventListener('click', openPostComposer);
  const icb = $('#inlineComposerCloseBtn');
  if (icb) icb.addEventListener('click', closePostComposer);
  const icab = $('#inlineComposerCancelBtn');
  if (icab) icab.addEventListener('click', closePostComposer);
  const pmc = $('#postModalClose');
  if (pmc) pmc.addEventListener('click', closePostComposer);
  const pm = $('#postComposerModal');
  if (pm) pm.addEventListener('click', (e) => { if (e.target === pm) closePostComposer(); });
}

function switchTab(tab) {
  State.currentTab = tab;
  $$('.bn-btn[data-tab]').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    if (active) popIn(b, { duration: 0.25 });
  });
  $$('.view').forEach(v => v.classList.remove('active'));
  let activeView = null;
  if (tab === 'feed') { activeView = $('#feedView'); activeView.classList.add('active'); loadMembers(); loadPosts(); markTabSeen('feed'); }
  if (tab === 'search') { activeView = $('#searchView'); activeView.classList.add('active'); loadMembers(); renderSearch(''); setTimeout(() => $('#searchInput').focus(), 100); }
  if (tab === 'groups') {
    activeView = $('#chatView');
    activeView.classList.add('active');
    markTabSeen('groups');
    const gs = $('#groupsPaneSection'); if (gs) gs.style.display = 'block';
    const ds = $('#dmsPaneSection'); if (ds) ds.style.display = 'none';
    const r = $('#roomsList .room-item[data-room="general-group"]');
    if (r) r.click();
  }
  if (tab === 'chat') {
    activeView = $('#chatView');
    activeView.classList.add('active');
    markTabSeen('chat');
    refreshSecretChatUI();
    const gs = $('#groupsPaneSection'); if (gs) gs.style.display = 'none';
    const ds = $('#dmsPaneSection'); if (ds) ds.style.display = 'block';
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
  if (activeView) springIn(activeView, { duration: 0.28 });
  refreshIcons();
  if (typeof updateNotifDots === 'function') updateNotifDots();
}

// ====== Rooms & Members ======
async function loadMembers() {
  try {
    const data = await api('/users');
    State.members = data.users || [];
    renderMembers();
  } catch (_) {}
}

let _lastMembersSig = '';
function renderMembers() {
  const list = $('#membersList');
  if (!list) return;
  const meId = State.user && State.user.id;
  const others = State.members.filter(u => u.id !== meId);
  const me = State.members.find(u => u.id === meId);
  $('#memberCount').textContent = String(State.members.length);
  const ordered = me ? [me, ...others] : others;
  // Skip rebuild if nothing visible changed (members list is shown in the chat side panel)
  const typingIds = (State.typingUsers || []).map(t => t.id).sort().join(',');
  const activeDM = (State.currentRoom.kind === 'dm' && State.currentRoom.target) ? State.currentRoom.target.id : '';
  const sig = ordered.map(u => u.id + ':' + (u.online?1:0) + ':' + (u.photoUrl?1:0)).join('|') + '||' + typingIds + '||' + activeDM;
  if (sig === _lastMembersSig && list.children.length > 0) return;
  _lastMembersSig = sig;
  list.innerHTML = '';
  ordered.forEach(u => {
    const li = document.createElement('li');
    li.className = 'member-item';
    if (State.currentRoom.kind === 'dm' && State.currentRoom.target && State.currentRoom.target.id === u.id) li.classList.add('active');
    const isMe = u.id === meId;
    const avatar = document.createElement('span');
    avatar.className = 'avatar sm';
    renderAvatar(avatar, u, { showStatus: true, online: !!u.online || isMe });
    const meta = document.createElement('div');
    meta.className = 'meta';
    const isTyping = !isMe && State.typingUsers.some(t => t.id === u.id);
    meta.innerHTML = `
      <span class="nm">${escapeHtml(u.displayName || u.username)}${isMe ? ' <span class="muted small">(you)</span>' : ''}</span>
      <span class="${isTyping ? 'member-typing' : 'un'}">${isTyping ? 'typing…' : '@' + escapeHtml(u.username)}</span>
    `;
    li.appendChild(avatar); li.appendChild(meta);
    if (!isMe) li.addEventListener('click', () => openDM(u));
    else li.style.cursor = 'default';
    list.appendChild(li);
  });
}

function openDM(user) {
  State.currentRoom = {
    id: dmRoomId(State.user.id, user.id),
    kind: 'dm',
    target: user,
    label: '@' + user.username
  };
  $('#chatTitle').textContent = user.displayName || ('@' + user.username);
  $('#chatSubtitle').textContent = '@' + user.username + (user.online ? ' · online' : ' · offline');
  const ca = $('#chatAvatar');
  ca.style.display = 'inline-flex';
  renderAvatar(ca, user, { showStatus: true, online: !!user.online });
  $$('#roomsList .room-item').forEach(r => r.classList.remove('active'));
  $('#chatView').classList.remove('show-rooms');
  if ($('#rtcCallActions')) $('#rtcCallActions').style.display = 'flex';
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
  if (!btn || !banner) return;
  // Secret chat only available in DMs (1-to-1)
  if (!room || room.kind !== 'dm' || !room.target) {
    btn.style.display = 'none';
    banner.classList.add('hidden');
    return;
  }
  btn.style.display = '';
  const on = isSecretChatOn(room.id);
  btn.classList.toggle('active', on);
  btn.title = on ? 'Secret Chat is ON (tap to turn off)' : 'Turn on Secret Chat (end-to-end encrypted)';
  if (on) {
    banner.classList.remove('hidden');
    const sel = $('#disappearSelect');
    if (sel) sel.value = String(getDisappearMs(room.id) || 0);
  } else {
    banner.classList.add('hidden');
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
      if ($('#rtcCallActions')) $('#rtcCallActions').style.display = 'none';
      _previousMessageIds = new Set();
      renderMembers();
      refreshSecretChatUI();
      loadMessages(true);
    });
  });
  const back = $('#backToRoomsBtn');
  if (back) back.addEventListener('click', () => $('#chatView').classList.toggle('show-rooms'));
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

async function loadMessages(scrollEnd) {
  try {
    const data = await api('/messages?roomId=' + encodeURIComponent(State.currentRoom.id));
    const newMsgs = data.messages || [];
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

function renderMessage(m, meId, grouped) {
  const row = document.createElement('div');
  row.className = 'message';
  if (m.scheduledOriginally) row.classList.add('scheduled-tag');
  if (grouped) row.classList.add('grouped');
  const isMine = m.userId === meId;
  if (isMine) row.classList.add('mine');
  row.dataset.id = m.id;

  const author = resolveAuthor(m.author, m.userId);

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
    al.textContent = author.displayName || ('@' + author.username);
    const tA = bubbleTintFor(m.userId);
    al.style.setProperty('--bubble-author', tA.author);
    wrap.appendChild(al);
  }

  const bubble = document.createElement('div');
  const isImageOnly = !!m.imageUrl && !m.text && !m.replyTo;
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
    const previewText = m.replyTo.text ? m.replyTo.text : (m.replyTo.imageUrl ? '📷 Photo' : '…');
    q.innerHTML = `<strong>@${escapeHtml(m.replyTo.username || 'user')}</strong><div class="quoted-text">${escapeHtml(previewText.slice(0, 140))}</div>`;
    q.addEventListener('click', () => {
      const el = $('#messagesList .message[data-id="' + m.replyTo.id + '"]');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.transition = 'background .3s'; const b = el.querySelector('.bubble'); if (b) { b.style.boxShadow = '0 0 0 3px rgba(0,162,255,.4)'; setTimeout(() => b.style.boxShadow = '', 1500); } }
    });
    bubble.appendChild(q);
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
    if (m.imageUrl.includes('.webm') || m.imageUrl.includes('.mp3') || m.imageUrl.startsWith('data:audio/')) {
      const au = document.createElement('audio');
      au.controls = true;
      au.src = m.imageUrl;
      au.style.width = '200px';
      au.style.display = 'block';
      au.style.borderRadius = '24px';
      au.style.marginTop = '4px';
      bubble.appendChild(au);
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
  const author = resolveAuthor(m.author, m.userId);
  State.replyTo = {
    id: m.id,
    text: m.text || (m.imageUrl ? '📷 Photo' : ''),
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
      State.messages.push(data.message);
      lastMessagesSignature = '';
      renderMessages(true);
    } catch (err) {
      toast(err.message || 'Send failed', 'error');
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
            State.attach = { file: new File([audioBlob], 'voice_note.webm', {type:'audio/webm'}), url: data.url };
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

  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    await handleAttach(f);
  });

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
  $('#attachThumb').src = att.url;
  $('#attachName').textContent = (att.name || 'image') + ' · ready';
  $('#attachProgress').style.width = '100%';
  $('#attachPreview').classList.remove('hidden');
}

function clearAttach() {
  State.attach = null;
  $('#attachPreview').classList.add('hidden');
  $('#attachThumb').src = '';
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

function startPolls() {
  sendHeartbeat();
  loadMembers();
  pollTyping();
  pollNotifications();
  pollRTCSignals();
  State.pollTimers.hb = setInterval(sendHeartbeat, 20000);
  State.pollTimers.members = setInterval(loadMembers, 15000);
  // MESSAGES: 1.5s on chat tab (fast feels live), 3s otherwise — unless SSE is alive
  State.pollTimers.msg = setInterval(() => {
    if (State.currentTab !== 'chat') return;
    if (_sseConnected) return;
    loadMessages(false);
  }, 1500);
  State.pollTimers.typing = setInterval(() => { if (State.currentTab === 'chat') pollTyping(); }, 2000);
  // FEED: 4s on feed tab (or 1.5s during fast mode)
  State.pollTimers.feed = setInterval(() => {
    if (State.currentTab !== 'feed') return;
    if (_sseConnected) return;
    loadPosts();
  }, isFastPolling() ? 1500 : 4000);
  // NOTIFICATIONS: 5s normally, 2s during fast mode (after sending a message etc)
  State.pollTimers.notif = setInterval(() => {
    if (_sseConnected) return;
    pollNotifications();
  }, 5000);
  // RTC call signaling must always poll as a Cloudflare fallback because SSE events can land on another isolate.
  State.pollTimers.rtc = setInterval(pollRTCSignals, 2500);
  // Try SSE — it'll auto-fall-back if not supported
  connectSSE();
}

/* ========== Real-time Server-Sent Events ========== */
let _sseConnected = false;
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
      // Append if not already present
      if (!State.messages.some(m => m.id === msg.id)) {
        State.messages.push(msg);
        lastMessagesSignature = '';
        renderMessages(false);
      }
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
      lastPostsSignature = '';
      if (State.currentTab === 'feed') renderPosts();
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
      if (State.currentTab === 'feed') loadPosts && loadPosts();
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
  } catch (_) {}

  // 2) New general-group messages (client tracks per-tab lastSeen so unread is true unread)
  const seenChat = _getLastSeen('ps_seenChatAt') || (Date.now() - 24*3600*1000);
  try {
    const r = await api('/messages?roomId=general-group');
    (r.messages || []).forEach(m => {
      if (m.userId !== meId && m.createdAt > seenChat) chatUnread++;
    });
  } catch (_) {}

  // 3) Keep posts cached for stories rail + saved tab
  try {
    const r = await api('/posts');
    State.posts = r.posts || State.posts;
  } catch (_) {}

  // 4) Unviewed stories add to feed dot
  try {
    (State.members || []).forEach(u => {
      if (u.id === meId) return;
      const theirLatest = (State.posts || []).filter(p => p.userId === u.id)
        .reduce((max, p) => Math.max(max, p.createdAt || 0), 0);
      if (theirLatest && !isStoryViewed(u.id)) feedUnread++;
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
let lastPostsSignature = '';
async function loadPosts() {
  try {
    const data = await api('/posts');
    const newPosts = data.posts || [];
    const sig = newPosts.map(p => p.id + ':' + p.likeCount + ':' + p.commentCount).join('|');
    if (sig === lastPostsSignature) return;
    lastPostsSignature = sig;
    State.posts = newPosts;
    renderPosts();
  } catch (_) {}
}

// "Stories" — synthesized from the active members directory.
// Each member gets a story cell; clicking opens a story viewer.
let _storiesRendered = false;
let _lastStoriesSig = '';
function renderStoriesRail() {
  const rail = $('#storiesRail');
  if (!rail) return;
  if (!State.members || State.members.length === 0) {
    rail.style.display = 'none';
    return;
  }
  const meId = State.user && State.user.id;
  const me = State.members.find(m => m.id === meId) || State.user;
  const others = State.members
    .filter(m => m.id !== meId)
    .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  // Signature based on member ids + viewed-state of each (so ring colour-change re-renders)
  const sig = [me && me.id, ...others.map(o => o.id + ':' + (isStoryViewed(o.id)?'v':'u'))].join('|');
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
  const viewed = !isMe && isStoryViewed(user.id);
  ring.className = 'story-ring' + (isMe ? ' is-me' : (viewed ? ' viewed' : ''));
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
    ring.appendChild(badge);
  }
  cell.appendChild(ring);
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = isMe ? 'Your story' : (user.username || user.displayName || '');
  cell.appendChild(lbl);
  cell.addEventListener('click', () => {
    if (isMe) {
      const ta = $('#postInput');
      if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    } else {
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
  const currentIds = new Set(State.posts.map(p => p.id));
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
  if (State.posts.length === 0) {
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
  State.posts.forEach((p, idx) => {
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
}

function attachScratchOverlay(wrap) {
  const overlay = document.createElement('div');
  overlay.className = 'scratch-overlay';
  overlay.style.cssText = 'position:absolute; inset:0; z-index:5; display:flex; align-items:center; justify-content:center; cursor:pointer; touch-action:none; border-radius:18px; overflow:hidden;';
  
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%; height:100%; display:block;';
  overlay.appendChild(canvas);
  wrap.appendChild(overlay);

  const initCanvas = () => {
    const w = wrap.clientWidth || 360;
    const h = wrap.clientHeight || 360;
    if (w <= 0 || h <= 0) { setTimeout(initCanvas, 100); return; }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#334155'); grad.addColorStop(0.3, '#94a3b8'); grad.addColorStop(0.6, '#64748b'); grad.addColorStop(1, '#1e293b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    // Sparkles
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    for (let i = 0; i < w; i += 18) {
      for (let j = 0; j < h; j += 18) {
        if ((i + j) % 36 === 0) { ctx.beginPath(); ctx.arc(i, j, 1.8, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    // Badge
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.roundRect(w/2 - 120, h/2 - 24, 240, 48, 24);
    ctx.fill();
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('✨ Scratch to Reveal Secret! ✨', w/2, h/2);

    let isScratching = false;
    const scratchAt = (pos) => {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 35, 0, Math.PI * 2);
      ctx.fill();
    };
    const checkDone = () => {
      try {
        const data = ctx.getImageData(0, 0, w, h).data;
        let cleared = 0, total = 0;
        for (let i = 3; i < data.length; i += 4 * 25) { total++; if (data[i] === 0) cleared++; }
        if (cleared / total > 0.42) {
          overlay.style.transition = 'opacity 0.65s ease, transform 0.65s ease';
          overlay.style.opacity = '0';
          overlay.style.transform = 'scale(1.05)';
          setTimeout(() => overlay.remove(), 650);
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
    const move = (e) => { if (!isScratching) return; if (e.cancelable) e.preventDefault(); scratchAt(getPos(e)); };
    const end = () => { if (isScratching) { isScratching = false; checkDone(); } };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
  };
  setTimeout(initCanvas, 50);
}

function renderPost(p) {
  const card = document.createElement('article');
  card.className = 'post-card';
  card.dataset.id = p.id;

  const author = resolveAuthor(p.author, p.userId);
  const meId = State.user && State.user.id;
  const isMine = p.userId === meId;
  const liked = Array.isArray(p.likes) && p.likes.includes(meId);
  const saved = !!getSaved()[p.id];

  // Build the header DOM once; we'll attach it either above the media
  // (text-only posts) or overlaid ON the media (image posts, IG-style).
  const buildHead = (overlayMode) => {
    const head = document.createElement('div');
    head.className = overlayMode ? 'post-overlay-head' : 'post-head';
    const avRing = document.createElement('span');
    avRing.className = 'avatar-ring';
    const av = document.createElement('span');
    av.className = 'avatar md';
    renderAvatar(av, author);
    avRing.appendChild(av);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <div class="nm">
        <span>${escapeHtml(author.username || author.displayName)}</span>
        <span class="dot-sep">•</span>
        <span class="ago">${escapeHtml(timeAgo(p.createdAt))}</span>
      </div>
      <div class="un">${escapeHtml(author.displayName || '')}</div>
    `;
    const moreBtn = document.createElement('button');
    moreBtn.className = 'more-btn';
    moreBtn.setAttribute('aria-label', 'More');
    moreBtn.innerHTML = '<i data-lucide="more-horizontal"></i>';
    moreBtn.addEventListener('click', (e) => { e.stopPropagation(); openMoreMenu(p, isMine); });
    head.appendChild(avRing); head.appendChild(meta); head.appendChild(moreBtn);
    const openProfile = () => { if (p.userId !== (State.user && State.user.id)) openUserProfile(p.userId); else switchTab('profile'); };
    avRing.style.cursor = 'pointer';
    meta.style.cursor = 'pointer';
    avRing.addEventListener('click', (e) => { e.stopPropagation(); openProfile(); });
    meta.addEventListener('click', (e) => { e.stopPropagation(); openProfile(); });
    return head;
  };

  const imgs = Array.isArray(p.images) && p.images.length > 0 ? p.images : (p.imageUrl ? [p.imageUrl] : []);

  // Image with double-tap to like — header is overlaid on top of the media
  if (imgs.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'post-img-wrap';
    wrap.appendChild(buildHead(true));

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
      if (p.isScratch) attachScratchOverlay(wrap);
      card.appendChild(wrap);
    }
    if (imgs.length === 1 && p.isScratch) attachScratchOverlay(card.querySelector('.post-img-wrap'));
  } else {
    // Text-only post — no media to overlay onto, so put a classic header at top
    card.appendChild(buildHead(false));
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
      txt.innerHTML = `Liked by <strong>${escapeHtml(liker.username)}</strong>`;
    } else if (liker && p.likeCount > 1) {
      const others = p.likeCount - 1;
      txt.innerHTML = `Liked by <strong>${escapeHtml(liker.username)}</strong> and <strong>${others} other${others === 1 ? '' : 's'}</strong>`;
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
    authorSpan.textContent = author.username || author.displayName;
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
      const cAuth = resolveAuthor(c.author, c.userId);
      const row = document.createElement('div');
      row.className = 'preview-comment';
      const a = document.createElement('span'); a.className = 'author';
      a.textContent = cAuth.username || cAuth.displayName;
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
      txt.innerHTML = `Liked by <strong>${escapeHtml(liker.username)}</strong>`;
    } else if (liker && p.likeCount > 1) {
      const others = p.likeCount - 1;
      txt.innerHTML = `Liked by <strong>${escapeHtml(liker.username)}</strong> and <strong>${others} other${others === 1 ? '' : 's'}</strong>`;
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
      const cAuth = resolveAuthor(c.author, c.userId);
      const row = document.createElement('div');
      row.className = 'preview-comment';
      const a = document.createElement('span'); a.className = 'author';
      a.textContent = cAuth.username || cAuth.displayName;
      row.appendChild(a);
      row.appendChild(document.createTextNode(' ' + (c.text || '')));
      pv.appendChild(row);
    });
  } else if (pv) {
    pv.remove();
  }
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
        lastPostsSignature = ''; loadPosts();
        undoToast('Post deleted', async () => {
          try {
            await api('/posts/restore', { method: 'POST', body: { postId: p.id } });
            lastPostsSignature = ''; loadPosts();
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
    const cAuth = resolveAuthor(c.author, c.userId);
    const li = document.createElement('li');
    const a = document.createElement('span'); a.className = 'avatar sm';
    renderAvatar(a, cAuth);
    const b = document.createElement('div'); b.className = 'body';
    const txt = document.createElement('div'); txt.className = 'text';
    const author = document.createElement('span'); author.className = 'author';
    author.textContent = cAuth.username || cAuth.displayName;
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
  // Find the user's latest post timestamp
  const latest = (State.posts || []).filter(p => p.userId === userId)
    .reduce((max, p) => Math.max(max, p.createdAt || 0), 0);
  // If we haven't seen any post (latest=0) treat as not-viewed only for first 24h after first appearance
  if (!latest) return !!entry.viewedAt;
  // Viewed if our last view is at or after the latest post
  return entry.viewedAt >= latest;
}
function markStoryViewed(userId) {
  const latest = (State.posts || []).filter(p => p.userId === userId)
    .reduce((max, p) => Math.max(max, p.createdAt || 0), 0);
  const map = _getStoryViewed();
  map[userId] = { lastPostTs: latest, viewedAt: Date.now() };
  _setStoryViewed(map);
}

let storyTimer = null;
function openStoryFor(user) {
  markStoryViewed(user.id);
  const theirPosts = (State.posts || []).filter(p => p.userId === user.id).sort((a, b) => b.createdAt - a.createdAt);
  const recent = theirPosts[0];
  const v = $('#storyViewer');
  const content = $('#storyContent');
  const progress = $('#storyProgress');
  content.innerHTML = '';
  progress.innerHTML = '<div class="bar active"><div class="fill"></div></div>';
  renderAvatar($('#storyAvatar'), user);
  $('#storyName').textContent = user.displayName || user.username;
  $('#storyMeta').textContent = recent ? timeAgo(recent.createdAt) : 'just now';
  if (recent && recent.imageUrl) {
    const img = document.createElement('img');
    img.src = recent.imageUrl;
    img.alt = 'story';
    content.appendChild(img);
  } else if (recent && recent.text) {
    const div = document.createElement('div');
    div.className = 'text-story';
    div.textContent = recent.text.slice(0, 280);
    content.appendChild(div);
  } else {
    const div = document.createElement('div');
    div.className = 'text-story';
    div.textContent = (user.bio && user.bio.trim()) || `👋 Hi from ${user.displayName || user.username}!`;
    content.appendChild(div);
  }
  v.classList.remove('hidden');
  const contentEl = $('#storyContent');
  if (contentEl) motionAnimate(contentEl,
    { opacity: [0, 1], transform: ['scale(.94)', 'scale(1)'] },
    { duration: 0.32, easing: [0.2, 0.85, 0.2, 1] }
  );
  refreshIcons();
  clearTimeout(storyTimer);
  storyTimer = setTimeout(closeStory, 5100);
}
function closeStory() {
  clearTimeout(storyTimer);
  storyTimer = null;
  $('#storyViewer').classList.add('hidden');
  // Re-render the stories rail so the just-viewed ring turns grey
  if (typeof renderStoriesRail === 'function') renderStoriesRail();
}
function bindStoryViewer() {
  $('#storyClose').addEventListener('click', closeStory);
  $('#storyPrev').addEventListener('click', closeStory);
  $('#storyNext').addEventListener('click', closeStory);
  $('#storyViewer').addEventListener('click', (e) => {
    if (e.target.id === 'storyViewer') closeStory();
  });
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
      await api('/posts/create', { method: 'POST', body: { text, imageUrl, images, isScratch } });
      $('#postInput').value = '';
      if (chk) chk.checked = false;
      clearPostAttach();
      lastPostsSignature = '';
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
        bio: String(fd.get('bio') || '').trim()
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
  const ico = { like: 'heart', comment: 'message-circle', follow: 'user-plus', message: 'send' }[n.kind] || 'bell';
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
    if (n.kind === 'follow' || n.kind === 'message' || n.kind === 'like' || n.kind === 'comment') {
      if (n.kind === 'message' && n.fromUserId) {
        // Open DM with sender
        const member = (State.members || []).find(m => m.id === n.fromUserId);
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
  $$('#settingsSheet [data-theme-set]').forEach(b => b.classList.toggle('active', b.dataset.themeSet === stored));
  const accent = localStorage.getItem('ps_accent') || '#00a2ff';
  $$('#settingsSheet [data-accent]').forEach(b => b.classList.toggle('active', b.dataset.accent === accent));
  updatePushStatus();
  updateRealtimeStatus();
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
    el.textContent = 'Live'; el.className = 'settings-chip live';
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
  const ep = $('#settingsEditProfile');
  if (ep) ep.addEventListener('click', () => {
    closeSettings();
    switchTab('profile');
    setTimeout(() => { const btn = $('#editProfileBtn'); if (btn) btn.click(); }, 200);
  });
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
  $('#upHeaderUsername').textContent = '@' + u.username;
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
      await api('/user/' + action, { method: 'POST', body: { targetId: u.id }});
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
  const cell = document.createElement('div');
  cell.className = 'ig-grid-cell';
  if (p.imageUrl) {
    const img = lazyImg(p.imageUrl, '', p.id);
    img.addEventListener('error', () => {
      img.remove();
      const fb = document.createElement('div');
      fb.className = 'text-only';
      fb.textContent = p.text || '(image)';
      cell.appendChild(fb);
    });
    cell.appendChild(img);
  } else if (p.text) {
    const div = document.createElement('div');
    div.className = 'text-only';
    div.textContent = p.text.slice(0, 200);
    cell.appendChild(div);
  }
  if (p.likeCount > 0 || p.commentCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.innerHTML = `<i data-lucide="heart"></i>${p.likeCount || 0}`;
    cell.appendChild(badge);
  }
  cell.addEventListener('click', () => {
    if (p.imageUrl) openLightbox(p.imageUrl, '');
    else toast(p.text || '');
  });
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
// ===== Own profile view (IG-style) — render + edit toggle
// ============================================================
let _profileTab = 'posts';

async function renderOwnProfile() {
  if (!State.user) return;
  // Fetch fresh data (own profile uses same endpoint)
  try {
    const data = await api('/user/' + encodeURIComponent(State.user.id) + '/profile');
    const u = data.user;
    $('#profileDisplayName').textContent = u.displayName || '';
    $('#profileUsername').textContent = '@' + u.username + (u.bio ? '' : '');
    const titleU = $('#profileTitleUsername');
    if (titleU) titleU.textContent = '@' + (u.username || 'me');
    $('#profileBio').textContent = u.bio || '';
    $('#statPosts').textContent = String(u.postsCount || 0);
    $('#statFollowers').textContent = String(u.followers || 0);
    $('#statFollowing').textContent = String(u.following || 0);
    renderAvatar($('#profileAvatarPreview'), u);
    // Grid
    const grid = $('#profilePostsGrid');
    grid.innerHTML = '';
    let postsToShow = data.posts;
    if (_profileTab === 'saved') {
      // Use the bookmark localStorage to filter ALL posts
      const saved = getSaved();
      postsToShow = (State.posts || []).filter(p => saved[p.id]).map(p => ({
        id: p.id, imageUrl: p.imageUrl, text: p.text,
        likeCount: p.likeCount, commentCount: p.commentCount
      }));
    }
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

function bindProfileView() {
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
      if (dn) dn.value = State.user.displayName || '';
      if (un) un.value = State.user.username || '';
      if (bio) bio.value = State.user.bio || '';
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
  // Grid tabs
  $$('.ig-tab').forEach(t => t.addEventListener('click', () => {
    $$('.ig-tab').forEach(x => x.classList.toggle('active', x === t));
    _profileTab = t.dataset.grid;
    renderOwnProfile();
  }));
  // Stat buttons → toggle which list shown? For now they're decorative
}

// ===== Search =====
function bindSearch() {
  const inp = $('#searchInput');
  const clear = $('#searchClearBtn');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    clear.classList.toggle('hidden', !q);
    renderSearch(q);
  });
  clear.addEventListener('click', () => {
    inp.value = ''; clear.classList.add('hidden');
    renderSearch(''); inp.focus();
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
    empty.textContent = q ? `No members match "${escapeHtml(q)}"` : 'No other members yet.';
    list.appendChild(empty);
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
    navigator.serviceWorker.register('/sw.js?v=13').then((reg) => {
      try { reg.update(); } catch (_) {}
      // Listen for updates and offer reload
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available — activate quickly to remove any old stuck loader cache
            try { sw.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {}
            console.log('[sw] new version installed; activating');
          }
        });
      });
    }).catch(err => console.warn('[sw] register failed', err.message));
  });
}

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

function boot() {
  const yr = $('#yr');
  if (yr) yr.textContent = String(new Date().getFullYear());

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
    bindTabs, bindRooms, bindComposer, bindFeedComposer, bindProfile,
    bindSchedule, bindLightbox, bindCommentsSheet, bindSecretChat,
    bindStoryViewer, bindSearch, bindNotifSheet, bindUserProfileSheet,
    bindProfileView, bindInstallPrompt, bindThemeToggle, bindSettingsSheet,
  ];
  for (const step of bindSteps) {
    try { step(); } catch (e) { console.error('[boot] ' + (step.name || 'bind step') + ' failed:', e); }
  }
  try { registerServiceWorker(); } catch (e) { console.error('[boot] registerServiceWorker failed:', e); }
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
        if (State.currentTab === 'feed') loadPosts();
        if (!_sseConnected) connectSSE();
      }
    } else {
      // When tab is hidden, drop SSE to save battery; reconnect on return
      disconnectSSE();
    }
  });

  initWebRTC();

  if (State.token && State.user) {
    api('/auth/me').then(d => {
      if (d && d.user) {
        State.user = d.user;
        try { localStorage.setItem('ps_user', JSON.stringify(State.user)); } catch (_) {}
        showApp();
      } else { showAuth(); }
    }).catch(() => showAuth());
  } else {
    showAuth();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
// --- WEBRTC ---
let rtcPeerConnection = null;
let rtcLocalStream = null;
let rtcRemoteStream = null;
let rtcCurrentPeer = null; // targetId we are talking to
let isVideoCall = false;

// STUN-only ICE config frequently fails to establish real media connections on
// mobile data / carrier-grade NAT / strict corporate networks (STUN can only
// help peers discover each other's public address; it can't relay media when
// a direct path isn't possible). We add a free public TURN relay (Open Relay
// Project) as a fallback so calls still connect in those cases. This is a
// shared/free/rate-limited community relay — for real production use with
//24/7 traffic, replace with account-specific TURN credentials (e.g. Twilio
// Network Traversal Service, Metered.ca, or your own coturn server) via env
// vars, but this unblocks calling immediately at zero cost.
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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


function initWebRTC() {
  const btnAudio = $('#rtcAudioBtn');
  const btnVideo = $('#rtcVideoBtn');
  const btnAccept = $('#rtcAcceptBtn');
  const btnReject = $('#rtcRejectBtn');
  if(btnAudio) btnAudio.addEventListener('click', () => startCall(false));
  if(btnVideo) btnVideo.addEventListener('click', () => startCall(true));
  if(btnAccept) btnAccept.addEventListener('click', acceptCall);
  if(btnReject) btnReject.addEventListener('click', endCall);
}

function sendRTCSignal(targetId, signal) {
  api('/rtc/signal', { method: 'POST', body: { targetId, signal } }).catch(e => { console.error('Signal error', e); toast('Call signal failed: '+(e.message||''),'error'); });
}

async function startCall(video) {
  if (!State.currentRoom || State.currentRoom.kind !== 'dm' || !State.currentRoom.target) return;
  isVideoCall = video;
  rtcCurrentPeer = State.currentRoom.target.id;
  try {
    rtcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideoCall });
    $('#rtcLocalVideo').srcObject = rtcLocalStream;
  } catch (err) {
    toast('Camera/Microphone access denied. Tap the lock/site settings icon in Chrome and allow Camera + Microphone, then reload.', 'error');
    return;
  }
  showCallUI('Calling...', State.currentRoom.target);
  createPeerConnection();
  rtcLocalStream.getTracks().forEach(t => rtcPeerConnection.addTrack(t, rtcLocalStream));
  
  try {
    const offer = await rtcPeerConnection.createOffer();
    await rtcPeerConnection.setLocalDescription(offer);
    sendRTCSignal(rtcCurrentPeer, { type: 'offer', offer, video: isVideoCall });
    _armCallTimeout();
  } catch (err) {
    toast('Failed to start call', 'error');
    endCall();
  }
}

async function handleRTCSignal(data) {
  if (!data || !data.signal) return;
  const peerId = data.fromId;
  const signal = data.signal;
  const author = data.author;

  if (signal.type === 'offer') {
    const age = Date.now() - (data.createdAt || 0);
    if (data.createdAt && age > 20000) {
      console.warn('[RTC] Ignoring stale incoming offer (>20s old):', age);
      return;
    }
    if (window._handledRtcOffers && window._handledRtcOffers.has(data.id)) return;
    if (!window._handledRtcOffers) window._handledRtcOffers = new Set();
    if (data.id) window._handledRtcOffers.add(data.id);

    if (rtcPeerConnection) {
      // Busy
      sendRTCSignal(peerId, { type: 'busy' });
      return;
    }
    rtcCurrentPeer = peerId;
    isVideoCall = signal.video;
    showCallUI('Incoming Call...', author, true);
    // Store offer to use upon acceptance
    window._rtcPendingOffer = signal.offer;
  } else if (signal.type === 'answer') {
    if (rtcPeerConnection && rtcCurrentPeer === peerId) {
      rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
      $('#callStatusText').textContent = 'Connected';
      _disarmCallTimeout();
    }
  } else if (signal.type === 'candidate') {
    if (rtcPeerConnection && rtcCurrentPeer === peerId) {
      rtcPeerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(e => console.log(e));
    }
  } else if (signal.type === 'end' || signal.type === 'busy') {
    if (rtcCurrentPeer === peerId) {
      toast(signal.type === 'busy' ? 'User is busy' : 'Call ended', 'info');
      endCall(true);
    }
  }
}

async function acceptCall() {
  $('#rtcAcceptBtn').classList.add('hidden');
  $('#callStatusText').textContent = 'Connecting...';
  try {
    rtcLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideoCall });
    $('#rtcLocalVideo').srcObject = rtcLocalStream;
  } catch (err) {
    toast('Camera/Microphone access denied. Tap the lock/site settings icon in Chrome and allow Camera + Microphone, then reload.', 'error');
    endCall();
    return;
  }
  createPeerConnection();
  rtcLocalStream.getTracks().forEach(t => rtcPeerConnection.addTrack(t, rtcLocalStream));
  
  try {
    await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(window._rtcPendingOffer));
    const answer = await rtcPeerConnection.createAnswer();
    await rtcPeerConnection.setLocalDescription(answer);
    sendRTCSignal(rtcCurrentPeer, { type: 'answer', answer });
    window._rtcPendingOffer = null;
  } catch(err) {
    endCall();
  }
}

function createPeerConnection() {
  rtcPeerConnection = new RTCPeerConnection(ICE_SERVERS);
  rtcRemoteStream = new MediaStream();
  $('#rtcRemoteVideo').srcObject = rtcRemoteStream;
  
  rtcPeerConnection.onicecandidate = (e) => {
    if (e.candidate && rtcCurrentPeer) {
      sendRTCSignal(rtcCurrentPeer, { type: 'candidate', candidate: e.candidate });
    }
  };
  rtcPeerConnection.ontrack = (e) => {
    e.streams[0].getTracks().forEach(track => rtcRemoteStream.addTrack(track));
    $('#callVideos').classList.remove('hidden');
    $('#callStatusText').textContent = '';
  };
  rtcPeerConnection.oniceconnectionstatechange = () => {
    const st = rtcPeerConnection.iceConnectionState;
    if (st === 'failed') {
      toast('Call failed to connect (network/NAT issue). Try again or switch networks.', 'error');
      endCall(true);
    } else if (st === 'disconnected') {
      // Give a brief grace period — mobile networks often flicker to
      // "disconnected" for a second before recovering on their own.
      setTimeout(() => {
        if (rtcPeerConnection && rtcPeerConnection.iceConnectionState === 'disconnected') {
          toast('Call connection lost.', 'error');
          endCall(true);
        }
      }, 6000);
    }
  };
}

// If a call never connects (peer offline, signal never arrives via the 2.5s
// poll cycle, restrictive network, etc.) give the caller clear feedback
// instead of leaving the "Calling..." UI hanging indefinitely.
let _rtcConnectTimeout = null;
function _armCallTimeout() {
  clearTimeout(_rtcConnectTimeout);
  _rtcConnectTimeout = setTimeout(() => {
    if (rtcPeerConnection && rtcPeerConnection.iceConnectionState !== 'connected' && rtcPeerConnection.iceConnectionState !== 'completed') {
      toast('No answer / call could not connect. They may be offline.', 'error');
      endCall();
    }
  }, 30000);
}
function _disarmCallTimeout() { clearTimeout(_rtcConnectTimeout); _rtcConnectTimeout = null; }


function showCallUI(status, user, incoming = false) {
  $('#callStatusText').textContent = status;
  $('#callName').textContent = user.displayName || user.username || 'User';
  $('#callVideos').classList.add('hidden');
  $('#callOverlay').classList.remove('hidden');
  if (incoming) $('#rtcAcceptBtn').classList.remove('hidden');
  else $('#rtcAcceptBtn').classList.add('hidden');
}

function endCall(remote = false) {
  _disarmCallTimeout();
  if (rtcPeerConnection) {
    rtcPeerConnection.close();
    rtcPeerConnection = null;
  }
  if (rtcLocalStream) {
    rtcLocalStream.getTracks().forEach(t => t.stop());
    rtcLocalStream = null;
  }
  if (!remote && rtcCurrentPeer) {
    sendRTCSignal(rtcCurrentPeer, { type: 'end' });
  }
  rtcCurrentPeer = null;
  $('#callOverlay').classList.add('hidden');
  $('#rtcLocalVideo').srcObject = null;
  $('#rtcRemoteVideo').srcObject = null;
}

})();
