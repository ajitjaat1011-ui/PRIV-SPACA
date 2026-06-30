/**
 * PRIV SPACA — Frontend Application
 * Vanilla JS, fully modular, JWT in localStorage, fetch() to /api.
 */
(() => {
'use strict';

// ====== State ======
const State = {
  token: localStorage.getItem('ps_token') || null,
  user: JSON.parse(localStorage.getItem('ps_user') || 'null'),
  currentTab: 'chat',
  currentRoom: { id: 'general-group', kind: 'group', label: '#general-group' },
  members: [],
  messages: [],
  posts: [],
  scheduled: [],
  typingUsers: [], // [{id, displayName}]
  replyTo: null,    // {id, text, username, imageUrl}
  attach: null,     // {url, name}
  postAttach: null, // {url, name}
  pollTimers: {},
};

const API_BASE = '/api';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ====== Helpers ======
function authHeaders(){
  return State.token ? { 'Authorization': 'Bearer ' + State.token } : {};
}
async function api(path, options = {}){
  const opts = Object.assign({ method:'GET', headers:{} }, options);
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
    if (res.status === 401 && State.token) {
      // expired/invalid token -> logout
      logout(true);
    }
    const msg = (data && data.error) || ('Request failed (' + res.status + ')');
    const err = new Error(msg); err.status = res.status; err.data = data; throw err;
  }
  return data;
}

function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function initialsOf(name){
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}

function colorOf(seed){
  if (!seed) return '#00a2ff';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function renderAvatar(el, user, opts = {}){
  if (!el) return;
  el.textContent = '';
  el.style.backgroundImage = '';
  el.classList.toggle('with-status', !!opts.showStatus);
  el.classList.toggle('online', !!opts.online);
  if (user && user.photoUrl) {
    el.style.backgroundImage = `url("${user.photoUrl.replace(/"/g,'%22')}")`;
  } else {
    const seed = user ? (user.username || user.displayName || user.id || '?') : '?';
    el.style.background = `linear-gradient(135deg, ${colorOf(seed)}, ${colorOf(seed + 'x')})`;
    el.textContent = initialsOf(user ? (user.displayName || user.username) : '?');
  }
}

function timeFmt(ts){
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toast(msg, kind = ''){
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  // re-trigger animation
  void t.offsetWidth;
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => { t.classList.add('hidden'); }, 3500);
}

function refreshIcons(){
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try { window.lucide.createIcons(); } catch (_){}
  }
}

// ====== Image upload (multi-provider with fallbacks) ======
/**
 * Free image upload via tmpfiles.org primarily. Returns hosted URL.
 * onProgress: fn(percent 0-100).
 */
async function uploadImage(file, onProgress){
  if (!file) throw new Error('No file');
  if (file.size > 15 * 1024 * 1024) throw new Error('File too large (max 15MB)');
  // Use XHR to support progress events.
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://tmpfiles.org/api/v1/upload', true);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded/e.total)*100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          let url = data && data.data && data.data.url;
          if (!url) return reject(new Error('Upload failed'));
          // tmpfiles "viewer" URL — convert to direct download path
          url = url.replace('://tmpfiles.org/', '://tmpfiles.org/dl/');
          if (onProgress) onProgress(100);
          resolve({ url, name: file.name, size: file.size });
        } catch (e) { reject(new Error('Upload parse failed')); }
      } else reject(new Error('Upload HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.ontimeout = () => reject(new Error('Upload timeout'));
    xhr.timeout = 60000;
    xhr.send(form);
  });
}

// ====== Auth UI ======
function showAuth(){
  $('#authShell').classList.remove('hidden');
  $('#appShell').classList.add('hidden');
}
function showApp(){
  $('#authShell').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  // Refresh icons newly visible
  refreshIcons();
  hydrateMeChips();
  switchTab('chat');
  startPolls();
  loadAll();
}

function hydrateMeChips(){
  if (!State.user) return;
  $('#meName').textContent = State.user.displayName || State.user.username;
  renderAvatar($('#meAvatar'), State.user);
  if ($('#feedMeName')) $('#feedMeName').textContent = State.user.displayName || State.user.username;
  if ($('#feedMeAvatar')) renderAvatar($('#feedMeAvatar'), State.user, { showStatus:false });
  if ($('#profileAvatarPreview')) renderAvatar($('#profileAvatarPreview'), State.user);
  // populate profile form
  const pf = $('#profileForm');
  if (pf) {
    pf.displayName.value = State.user.displayName || '';
    pf.username.value = State.user.username || '';
    pf.bio.value = State.user.bio || '';
  }
}

function logout(silent){
  Object.values(State.pollTimers).forEach(t => clearInterval(t));
  State.pollTimers = {};
  State.token = null;
  State.user = null;
  localStorage.removeItem('ps_token');
  localStorage.removeItem('ps_user');
  showAuth();
  if (!silent) toast('Signed out');
}

// ====== Auth Forms ======
function bindAuth(){
  $$('.auth-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.authTab;
      $$('.auth-tab').forEach(b => b.classList.toggle('active', b === btn));
      $$('.auth-form').forEach(f => f.classList.remove('active'));
      const map = { login:'#loginForm', signup:'#signupForm', reset:'#resetForm' };
      $(map[tab]).classList.add('active');
    });
  });

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = e.target.querySelector('[data-error]');
    errEl.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const data = await api('/auth/login', { method:'POST', body:{
        identifier: String(fd.get('identifier')||'').trim(),
        password: String(fd.get('password')||''),
      }});
      acceptSession(data);
    } catch (err) { errEl.textContent = err.message || 'Login failed'; }
    finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  });

  $('#signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = e.target.querySelector('[data-error]');
    errEl.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const data = await api('/auth/signup', { method:'POST', body:{
        email: String(fd.get('email')||'').trim(),
        username: String(fd.get('username')||'').trim(),
        displayName: String(fd.get('displayName')||'').trim(),
        password: String(fd.get('password')||''),
        pin: String(fd.get('pin')||''),
      }});
      acceptSession(data);
    } catch (err) { errEl.textContent = err.message || 'Signup failed'; }
    finally { btn.disabled = false; btn.textContent = 'Create account'; }
  });

  $('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errEl = e.target.querySelector('[data-error]');
    errEl.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = 'Resetting…';
    try {
      await api('/auth/reset-by-pin', { method:'POST', body:{
        identifier: String(fd.get('identifier')||'').trim(),
        pin: String(fd.get('pin')||''),
        newPassword: String(fd.get('newPassword')||''),
      }});
      errEl.style.color = 'var(--green)';
      errEl.textContent = 'Password reset. Please sign in.';
      // switch to login tab after a moment
      setTimeout(() => {
        errEl.style.color = '';
        $('[data-auth-tab="login"]').click();
        $('#loginForm input[name=identifier]').value = String(fd.get('identifier')||'').trim();
      }, 1200);
    } catch (err) { errEl.textContent = err.message || 'Reset failed'; }
    finally { btn.disabled = false; btn.textContent = 'Reset password'; }
  });
}

function acceptSession(data){
  State.token = data.token;
  State.user = data.user;
  localStorage.setItem('ps_token', State.token);
  localStorage.setItem('ps_user', JSON.stringify(State.user));
  showApp();
  toast('Welcome, ' + (State.user.displayName || State.user.username) + '!', 'success');
}

// ====== Tabs ======
function bindTabs(){
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#logoutBtn').addEventListener('click', () => logout(false));
}

function switchTab(tab){
  State.currentTab = tab;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.remove('active'));
  if (tab === 'chat') $('#chatView').classList.add('active');
  if (tab === 'feed'){ $('#feedView').classList.add('active'); loadPosts(); }
  if (tab === 'profile') $('#profileView').classList.add('active');
  refreshIcons();
}

// ====== Members & Rooms ======
async function loadMembers(){
  try {
    const data = await api('/users');
    State.members = data.users || [];
    renderMembers();
  } catch (_){}
}

function renderMembers(){
  const list = $('#membersList');
  if (!list) return;
  const others = State.members.filter(u => u.id !== (State.user && State.user.id));
  const me = State.members.find(u => u.id === (State.user && State.user.id));
  $('#memberCount').textContent = String(State.members.length);
  const ordered = me ? [me, ...others] : others;
  list.innerHTML = '';
  ordered.forEach(u => {
    const li = document.createElement('li');
    li.className = 'member-item';
    if (State.currentRoom.kind === 'dm' && State.currentRoom.targetId === u.id) li.classList.add('active');
    const isMe = u.id === (State.user && State.user.id);
    const avatar = document.createElement('span');
    avatar.className = 'avatar sm';
    renderAvatar(avatar, u, { showStatus:true, online: !!u.online || isMe });
    const meta = document.createElement('div');
    meta.className = 'meta';
    const isTyping = !isMe && State.typingUsers.some(t => t.id === u.id);
    meta.innerHTML = `
      <span class="nm">${escapeHtml(u.displayName)}${isMe ? ' <span class="muted small">(you)</span>' : ''}</span>
      <span class="${isTyping ? 'member-typing' : 'un'}">${isTyping ? 'typing…' : '@' + escapeHtml(u.username)}</span>
    `;
    li.appendChild(avatar); li.appendChild(meta);
    if (!isMe) {
      li.addEventListener('click', () => openDM(u));
    } else {
      li.style.cursor = 'default';
    }
    list.appendChild(li);
  });
}

function openDM(user){
  State.currentRoom = {
    id: dmRoomId(State.user.id, user.id),
    kind: 'dm',
    targetId: user.id,
    label: '@' + user.username
  };
  $('#chatTitle').textContent = '@' + user.username;
  $('#chatSubtitle').textContent = 'Private conversation with ' + (user.displayName || user.username);
  $$('#roomsList .room-item').forEach(r => r.classList.remove('active'));
  renderMembers();
  loadMessages(true);
}
function dmRoomId(a, b){
  return 'dm:' + [a, b].sort().join(':');
}

function bindRooms(){
  $$('#roomsList .room-item').forEach(r => {
    r.addEventListener('click', () => {
      const id = r.dataset.room;
      State.currentRoom = { id, kind:'group', label:'#'+id };
      $$('#roomsList .room-item').forEach(x => x.classList.toggle('active', x === r));
      $('#chatTitle').textContent = '#' + id;
      $('#chatSubtitle').textContent = 'The main lounge for everyone in PRIV SPACA.';
      renderMembers();
      loadMessages(true);
    });
  });
}

// ====== Messages ======
let lastMessagesScrollAtBottom = true;
async function loadMessages(scrollEnd){
  try {
    const data = await api('/messages?roomId=' + encodeURIComponent(State.currentRoom.id));
    State.messages = data.messages || [];
    renderMessages(scrollEnd);
  } catch (e){
    if (e.status !== 401) console.warn('loadMessages', e.message);
  }
}

function renderMessages(forceScroll){
  const list = $('#messagesList');
  const scroller = $('#messagesScroll');
  const wasAtBottom = lastMessagesScrollAtBottom;
  list.innerHTML = '';
  if (State.messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted small';
    empty.style.textAlign = 'center';
    empty.style.padding = '40px 10px';
    empty.textContent = 'No messages yet. Be the first to say hi 👋';
    list.appendChild(empty);
  }
  State.messages.forEach(m => list.appendChild(renderMessage(m)));
  refreshIcons();
  if (forceScroll || wasAtBottom) {
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
    $('#scrollBottomBtn').classList.add('hidden');
  }
}

function renderMessage(m){
  const row = document.createElement('div');
  row.className = 'message';
  if (m.scheduledOriginally) row.classList.add('scheduled-tag');
  row.dataset.id = m.id;

  const av = document.createElement('span');
  av.className = 'avatar sm';
  renderAvatar(av, m.author);

  const body = document.createElement('div');
  body.className = 'body';

  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `<span class="author">${escapeHtml(m.author && m.author.displayName || 'Unknown')}</span><span class="time">${escapeHtml(timeFmt(m.createdAt))}</span>`;
  body.appendChild(head);

  if (m.replyTo) {
    const q = document.createElement('div');
    q.className = 'reply-quote';
    const previewText = m.replyTo.text ? m.replyTo.text : (m.replyTo.imageUrl ? '📷 Photo' : '…');
    q.innerHTML = `<strong>@${escapeHtml(m.replyTo.username || 'user')}</strong>${escapeHtml(previewText.slice(0,140))}`;
    q.addEventListener('click', () => {
      const el = $('#messagesList .message[data-id="' + m.replyTo.id + '"]');
      if (el) { el.scrollIntoView({ behavior:'smooth', block:'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => el.style.outline = '', 1200); }
    });
    body.appendChild(q);
  }

  if (m.text) {
    const t = document.createElement('div');
    t.className = 'text';
    t.textContent = m.text;
    body.appendChild(t);
  }
  if (m.imageUrl) {
    const img = document.createElement('img');
    img.className = 'img-attach';
    img.src = m.imageUrl;
    img.alt = 'attachment';
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(m.imageUrl, m.author && m.author.displayName));
    img.addEventListener('error', () => { img.alt = 'Image failed to load'; img.style.display='none'; });
    body.appendChild(img);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const replyBtn = document.createElement('button');
  replyBtn.className = 'ghost-btn'; replyBtn.title = 'Reply';
  replyBtn.innerHTML = '<i data-lucide="corner-up-left"></i>';
  replyBtn.addEventListener('click', () => setReplyTo(m));
  actions.appendChild(replyBtn);
  if (m.userId === (State.user && State.user.id)) {
    const delBtn = document.createElement('button');
    delBtn.className = 'ghost-btn'; delBtn.title = 'Delete';
    delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this message?')) return;
      try { await api('/messages/delete', { method:'POST', body:{ messageId: m.id }}); loadMessages(false); }
      catch (e){ toast(e.message || 'Delete failed', 'error'); }
    });
    actions.appendChild(delBtn);
  }
  body.appendChild(actions);

  row.appendChild(av);
  row.appendChild(body);
  return row;
}

function setReplyTo(m){
  State.replyTo = {
    id: m.id,
    text: m.text || (m.imageUrl ? '📷 Photo' : ''),
    username: m.author && m.author.username || 'user',
    imageUrl: m.imageUrl || null
  };
  $('#replyToName').textContent = '@' + State.replyTo.username;
  $('#replyToText').textContent = State.replyTo.text;
  $('#replyBanner').classList.remove('hidden');
  $('#composerInput').focus();
  refreshIcons();
}

function clearReply(){
  State.replyTo = null;
  $('#replyBanner').classList.add('hidden');
}

// ====== Composer ======
function bindComposer(){
  const input = $('#composerInput');
  const form = $('#composer');

  input.addEventListener('input', () => {
    // auto-grow
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    // typing notify (debounced)
    if (input._typeTm) clearTimeout(input._typeTm);
    input._typeTm = setTimeout(() => sendTyping(), 200);
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
    clearAttach();
    clearReply();
    try {
      const data = await api('/messages/send', { method:'POST', body: payload });
      // Optimistic: append immediately
      State.messages.push(data.message);
      renderMessages(true);
    } catch (err) {
      toast(err.message || 'Send failed', 'error');
      // restore
      input.value = text;
      State.attach = sentAttach;
      if (sentAttach) showAttachPreview(sentAttach);
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

  // Scroll detection
  const scroller = $('#messagesScroll');
  scroller.addEventListener('scroll', () => {
    const atBottom = (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) < 40;
    lastMessagesScrollAtBottom = atBottom;
    $('#scrollBottomBtn').classList.toggle('hidden', atBottom);
  });
  $('#scrollBottomBtn').addEventListener('click', () => {
    scroller.scrollTop = scroller.scrollHeight;
  });
}

async function handleAttach(file){
  if (!file.type.startsWith('image/')) { toast('Only image files', 'error'); return; }
  if (file.size > 15 * 1024 * 1024) { toast('Max 15MB', 'error'); return; }
  // Show local preview immediately
  const localUrl = URL.createObjectURL(file);
  $('#attachThumb').src = localUrl;
  $('#attachName').textContent = file.name + ' · uploading…';
  $('#attachProgress').style.width = '0%';
  $('#attachPreview').classList.remove('hidden');
  try {
    const res = await uploadImage(file, (p) => {
      $('#attachProgress').style.width = p + '%';
    });
    State.attach = { url: res.url, name: res.name, size: res.size };
    $('#attachName').textContent = file.name + ' · ready';
    $('#attachProgress').style.width = '100%';
    refreshIcons();
  } catch (err) {
    toast('Upload failed: ' + (err.message || ''), 'error');
    clearAttach();
  }
}

function showAttachPreview(att){
  $('#attachThumb').src = att.url;
  $('#attachName').textContent = (att.name || 'image') + ' · ready';
  $('#attachProgress').style.width = '100%';
  $('#attachPreview').classList.remove('hidden');
}

function clearAttach(){
  State.attach = null;
  $('#attachPreview').classList.add('hidden');
  $('#attachThumb').src = '';
  $('#attachName').textContent = '';
  $('#attachProgress').style.width = '0%';
}

// ====== Typing & Heartbeat ======
let lastTypingSent = 0;
async function sendTyping(){
  const now = Date.now();
  if (now - lastTypingSent < 2000) return; // 2s debounce
  lastTypingSent = now;
  try { await api('/user/typing', { method:'POST', body:{ roomId: State.currentRoom.id } }); } catch (_){}
}

async function pollTyping(){
  try {
    const data = await api('/user/typing?roomId=' + encodeURIComponent(State.currentRoom.id));
    State.typingUsers = data.typing || [];
    const el = $('#typingIndicator');
    if (State.typingUsers.length === 0) {
      el.classList.add('hidden');
    } else {
      const names = State.typingUsers.map(u => u.displayName || ('@'+u.username)).join(', ');
      $('#typingText').textContent = names + (State.typingUsers.length === 1 ? ' is typing' : ' are typing');
      el.classList.remove('hidden');
    }
    renderMembers();
  } catch (_){}
}

async function sendHeartbeat(){
  try { await api('/user/heartbeat', { method:'POST' }); } catch (_){}
}

function startPolls(){
  // Initial calls
  sendHeartbeat();
  loadMembers();
  pollTyping();
  // Heartbeat every 20s
  State.pollTimers.hb = setInterval(sendHeartbeat, 20000);
  // Members refresh every 15s
  State.pollTimers.members = setInterval(loadMembers, 15000);
  // Messages every 3s
  State.pollTimers.msg = setInterval(() => {
    if (State.currentTab === 'chat') loadMessages(false);
  }, 3000);
  // Typing every 2s
  State.pollTimers.typing = setInterval(() => {
    if (State.currentTab === 'chat') pollTyping();
  }, 2000);
  // Feed refresh every 10s
  State.pollTimers.feed = setInterval(() => {
    if (State.currentTab === 'feed') loadPosts();
  }, 10000);
}

// ====== Feed ======
async function loadPosts(){
  try {
    const data = await api('/posts');
    State.posts = data.posts || [];
    renderPosts();
  } catch (_){}
}

function renderPosts(){
  const list = $('#feedList');
  list.innerHTML = '';
  if (State.posts.length === 0) {
    const e = document.createElement('div');
    e.className = 'muted small';
    e.style.textAlign='center'; e.style.padding='30px';
    e.textContent = 'No posts yet. Share something with the community!';
    list.appendChild(e);
  }
  State.posts.forEach(p => list.appendChild(renderPost(p)));
  refreshIcons();
}

function renderPost(p){
  const card = document.createElement('div');
  card.className = 'post-card';
  card.dataset.id = p.id;

  const head = document.createElement('div');
  head.className = 'post-head';
  const av = document.createElement('span');
  av.className = 'avatar md';
  renderAvatar(av, p.author);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<div class="nm">${escapeHtml(p.author.displayName)}</div><div class="un">@${escapeHtml(p.author.username)} · ${escapeHtml(timeFmt(p.createdAt))}</div>`;
  head.appendChild(av); head.appendChild(meta);
  if (p.userId === (State.user && State.user.id)){
    const del = document.createElement('button');
    del.className = 'ghost-btn';
    del.innerHTML = '<i data-lucide="trash-2"></i>';
    del.title = 'Delete post';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this post?')) return;
      try { await api('/posts/delete', { method:'POST', body:{ postId: p.id } }); loadPosts(); }
      catch (e){ toast(e.message || 'Delete failed', 'error'); }
    });
    head.appendChild(del);
  }
  card.appendChild(head);

  if (p.text){
    const body = document.createElement('div');
    body.className = 'post-body';
    body.textContent = p.text;
    card.appendChild(body);
  }
  if (p.imageUrl){
    const img = document.createElement('img');
    img.className = 'post-img'; img.src = p.imageUrl; img.alt = 'post image'; img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(p.imageUrl, p.author.displayName));
    img.addEventListener('error', () => { img.style.display='none'; });
    card.appendChild(img);
  }

  const actions = document.createElement('div');
  actions.className = 'post-actions';
  const likeBtn = document.createElement('button');
  likeBtn.className = 'ghost-btn like-btn';
  const liked = Array.isArray(p.likes) && p.likes.includes(State.user && State.user.id);
  if (liked) likeBtn.classList.add('liked');
  likeBtn.innerHTML = `<i data-lucide="heart"></i> <span>${p.likeCount || 0}</span>`;
  likeBtn.addEventListener('click', async () => {
    try {
      const data = await api('/posts/like', { method:'POST', body:{ postId: p.id }});
      p.likes = p.likes || [];
      if (data.liked && !p.likes.includes(State.user.id)) p.likes.push(State.user.id);
      if (!data.liked) p.likes = p.likes.filter(x => x !== State.user.id);
      p.likeCount = data.likeCount;
      renderPosts();
    } catch (e){ toast(e.message || 'Failed', 'error'); }
  });
  const commentBtn = document.createElement('button');
  commentBtn.className = 'ghost-btn';
  commentBtn.innerHTML = `<i data-lucide="message-circle"></i> <span>${p.commentCount || 0}</span>`;
  commentBtn.addEventListener('click', () => {
    const cl = card.querySelector('.comments-list');
    if (cl) cl.scrollIntoView({ behavior:'smooth', block:'nearest' });
    const inp = card.querySelector('.comment-add input');
    if (inp) inp.focus();
  });
  actions.appendChild(likeBtn); actions.appendChild(commentBtn);
  card.appendChild(actions);

  // Comments
  const cl = document.createElement('div');
  cl.className = 'comments-list';
  (p.comments || []).forEach(c => {
    const ci = document.createElement('div');
    ci.className = 'comment-item';
    const a = document.createElement('span');
    a.className = 'avatar sm';
    renderAvatar(a, c.author);
    const b = document.createElement('div');
    b.className = 'body';
    b.innerHTML = `<div class="head">${escapeHtml(c.author.displayName)}<span>${escapeHtml(timeFmt(c.createdAt))}</span></div><div class="text"></div>`;
    b.querySelector('.text').textContent = c.text;
    ci.appendChild(a); ci.appendChild(b);
    cl.appendChild(ci);
  });
  card.appendChild(cl);

  // Add comment
  const addRow = document.createElement('div');
  addRow.className = 'comment-add';
  addRow.innerHTML = `<input type="text" placeholder="Write a comment…" maxlength="600" /><button class="primary-btn sm">Send</button>`;
  const inp = addRow.querySelector('input'); const sb = addRow.querySelector('button');
  const submit = async () => {
    const t = inp.value.trim();
    if (!t) return;
    sb.disabled = true;
    try {
      await api('/posts/comment', { method:'POST', body:{ postId: p.id, text: t }});
      inp.value = '';
      loadPosts();
    } catch (e){ toast(e.message || 'Failed', 'error'); }
    finally { sb.disabled = false; }
  };
  sb.addEventListener('click', submit);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); submit(); }});
  card.appendChild(addRow);

  return card;
}

function bindFeedComposer(){
  $('#postAttachBtn').addEventListener('click', () => $('#postFileInput').click());
  $('#postFileInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')){ toast('Only images','error'); return; }
    if (f.size > 15*1024*1024){ toast('Max 15MB','error'); return; }
    const localUrl = URL.createObjectURL(f);
    $('#postAttachThumb').src = localUrl;
    $('#postAttachName').textContent = f.name + ' · uploading…';
    $('#postAttachProgress').style.width = '0%';
    $('#postAttachPreview').classList.remove('hidden');
    try {
      const res = await uploadImage(f, (p) => $('#postAttachProgress').style.width = p + '%');
      State.postAttach = { url: res.url, name: res.name };
      $('#postAttachName').textContent = f.name + ' · ready';
      $('#postAttachProgress').style.width = '100%';
      refreshIcons();
    } catch (err) { toast('Upload failed: '+(err.message||''),'error'); clearPostAttach(); }
  });
  $('#postCancelAttachBtn').addEventListener('click', clearPostAttach);
  $('#postSubmitBtn').addEventListener('click', async () => {
    const text = $('#postInput').value.trim();
    if (!text && !State.postAttach) { toast('Write something or attach a photo','error'); return; }
    const btn = $('#postSubmitBtn');
    btn.disabled = true;
    try {
      await api('/posts/create', { method:'POST', body:{ text, imageUrl: State.postAttach ? State.postAttach.url : null }});
      $('#postInput').value = '';
      clearPostAttach();
      loadPosts();
      toast('Posted!','success');
    } catch (e){ toast(e.message || 'Post failed', 'error'); }
    finally { btn.disabled = false; }
  });
}

function clearPostAttach(){
  State.postAttach = null;
  $('#postAttachPreview').classList.add('hidden');
  $('#postAttachThumb').src = '';
  $('#postAttachName').textContent = '';
  $('#postAttachProgress').style.width = '0%';
}

// ====== Profile ======
function bindProfile(){
  $('#profilePhotoBtn').addEventListener('click', () => $('#profilePhotoInput').click());
  $('#profilePhotoInput').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')){ toast('Only images','error'); return; }
    if (f.size > 15*1024*1024){ toast('Max 15MB','error'); return; }
    const status = $('#profilePhotoStatus');
    status.textContent = 'Uploading 0%';
    try {
      const res = await uploadImage(f, (p) => { status.textContent = 'Uploading ' + p + '%'; });
      const data = await api('/user/update', { method:'POST', body:{ photoUrl: res.url }});
      State.user = data.user;
      localStorage.setItem('ps_user', JSON.stringify(State.user));
      hydrateMeChips();
      status.textContent = 'Photo updated ✓';
      toast('Profile photo updated','success');
    } catch (err) { status.textContent = ''; toast('Upload failed: '+(err.message||''),'error'); }
  });

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const status = $('#profileStatus');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    status.textContent = '';
    try {
      const data = await api('/user/update', { method:'POST', body:{
        displayName: String(fd.get('displayName')||'').trim(),
        username: String(fd.get('username')||'').trim(),
        bio: String(fd.get('bio')||'').trim()
      }});
      State.user = data.user;
      localStorage.setItem('ps_user', JSON.stringify(State.user));
      hydrateMeChips();
      status.textContent = 'Saved ✓';
      toast('Profile updated','success');
    } catch (err) { status.textContent = ''; toast(err.message || 'Update failed','error'); }
    finally { btn.disabled = false; }
  });
}

// ====== Schedule ======
function bindSchedule(){
  $('#scheduleBtn').addEventListener('click', openSchedule);
  $('#scheduleOpenBtn').addEventListener('click', openSchedule);
  $$('[data-close-modal]').forEach(b => b.addEventListener('click', () => {
    $('#scheduleModal').classList.add('hidden');
  }));
  $('#scheduleModal').addEventListener('click', (e) => {
    if (e.target.id === 'scheduleModal') $('#scheduleModal').classList.add('hidden');
  });
  $('#scheduleSubmit').addEventListener('click', async () => {
    const text = $('#scheduleText').value.trim();
    const when = $('#scheduleAt').value;
    const err = $('#scheduleError');
    err.textContent = '';
    if (!text){ err.textContent = 'Message required'; return; }
    if (!when){ err.textContent = 'Pick a date/time'; return; }
    const ts = new Date(when).getTime();
    if (!ts || ts < Date.now() + 5000){ err.textContent = 'Must be at least 5s in future'; return; }
    try {
      await api('/messages/schedule', { method:'POST', body:{
        roomId: State.currentRoom.id, text, deliverAt: ts
      }});
      $('#scheduleText').value = ''; $('#scheduleAt').value = '';
      toast('Scheduled','success');
      loadScheduled();
    } catch (e){ err.textContent = e.message || 'Failed'; }
  });
}
function openSchedule(){
  $('#scheduleModal').classList.remove('hidden');
  refreshIcons();
  // default to +1 hour
  const d = new Date(Date.now() + 60*60*1000);
  const pad = n => String(n).padStart(2,'0');
  $('#scheduleAt').value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  loadScheduled();
}
async function loadScheduled(){
  const list = $('#scheduleList');
  list.innerHTML = '<li class="muted small">Loading…</li>';
  try {
    const data = await api('/messages/scheduled');
    State.scheduled = data.scheduled || [];
    if (State.scheduled.length === 0){ list.innerHTML = '<li class="muted small">No scheduled messages</li>'; return; }
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
        try { await api('/messages/scheduled/cancel', { method:'POST', body:{ id: s.id }}); loadScheduled(); }
        catch (e){ toast(e.message || 'Cancel failed', 'error'); }
      });
      li.appendChild(txt); li.appendChild(when); li.appendChild(del);
      list.appendChild(li);
    });
    refreshIcons();
  } catch (e){ list.innerHTML = '<li class="muted small">Error loading</li>'; }
}

// ====== Lightbox ======
function openLightbox(url, uploaderName){
  $('#lightboxImg').src = url;
  $('#lightboxUploader').textContent = uploaderName ? ('Shared by ' + uploaderName) : '';
  $('#lightboxDownload').href = url;
  $('#lightbox').classList.remove('hidden');
  refreshIcons();
}
function bindLightbox(){
  $('#lightboxClose').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape'){
      if (!$('#lightbox').classList.contains('hidden')) closeLightbox();
      if (!$('#scheduleModal').classList.contains('hidden')) $('#scheduleModal').classList.add('hidden');
    }
  });
}
function closeLightbox(){
  $('#lightbox').classList.add('hidden');
  $('#lightboxImg').src = '';
}

// ====== Initial load ======
async function loadAll(){
  await loadMembers();
  await loadMessages(true);
}

// ====== Boot ======
function boot(){
  $('#yr').textContent = String(new Date().getFullYear());
  bindAuth();
  bindTabs();
  bindRooms();
  bindComposer();
  bindFeedComposer();
  bindProfile();
  bindSchedule();
  bindLightbox();
  refreshIcons();

  if (State.token && State.user) {
    // Verify session
    api('/auth/me').then(d => {
      if (d && d.user){
        State.user = d.user;
        localStorage.setItem('ps_user', JSON.stringify(State.user));
        showApp();
      } else { showAuth(); }
    }).catch(() => showAuth());
  } else {
    showAuth();
  }
}

document.addEventListener('DOMContentLoaded', boot);
})();
