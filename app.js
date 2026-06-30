/**
 * PRIV SPACA — Frontend Application (Instagram-grade)
 * Vanilla JS, modular, JWT in localStorage, fetch() to /api.
 */
(() => {
'use strict';

// ====== State ======
const State = {
  token: localStorage.getItem('ps_token') || null,
  user: JSON.parse(localStorage.getItem('ps_user') || 'null'),
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
};

const API_BASE = '/api';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ====== API helper ======
function authHeaders() {
  return State.token ? { 'Authorization': 'Bearer ' + State.token } : {};
}
async function api(path, options = {}) {
  const opts = Object.assign({ method: 'GET', headers: {} }, options);
  opts.headers = Object.assign({}, opts.headers, authHeaders());
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  let res;
  try { res = await fetch(API_BASE + path, opts); }
  catch (e) { throw new Error('Network error'); }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    if (res.status === 401 && State.token && !path.startsWith('/auth/')) {
      logout(true);
    }
    const msg = (data && data.error) || ('Request failed (' + res.status + ')');
    const err = new Error(msg); err.status = res.status; err.data = data; throw err;
  }
  return data;
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
  void t.offsetWidth;
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => t.classList.add('hidden'), 3200);
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try { window.lucide.createIcons(); } catch (_) {}
  }
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
  $('#authShell').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
  hideSplash();
  refreshIcons();
}

function showApp() {
  $('#authShell').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  hideSplash();
  refreshIcons();
  hydrateMeChips();
  switchTab('feed');
  startPolls();
  loadAll();
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
  State.token = null;
  State.user = null;
  State.messages = [];
  State.members = [];
  State.posts = [];
  localStorage.removeItem('ps_token');
  localStorage.removeItem('ps_user');
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
      await api('/auth/reset-by-pin', { method: 'POST', body: {
        identifier: String(fd.get('identifier') || '').trim(),
        pin,
        newPassword: String(fd.get('newPassword') || ''),
      }});
      errEl.style.color = 'var(--green)';
      errEl.textContent = 'Password reset! Please sign in.';
      setTimeout(() => {
        errEl.style.color = ''; errEl.textContent = '';
        $('[data-auth-tab="login"]').click();
        $('#loginForm input[name=identifier]').value = String(fd.get('identifier') || '').trim();
        $('#loginForm input[name=password]').focus();
      }, 1300);
    } catch (err) { errEl.textContent = err.message || 'Reset failed'; }
    finally { btn.disabled = false; btn.innerHTML = orig; }
  });
}

function acceptSession(data) {
  State.token = data.token;
  State.user = data.user;
  localStorage.setItem('ps_token', State.token);
  localStorage.setItem('ps_user', JSON.stringify(State.user));
  // Clear PIN fields
  $$('.pin-input').forEach(clearPin);
  showApp();
  toast('Welcome, ' + (State.user.displayName || State.user.username) + '!', 'success');
}

// ====== Tabs ======
function bindTabs() {
  $$('.bn-btn[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  const lo = $('#bnLogoutBtn');
  if (lo) lo.addEventListener('click', () => { if (confirm('Sign out?')) logout(false); });
  const tc = $('#topChatBtn');
  if (tc) tc.addEventListener('click', () => switchTab('chat'));
  const tn = $('#topNotifBtn');
  if (tn) tn.addEventListener('click', () => toast('Notifications coming soon'));
}

function switchTab(tab) {
  State.currentTab = tab;
  $$('.bn-btn[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.remove('active'));
  if (tab === 'feed') { $('#feedView').classList.add('active'); loadMembers(); loadPosts(); }
  if (tab === 'search') { $('#searchView').classList.add('active'); loadMembers(); renderSearch(''); $('#searchInput').focus(); }
  if (tab === 'chat') $('#chatView').classList.add('active');
  if (tab === 'profile') $('#profileView').classList.add('active');
  refreshIcons();
}

// ====== Rooms & Members ======
async function loadMembers() {
  try {
    const data = await api('/users');
    State.members = data.users || [];
    renderMembers();
  } catch (_) {}
}

function renderMembers() {
  const list = $('#membersList');
  if (!list) return;
  const meId = State.user && State.user.id;
  const others = State.members.filter(u => u.id !== meId);
  const me = State.members.find(u => u.id === meId);
  $('#memberCount').textContent = String(State.members.length);
  const ordered = me ? [me, ...others] : others;
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
  renderMembers();
  loadMessages(true);
}

function dmRoomId(a, b) { return 'dm:' + [a, b].sort().join(':'); }

function bindRooms() {
  $$('#roomsList .room-item').forEach(r => {
    r.addEventListener('click', () => {
      const id = r.dataset.room;
      State.currentRoom = { id, kind: 'group', target: null, label: '#' + id };
      $$('#roomsList .room-item').forEach(x => x.classList.toggle('active', x === r));
      $('#chatTitle').textContent = '#' + id;
      $('#chatSubtitle').textContent = 'The main lounge for everyone in PRIV SPACA.';
      $('#chatAvatar').style.display = 'none';
      $('#chatView').classList.remove('show-rooms');
      renderMembers();
      loadMessages(true);
    });
  });
  const back = $('#backToRoomsBtn');
  if (back) back.addEventListener('click', () => $('#chatView').classList.toggle('show-rooms'));
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

function renderMessages(forceScroll) {
  const list = $('#messagesList');
  const scroller = $('#messagesScroll');
  const wasAtBottom = lastMessagesScrollAtBottom;
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
    list.appendChild(renderMessage(m, meId, grouped));
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
    wrap.appendChild(al);
  }

  const bubble = document.createElement('div');
  const isImageOnly = !!m.imageUrl && !m.text && !m.replyTo;
  bubble.className = 'bubble' + (isImageOnly ? ' image-only' : '');

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

  if (m.text) {
    const t = document.createElement('div');
    t.className = 'text';
    t.textContent = m.text;
    bubble.appendChild(t);
  }
  if (m.imageUrl) {
    const img = document.createElement('img');
    img.className = 'img-attach';
    img.src = m.imageUrl;
    img.alt = 'attachment';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(m.imageUrl, author.displayName));
    img.addEventListener('error', () => { img.alt = '(image)'; img.style.display = 'none'; });
    bubble.appendChild(img);
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
      if (!confirm('Delete this message?')) return;
      try {
        await api('/messages/delete', { method: 'POST', body: { messageId: m.id } });
        State.messages = State.messages.filter(x => x.id !== m.id);
        lastMessagesSignature = '';
        renderMessages(false);
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
    const payload = {
      roomId: State.currentRoom.id,
      text,
      imageUrl: State.attach ? State.attach.url : null,
      replyTo: State.replyTo
    };
    input.value = ''; input.style.height = 'auto';
    const sentAttach = State.attach;
    const sentReply = State.replyTo;
    clearAttach();
    clearReply();
    try {
      const data = await api('/messages/send', { method: 'POST', body: payload });
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

function startPolls() {
  sendHeartbeat();
  loadMembers();
  pollTyping();
  State.pollTimers.hb = setInterval(sendHeartbeat, 20000);
  State.pollTimers.members = setInterval(loadMembers, 15000);
  State.pollTimers.msg = setInterval(() => { if (State.currentTab === 'chat') loadMessages(false); }, 3000);
  State.pollTimers.typing = setInterval(() => { if (State.currentTab === 'chat') pollTyping(); }, 2500);
  State.pollTimers.feed = setInterval(() => { if (State.currentTab === 'feed') loadPosts(); }, 10000);
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
function renderStoriesRail() {
  const rail = $('#storiesRail');
  if (!rail) return;
  rail.innerHTML = '';
  if (!State.members || State.members.length === 0) {
    rail.style.display = 'none';
    return;
  }
  rail.style.display = '';
  const meId = State.user && State.user.id;
  const me = State.members.find(m => m.id === meId) || State.user;
  rail.appendChild(buildStoryCell(me, true));
  const others = State.members
    .filter(m => m.id !== meId)
    .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  others.forEach(m => rail.appendChild(buildStoryCell(m, false)));
}

function buildStoryCell(user, isMe) {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'story-cell' + (isMe ? ' me' : '');
  const ring = document.createElement('div');
  ring.className = 'story-ring' + (isMe ? ' is-me' : '');
  const inner = document.createElement('div');
  inner.className = 'avatar-inner';
  if (user && user.photoUrl) {
    inner.style.backgroundImage = `url("${String(user.photoUrl).replace(/"/g, '%22')}")`;
  } else {
    const seed = user ? (user.username || user.displayName || user.id || '?') : '?';
    inner.style.backgroundColor = colorOf(seed);
    inner.textContent = initialsOf(user ? (user.displayName || user.username) : '?');
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

function renderPosts() {
  renderStoriesRail();
  const list = $('#feedList');
  list.innerHTML = '';
  if (State.posts.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty-state';
    e.innerHTML = `
      <div class="icon"><i data-lucide="newspaper"></i></div>
      <div class="title">Nothing here yet</div>
      <div class="sub">Share the first post with the community!</div>
    `;
    list.appendChild(e);
  }
  State.posts.forEach(p => list.appendChild(renderPost(p)));
  refreshIcons();
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

  // Header
  const head = document.createElement('div');
  head.className = 'post-head';
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
  card.appendChild(head);

  // Image with double-tap to like
  if (p.imageUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'post-img-wrap';
    const img = document.createElement('img');
    img.className = 'post-img';
    img.src = p.imageUrl;
    img.alt = 'post image';
    img.loading = 'lazy';
    img.addEventListener('error', () => { wrap.style.display = 'none'; });
    const burst = document.createElement('div');
    burst.className = 'heart-burst';
    burst.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 21s-7-4.35-7-10a4.5 4.5 0 0 1 8-2.83A4.5 4.5 0 0 1 21 11c0 5.65-9 10-9 10z"/></svg>';
    let lastTap = 0;
    let tapTimer = null;
    img.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastTap < 300) {
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
        burst.classList.remove('show');
        void burst.offsetWidth;
        burst.classList.add('show');
        if (!Array.isArray(p.likes) || !p.likes.includes(meId)) {
          toggleLike(p, card);
        }
        lastTap = 0;
      } else {
        lastTap = now;
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { openLightbox(p.imageUrl, author.displayName); }, 290);
      }
    });
    wrap.appendChild(img);
    wrap.appendChild(burst);
    card.appendChild(wrap);
  }

  // Action toolbar
  const actions = document.createElement('div');
  actions.className = 'post-actions';
  const left = document.createElement('div'); left.className = 'action-grp';
  const right = document.createElement('div'); right.className = 'action-grp';

  const likeBtn = document.createElement('button');
  likeBtn.className = 'act-btn' + (liked ? ' liked' : '');
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
  const spacer = document.createElement('div'); spacer.className = 'spacer';
  right.appendChild(saveBtn);
  actions.appendChild(left); actions.appendChild(spacer); actions.appendChild(right);
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
      row.appendChild(document.createTextNode(c.text));
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
      lastPostsSignature = '';
      renderPosts();
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
  try {
    const data = await api('/posts/like', { method: 'POST', body: { postId: p.id } });
    p.likes = p.likes || [];
    if (data.liked && !p.likes.includes(meId)) p.likes.push(meId);
    if (!data.liked) p.likes = p.likes.filter(x => x !== meId);
    p.likeCount = data.likeCount;
    lastPostsSignature = '';
    renderPosts();
  } catch (e) { toast(e.message || 'Failed', 'error'); }
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
      if (!confirm('Delete this post?')) return;
      try { await api('/posts/delete', { method: 'POST', body: { postId: p.id } }); lastPostsSignature = ''; loadPosts(); toast('Post deleted'); }
      catch (e) { toast(e.message || 'Delete failed', 'error'); }
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
    txt.appendChild(document.createTextNode(c.text));
    const meta = document.createElement('div'); meta.className = 'meta-row';
    meta.innerHTML = `<span>${escapeHtml(timeAgo(c.createdAt))}</span><span>Reply</span>`;
    b.appendChild(txt); b.appendChild(meta);
    li.appendChild(a); li.appendChild(b);
    list.appendChild(li);
  });
  renderAvatar($('#commentsMeAvatar'), State.user);
  $('#commentsInput').value = '';
  $('#commentsSheet').classList.remove('hidden');
  refreshIcons();
  setTimeout(() => $('#commentsInput').focus(), 200);
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
      openCommentsSheet(activeCommentsPost);
      lastPostsSignature = '';
      renderPosts();
    } catch (e) { toast(e.message || 'Failed', 'error'); }
    finally { sb.disabled = false; }
  });
}

let storyTimer = null;
function openStoryFor(user) {
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
  refreshIcons();
  clearTimeout(storyTimer);
  storyTimer = setTimeout(closeStory, 5100);
}
function closeStory() {
  clearTimeout(storyTimer);
  storyTimer = null;
  $('#storyViewer').classList.add('hidden');
}
function bindStoryViewer() {
  $('#storyClose').addEventListener('click', closeStory);
  $('#storyPrev').addEventListener('click', closeStory);
  $('#storyNext').addEventListener('click', closeStory);
  $('#storyViewer').addEventListener('click', (e) => {
    if (e.target.id === 'storyViewer') closeStory();
  });
}


function bindFeedComposer() {
  $('#postAttachBtn').addEventListener('click', () => $('#postFileInput').click());
  $('#postFileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Only images', 'error'); return; }
    if (f.size > 15 * 1024 * 1024) { toast('Max 15MB', 'error'); return; }
    const localUrl = URL.createObjectURL(f);
    $('#postAttachThumb').src = localUrl;
    $('#postAttachName').textContent = f.name + ' · uploading…';
    $('#postAttachProgress').style.width = '0%';
    $('#postAttachPreview').classList.remove('hidden');
    try {
      // Use permanent GitHub-CDN upload (resize to 1200px max, JPEG 0.82)
      const res = await uploadPermanentImage(f, { kind: 'post', maxDim: 1200, quality: 0.82, onProgress: (p) => $('#postAttachProgress').style.width = p + '%' });
      State.postAttach = { url: res.url, name: f.name };
      $('#postAttachName').textContent = f.name + (res.persisted ? ' · ready (permanent)' : ' · ready (inline)');
      $('#postAttachProgress').style.width = '100%';
      refreshIcons();
    } catch (err) {
      // Final fallback to tmpfiles.org so the user is never stuck
      try {
        const res2 = await uploadImage(f, (p) => $('#postAttachProgress').style.width = p + '%');
        State.postAttach = { url: res2.url, name: res2.name };
        $('#postAttachName').textContent = f.name + ' · ready (temporary)';
        $('#postAttachProgress').style.width = '100%';
      } catch (err2) {
        toast('Upload failed: ' + (err2.message || err.message), 'error');
        clearPostAttach();
      }
    }
  });
  $('#postCancelAttachBtn').addEventListener('click', clearPostAttach);
  $('#postSubmitBtn').addEventListener('click', async () => {
    const text = $('#postInput').value.trim();
    if (!text && !State.postAttach) { toast('Write something or attach a photo', 'error'); return; }
    const btn = $('#postSubmitBtn');
    btn.disabled = true;
    try {
      await api('/posts/create', { method: 'POST', body: { text, imageUrl: State.postAttach ? State.postAttach.url : null } });
      $('#postInput').value = '';
      clearPostAttach();
      lastPostsSignature = '';
      loadPosts();
      toast('Posted!', 'success');
    } catch (e) { toast(e.message || 'Post failed', 'error'); }
    finally { btn.disabled = false; }
  });
}

function clearPostAttach() {
  State.postAttach = null;
  $('#postAttachPreview').classList.add('hidden');
  $('#postAttachThumb').src = '';
  $('#postAttachName').textContent = '';
  $('#postAttachProgress').style.width = '0%';
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
  $('#lightbox').classList.remove('hidden');
  refreshIcons();
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
    li.addEventListener('click', () => { openDM(u); switchTab('chat'); });
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
      if (!$('#commentsSheet').classList.contains('hidden')) closeCommentsSheet();
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

function boot() {
  $('#yr').textContent = String(new Date().getFullYear());
  bindAuth();
  bindTabs();
  bindRooms();
  bindComposer();
  bindFeedComposer();
  bindProfile();
  bindSchedule();
  bindLightbox();
  bindCommentsSheet();
  bindStoryViewer();
  bindSearch();
  refreshIcons();

  if (State.token && State.user) {
    api('/auth/me').then(d => {
      if (d && d.user) {
        State.user = d.user;
        localStorage.setItem('ps_user', JSON.stringify(State.user));
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
})();
