import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyRequest } from '../api/lib/omni-engine.js';
import { blockedHostname, safePublicUrl, parsePreview } from '../api/routes/link-preview.js';

const appSource = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../api/lib/store-turso.js', import.meta.url), 'utf8');

// Secure server-side preview parsing and SSRF boundaries.
for (const host of ['localhost', '127.0.0.1', '10.2.3.4', '172.16.2.3', '192.168.1.2', '::1', 'fc00::1', '169.254.169.254']) {
  assert.equal(blockedHostname(host), true, `must block ${host}`);
}
assert.equal(blockedHostname('example.com'), false);
assert.equal(safePublicUrl('file:///etc/passwd'), null);
assert.equal(safePublicUrl('https://127.0.0.1/admin'), null);
assert.equal(safePublicUrl('https://example.com/article#fragment').toString(), 'https://example.com/article');
const preview = parsePreview(`<!doctype html><head>
  <meta content="An &amp; Safe Title" property="og:title">
  <meta name="description" content="Compact description">
  <meta property="og:image" content="/cover.webp">
  <meta property="og:site_name" content="Example">
</head>`, 'https://example.com/post');
assert.deepEqual(preview, {
  url: 'https://example.com/post', title: 'An & Safe Title', description: 'Compact description',
  siteName: 'Example', imageUrl: 'https://example.com/cover.webp',
});

// Omni placement: chat/reactions remain critical, receipt work is shed-able,
// and scraping owns its separate bounded fault domain.
assert.deepEqual(classifyRequest('/api/messages/reaction', 'POST'), { tier: 0, name: 'critical', domain: 'chat' });
assert.deepEqual(classifyRequest('/api/messages/receipt', 'POST'), { tier: 2, name: 'background', domain: 'read-receipts' });
assert.deepEqual(classifyRequest('/api/link-preview', 'GET'), { tier: 1, name: 'standard', domain: 'scraping.preview' });

// Client acceptance contracts.
assert.match(appSource, /targetBytes:\s*400 \* 1024/);
assert.match(appSource, /Math\.min\(1080/);
assert.match(appSource, /image\/avif/);
assert.match(appSource, /State\.messages\.length <= 50/);
assert.match(appSource, /beforeTimestamp=/);
assert.match(appSource, /priv-spaca-runtime/);
assert.match(appSource, /setTimeout\(\(\) => \{ haptic\('confirm'\); openMessageActionMenu\(message, target\); \}, 400\)/);
assert.match(appSource, /scheduleVisibleMessageReceipts/);
assert.match(appSource, /\/link-preview\?url=/);
assert.match(style, /\.story-prev,\.story-next\{width:30%/s);
assert.match(sw, /roomId: data\.roomId/);
assert.match(sw, /data\.avatar/);

// Storage contracts: cursor index, accelerated counters and narrow state tables.
assert.match(store, /idx_ps_messages_room_created ON ps_messages \(room_id, created_at DESC\)/);
assert.match(store, /CREATE TABLE IF NOT EXISTS ps_conversation_state/);
assert.match(store, /idx_ps_conversation_state_owner_message/);
assert.match(store, /CREATE TABLE IF NOT EXISTS ps_message_reactions/);
assert.match(store, /CREATE TABLE IF NOT EXISTS ps_message_receipts/);
assert.match(store, /unread-materialized:/);

// In-memory API integration: two full cursor pages, reaction persistence,
// visibility receipt acceptance and persisted inbox controls.
const [{ default: api }, { cfg }, { state }, { signToken }] = await Promise.all([
  import('../api/cf-worker.js'), import('../api/lib/config.js'), import('../api/lib/state.js'), import('../api/lib/auth.js'),
]);
const now = Date.now();
cfg.JWT_SECRET = 'v169-direct-test-secret';
const users = [
  { id: 'usr_a', email: 'a@example.com', username: 'alice169', displayName: 'Alice', passwordHash: 'x', pinHash: 'x', tokenVersion: 0, followers: [], following: [], blocked: [], createdAt: now },
  { id: 'usr_b', email: 'b@example.com', username: 'bob169', displayName: 'Bob', passwordHash: 'x', pinHash: 'x', tokenVersion: 0, followers: [], following: [], blocked: [], createdAt: now },
];
state.localCache = {
  users,
  messages: Array.from({ length: 65 }, (_, i) => ({ id: `msg_${i}`, roomId: 'general-group', userId: i % 2 ? 'usr_a' : 'usr_b', text: `page-${i}`, createdAt: now - 65000 + i * 1000 })),
  scheduledMessages: [], posts: [], notifications: [], typing: {}, heartbeat: {}, rtcSignals: [], meta: {},
};
state.cacheTimestamp = Date.now();
const token = await signToken(users[0]);
async function request(path, method = 'GET', body) {
  const response = await api.request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }, { JWT_SECRET: cfg.JWT_SECRET });
  const data = await response.json();
  assert.equal(response.ok, true, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
const page1 = await request('/messages?roomId=general-group&limit=30');
const page2 = await request(`/messages?roomId=general-group&limit=30&beforeTimestamp=${page1.nextCursor}`);
assert.equal(page1.messages.length, 30); assert.equal(page1.hasMore, true);
assert.equal(page2.messages.length, 30); assert.equal(page2.hasMore, true);
assert.equal((await request('/messages/reaction', 'POST', { messageId: 'msg_64', emoji: '🔥', active: true })).active, true);
assert.equal((await request('/messages/receipt', 'POST', { roomId: 'general-group', messageIds: ['msg_64'], state: 'read' })).count, 1);
assert.equal((await request('/user/conversation', 'POST', { peerId: 'usr_b', action: 'pin', value: true })).prefs.pinned, true);

console.log('✅ v169 performance/native interaction contracts passed');
