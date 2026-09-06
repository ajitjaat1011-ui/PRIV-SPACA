import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cfg } from '../api/lib/config.js';
import {
  SESSION_COOKIE, TOKEN_AUDIENCE, TOKEN_ISSUER,
  b64urlJson, hmacSha256, signToken, verifyToken,
  tokenFromRequest, setSessionCookie, clearSessionCookie,
  _authUserCache, _loginUserCache, _bcryptVerifyCache, invalidateUserAuthCaches,
} from '../api/lib/auth.js';
import {
  b64urlEncode, b64urlDecode, randomChallenge,
  decodeCbor, verifyRegistrationResponse, verifyAuthenticationResponse,
} from '../api/lib/webauthn.js';
import {
  encryptField, decryptField, isEncrypted,
  encryptUserPII, decryptUserPII, emailIndex,
} from '../api/lib/crypto-fields.js';
import { databaseWorkingCopy, mergeDatabaseThreeWay } from '../api/lib/schema.js';
import { canAccessRoom, dmRoomFor, normalizeRoomId } from '../api/lib/rooms.js';
import { base64DecodedSize, mediaMagicMatches } from '../api/lib/media.js';
import { blockedHostname, safePublicUrl } from '../api/routes/link-preview.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
}
function rejects(fn, pattern) {
  return assert.rejects(fn, pattern);
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function u32(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}
function cborLength(major, length) {
  if (length < 24) return new Uint8Array([(major << 5) | length]);
  if (length < 256) return new Uint8Array([(major << 5) | 24, length]);
  if (length < 65536) return new Uint8Array([(major << 5) | 25, length >> 8, length & 255]);
  throw new Error('test encoder length too large');
}
function cbor(value) {
  if (value instanceof Uint8Array) return concat(cborLength(2, value.length), value);
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return concat(cborLength(3, bytes.length), bytes);
  }
  if (Number.isInteger(value)) {
    return value >= 0 ? cborLength(0, value) : cborLength(1, -1 - value);
  }
  if (Array.isArray(value)) return concat(cborLength(4, value.length), ...value.map(cbor));
  if (value instanceof Map) {
    const entries = [...value.entries()];
    return concat(cborLength(5, entries.length), ...entries.flatMap(([key, val]) => [cbor(key), cbor(val)]));
  }
  throw new Error('unsupported test CBOR value');
}
function fakeContext(cookie = '') {
  const responseHeaders = new Map();
  return {
    req: { header: (name) => String(name).toLowerCase() === 'cookie' ? cookie : '' },
    header: (name, value) => responseHeaders.set(String(name).toLowerCase(), value),
    responseHeaders,
  };
}

console.log('\nPRIV SPACA — v170 security, persistence and PWA regression suite\n');

await test('APP_VERSION, SW_VERSION and immutable assets are synchronized at v170', async () => {
  const [app, sw, index] = await Promise.all([
    readFile(new URL('../app.js', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /const APP_VERSION = 'priv-spaca-v170';/);
  assert.match(sw, /const SW_VERSION = 'priv-spaca-v170';/);
  assert.match(sw, /priv-spaca-static-v170/);
  assert.match(sw, /priv-spaca-runtime-v170/);
  // Asset counters continue from v169's ?v=187/192 values to avoid colliding
  // with year-long immutable browser entries from historical releases.
  for (const asset of ['style.min.css?v=188', 'app.min.js?v=194', 'boot-guard.min.js?v=170']) {
    assert.ok(index.includes(asset), `index missing ${asset}`);
    assert.ok(sw.includes(`'/${asset}'`), `service worker missing ${asset}`);
  }
  assert.ok(!index.includes('auth.react.min.js'), 'auth bundle must not block authenticated startup');
  assert.ok(app.includes("script.src = '/auth.react.min.js?v=194'"), 'app must lazy-load current auth bundle');
  assert.ok(sw.includes("'/auth.react.min.js?v=194'"), 'service worker must retain offline auth bundle');
  assert.equal(index.split(/\r?\n/).length, 1, 'index.html must remain one line');
});

await test('source, audit and repository metadata routes are denied', async () => {
  const redirects = await readFile(new URL('../_redirects', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
  for (const path of ['/app.js', '/style.css', '/react-auth/*', '/scripts/*', '/AUDIT_*', '/.git*']) {
    assert.ok(redirects.includes(path), `missing redirect denial for ${path}`);
  }
  for (const path of ["'/app.js'", "'/style.css'", "'/react-auth/'", "'/scripts/'", "'/AUDIT_'", "'/.git'"]) {
    assert.ok(worker.includes(path), `missing Advanced Mode denial for ${path}`);
  }
});

await test('JWT is HS256-scoped, signed, bounded and rejects tampering', async () => {
  cfg.JWT_SECRET = 'v170-test-secret-only-9f8c7e6d5b4a3210';
  const token = await signToken({ id: 'usr_test_170', username: 'tester', tokenVersion: 7 });
  const payload = await verifyToken(token);
  assert.equal(payload.uid, 'usr_test_170');
  assert.equal(payload.iss, TOKEN_ISSUER);
  assert.equal(payload.aud, TOKEN_AUDIENCE);
  assert.equal(payload.sv, 7);
  assert.ok(payload.jti && payload.exp > payload.iat);
  const pieces = token.split('.');
  const tamperedBody = b64urlJson({ ...payload, uid: 'usr_attacker' });
  await rejects(() => verifyToken(`${pieces[0]}.${tamperedBody}.${pieces[2]}`), /signature/i);
  await rejects(() => verifyToken('x'.repeat(9000)), /token/i);

  const badHeader = b64urlJson({ alg: 'none', typ: 'JWT' });
  const body = b64urlJson(payload);
  const sigBytes = await hmacSha256(cfg.JWT_SECRET, `${badHeader}.${body}`);
  const sig = b64urlEncode(sigBytes);
  await rejects(() => verifyToken(`${badHeader}.${body}.${sig}`), /header/i);
});

await test('session cookie is __Host-, HttpOnly, Secure and SameSite=Strict', async () => {
  const c = fakeContext();
  setSessionCookie(c, 'signed.jwt.value');
  const set = c.responseHeaders.get('set-cookie');
  assert.match(set, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(set, /Path=\//);
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Strict/);
  assert.doesNotMatch(set, /Domain=/i);
  const request = fakeContext(`${SESSION_COOKIE}=signed.jwt.value; theme=dark`);
  assert.equal(tokenFromRequest(request), 'signed.jwt.value');
  clearSessionCookie(c);
  assert.match(c.responseHeaders.get('set-cookie'), /Max-Age=0/);
});

await test('auth-security mutations invalidate session, login and password caches', async () => {
  const user = { id: 'usr_cache_170', username: 'CacheUser', email: 'cache@example.test' };
  _authUserCache.set(user.id, { user, fetchedAt: Date.now() });
  _loginUserCache.set('user:cacheuser', { _user: user, _cachedAt: Date.now() });
  _loginUserCache.set('user:cache@example.test', { _user: user, _cachedAt: Date.now() });
  _loginUserCache.set('user:formername', { _user: user, _cachedAt: Date.now() });
  _bcryptVerifyCache.set(`${user.id}|old-hash|old-password`, { ok: true, ts: Date.now() });
  _bcryptVerifyCache.set('usr_someone_else|hash|password', { ok: true, ts: Date.now() });
  invalidateUserAuthCaches(user, 'FormerName');
  assert.equal(_authUserCache.has(user.id), false);
  assert.equal(_loginUserCache.has('user:cacheuser'), false);
  assert.equal(_loginUserCache.has('user:cache@example.test'), false);
  assert.equal(_loginUserCache.has('user:formername'), false);
  assert.equal(_bcryptVerifyCache.has(`${user.id}|old-hash|old-password`), false);
  assert.equal(_bcryptVerifyCache.has('usr_someone_else|hash|password'), true);
  _bcryptVerifyCache.delete('usr_someone_else|hash|password');
});

await test('signed-in startup uses materialized unread state without DM request fan-out', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('const indexedUnread = Object.values(_unreadByRoom || {})'));
  assert.ok(!app.includes('dmMembers.map(async (u) =>'), 'notification polling must not fetch every DM room');
  assert.ok(app.includes("if ((p === '/auth/me' && m === 'GET') || (p === '/rtc/signals' && m === 'GET')) return 1;"));
  assert.ok(app.includes('Object.values(State.pollTimers || {}).forEach(timer => clearInterval(timer));'));
});

await test('distributed session revocation uses durable user state instead of isolate cache', async () => {
  const middleware = await readFile(new URL('../api/lib/middleware.js', import.meta.url), 'utf8');
  const store = await readFile(new URL('../api/lib/store-turso.js', import.meta.url), 'utf8');
  const durableBranch = middleware.indexOf('if (isTursoConfigured())');
  const localCacheBranch = middleware.indexOf('const cached = _authUserCache.get(p.uid)');
  assert.ok(durableBranch > 0 && localCacheBranch > durableBranch, 'durable session check must precede local cache');
  assert.ok(middleware.includes('await fetchTursoUserById(p.uid)'), 'auth must read the durable structured user');
  const userLookup = store.slice(store.indexOf('export async function fetchTursoUserById'), store.indexOf('export async function fetchTursoNotifications'));
  assert.ok(!userLookup.includes("catch(() => ({ rows: [] }))"), 'auth storage failures must not collapse into not-found');
});

await test('AES-GCM PII envelopes round-trip, resist tampering and blind-index deterministically', async () => {
  cfg.FIELD_KEY = 'v170-field-key-test-material-32-bytes-minimum';
  const encrypted = await encryptField('private@example.test');
  assert.ok(isEncrypted(encrypted));
  assert.notEqual(encrypted, 'private@example.test');
  assert.equal(await decryptField(encrypted), 'private@example.test');
  const last = encrypted.at(-1);
  const tampered = encrypted.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  assert.equal(await decryptField(tampered), null);

  const original = {
    id: 'usr_1', email: 'private@example.test', dateOfBirth: '2000-01-02', username: 'public_name',
    pushSubs: [{ endpoint: 'https://push.example.test/secret', keys: { p256dh: 'public-key-material', auth: 'auth-secret-material' } }],
  };
  const sealed = await encryptUserPII(original);
  assert.equal(original.email, 'private@example.test', 'input must not be mutated');
  assert.ok(isEncrypted(sealed.email) && isEncrypted(sealed.dateOfBirth));
  assert.ok(isEncrypted(sealed.pushSubs[0].endpoint));
  assert.ok(isEncrypted(sealed.pushSubs[0].keys.p256dh));
  assert.ok(isEncrypted(sealed.pushSubs[0].keys.auth));
  assert.deepEqual(await decryptUserPII(sealed), original);
  const idx1 = await emailIndex(' Private@Example.Test ');
  const idx2 = await emailIndex('private@example.test');
  assert.equal(idx1, idx2);
  assert.match(idx1, /^bi1:/);
  assert.ok(!idx1.includes('private'));
});

await test('verified persistence retries boundedly after replica lag', async () => {
  const dbSource = await readFile(new URL('../api/lib/db.js', import.meta.url), 'utf8');
  const verified = dbSource.slice(dbSource.indexOf('export async function saveDatabaseVerified'));
  assert.ok(verified.includes('const maxAttempts = Math.max(1, Math.min(8'), 'verification retries must be bounded');
  assert.ok(verified.includes('for (let attempt = 0; attempt < maxAttempts; attempt++)'), 'attempts parameter must drive verification');
  assert.ok(verified.includes('await sleepMs(15 * (attempt + 1))'), 'replica retries must back off');
});

await test('three-way CAS merge preserves independent concurrent nested updates', async () => {
  const baseDb = {
    users: [{ id: 'usr_1', createdAt: 1, bio: 'old', followers: [], prefs: { theme: 'light', locale: 'en' } }],
    posts: [{ id: 'post_1', createdAt: 1, text: 'base', likes: [] }],
  };
  const local = databaseWorkingCopy(baseDb);
  local.users[0].bio = 'local bio';
  local.users[0].prefs.theme = 'dark';
  local.posts[0].likes.push({ userId: 'usr_local', emoji: 'heart' });
  const remote = structuredClone(baseDb);
  remote.users[0].followers.push('usr_remote');
  remote.users[0].prefs.locale = 'hi';
  remote.posts[0].text = 'remote text';
  const merged = mergeDatabaseThreeWay(remote, local[Symbol.for('unused')] || baseDb, local);
  assert.equal(merged.users[0].bio, 'local bio');
  assert.equal(merged.users[0].prefs.theme, 'dark');
  assert.equal(merged.users[0].prefs.locale, 'hi');
  assert.deepEqual(merged.users[0].followers, ['usr_remote']);
  assert.equal(merged.posts[0].text, 'remote text');
  assert.equal(merged.posts[0].likes[0].userId, 'usr_local');
});

await test('room normalization and authorization prevent cross-DM access', async () => {
  assert.equal(dmRoomFor('usr_b', 'usr_a'), 'dm:usr_a:usr_b');
  assert.equal(normalizeRoomId('dm:usr_b:usr_a', 'usr_a'), 'dm:usr_a:usr_b');
  assert.equal(normalizeRoomId('dm:usr_a:../../etc', 'usr_a'), '');
  assert.equal(canAccessRoom('dm:usr_a:usr_b', 'usr_a', {}), true);
  assert.equal(canAccessRoom('dm:usr_a:usr_b', 'usr_c', {}), false);
  assert.equal(canAccessRoom('dm:usr_a:usr_a', 'usr_a', {}), false);
  assert.equal(canAccessRoom('group:friends', 'usr_a', { groups: [{ id: 'group:friends', memberIds: ['usr_a'] }] }), true);
  assert.equal(canAccessRoom('group:friends', 'usr_b', { groups: [{ id: 'group:friends', memberIds: ['usr_a'] }] }), false);
});

await test('link previews reject private, encoded and trailing-dot hosts', async () => {
  for (const host of ['localhost', 'localhost.', 'metadata.internal', 'metadata.internal.', '127.0.0.1', '2130706433', '0x7f000001', '[::1]', '[fc00::1]']) {
    assert.equal(blockedHostname(host), true, `${host} should be blocked`);
  }
  assert.equal(blockedHostname('fc-example.com'), false, 'ordinary domains beginning with fc must remain valid');
  assert.equal(safePublicUrl('http://127.0.0.1/private'), null);
  assert.equal(safePublicUrl('https://example.com:444/path'), null);
  assert.equal(safePublicUrl('https://example.com/path').hostname, 'example.com');
});

await test('media validation checks decoded size and MIME magic bytes', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
  assert.equal(base64DecodedSize(png), 8);
  assert.equal(mediaMagicMatches(png, 'image/png'), true);
  assert.equal(mediaMagicMatches(png, 'image/jpeg'), false);
  assert.equal(mediaMagicMatches(jpeg, 'image/jpeg'), true);
  assert.equal(mediaMagicMatches('not base64!', 'image/png'), false);
});

await test('WebAuthn registration and authentication verify a real ES256 ceremony', async () => {
  const rpId = 'priv-spaca.pages.dev';
  const origin = `https://${rpId}`;
  const challenge = randomChallenge();
  assert.equal(b64urlDecode(challenge).length, 32);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const x = b64urlDecode(jwk.x);
  const y = b64urlDecode(jwk.y);
  const credentialId = crypto.getRandomValues(new Uint8Array(32));
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]));
  const registrationAuthData = concat(
    rpHash, new Uint8Array([0x45]), u32(0), new Uint8Array(16),
    new Uint8Array([0, credentialId.length]), credentialId, cose,
  );
  const attestationObject = cbor(new Map([
    ['fmt', 'none'], ['attStmt', new Map()], ['authData', registrationAuthData],
  ]));
  const clientCreate = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
  const registration = await verifyRegistrationResponse({
    id: b64urlEncode(credentialId), rawId: b64urlEncode(credentialId), type: 'public-key',
    clientDataJSON: b64urlEncode(clientCreate), attestationObject: b64urlEncode(attestationObject),
    transports: ['internal', 'invalid-transport'],
  }, { challenge, origin, rpId });
  assert.equal(registration.credentialId, b64urlEncode(credentialId));
  assert.equal(registration.publicKeyJwk.crv, 'P-256');
  assert.deepEqual(registration.transports, ['internal']);

  const authChallenge = randomChallenge();
  const clientGet = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: authChallenge, origin, crossOrigin: false }));
  const authenticationAuthData = concat(rpHash, new Uint8Array([0x05]), u32(1));
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientGet));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, concat(authenticationAuthData, clientHash)));
  const response = {
    id: registration.credentialId, rawId: registration.credentialId, type: 'public-key',
    clientDataJSON: b64urlEncode(clientGet), authenticatorData: b64urlEncode(authenticationAuthData), signature: b64urlEncode(signature),
  };
  const verified = await verifyAuthenticationResponse(response, { challenge: authChallenge, origin, rpId }, registration);
  assert.equal(verified.counter, 1);
  await rejects(() => verifyAuthenticationResponse(response, { challenge: authChallenge, origin: 'https://evil.example', rpId }, registration), /client data mismatch/i);
  await rejects(() => verifyAuthenticationResponse(response, { challenge: randomChallenge(), origin, rpId }, registration), /client data mismatch/i);
  await rejects(() => verifyAuthenticationResponse(response, { challenge: authChallenge, origin, rpId }, { ...registration, counter: 1 }), /counter did not advance/i);
  const noUv = { ...response, authenticatorData: b64urlEncode(concat(rpHash, new Uint8Array([0x01]), u32(2))) };
  await rejects(() => verifyAuthenticationResponse(noUv, { challenge: authChallenge, origin, rpId }, registration), /presence and verification/i);
  const malformed = { ...response, signature: 'not+base64url' };
  await rejects(() => verifyAuthenticationResponse(malformed, { challenge: authChallenge, origin, rpId }, registration), /base64url/i);
});

await test('CBOR and base64url parsers fail closed on malformed or oversized input', async () => {
  assert.throws(() => decodeCbor(new Uint8Array([0x5f])), /unsupported/i);
  assert.throws(() => decodeCbor(new Uint8Array([0x58, 0x04, 0x01])), /truncated/i);
  assert.throws(() => decodeCbor(new Uint8Array([...Array(34).fill(0x81), 0x00])), /nesting/i);
  assert.throws(() => b64urlDecode('***'), /invalid/i);
  assert.throws(() => b64urlDecode('A'.repeat(2000), 8), /invalid|large/i);
});

console.log(`\n  ${passed} v170 regression groups passed\n`);
