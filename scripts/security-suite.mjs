/**
 * PRIV SPACA — live security regression suite.
 *
 *   PS_APP_VERSION=priv-spaca-v170 node scripts/security-suite.mjs [baseUrl]
 *
 * The suite creates an isolated account, exercises cookie auth/recovery and
 * authorization paths, then permanently deletes the account and its fixtures.
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const IS_REMOTE = !/127\.0\.0\.1|localhost/.test(BASE);
const APP_VERSION = process.env.PS_APP_VERSION || 'priv-spaca-v170';

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}
function cookieFrom(response) {
  const set = response.headers.get('set-cookie') || '';
  return set ? set.split(';', 1)[0] : '';
}
async function j(path, opts = {}, { version = true } = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { ...(version ? { 'X-App-Version': APP_VERSION } : {}), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, headers: r.headers, body };
}
function post(path, data, cookie = '', options = {}) {
  return j(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: typeof data === 'string' ? data : JSON.stringify(data),
  }, options);
}
function get(path, cookie = '', options = {}) {
  return j(path, { headers: cookie ? { Cookie: cookie } : {} }, options);
}
function publicError(body) {
  if (!body || typeof body !== 'object') return body;
  const { requestId, correlation_id, ...stable } = body;
  return stable;
}
function responseDetail(response) {
  const error = String(response?.body?.error || '').slice(0, 120);
  return `status ${response?.status}${error ? `, error ${error}` : ''}`;
}

/** Anything that must never appear in a response body. */
const LEAK_RE = /ECONNREFUSED|SQLITE|libsql|node_modules|\/home\/user|\.js:\d+|at \w+ \(|ReferenceError|TypeError|eyJhbGciOiJFZERTQS|password_hash|passwordHash|pinHash|recoveryCodeHashes/i;

async function main() {
  console.log(`\nPRIV SPACA — v170 live security suite\ntarget: ${BASE}\n`);

  console.log('security headers');
  const h = await j('/api/health');
  const H = (k) => h.headers.get(k) || '';
  check('/api/health is healthy', h.status === 200 && h.body?.ok === true);
  check('CSP present', H('content-security-policy').includes("default-src 'self'"));
  check("CSP object-src 'none'", H('content-security-policy').includes("object-src 'none'"));
  check("CSP frame-ancestors 'none'", H('content-security-policy').includes("frame-ancestors 'none'"));
  check("CSP base-uri 'self'", H('content-security-policy').includes("base-uri 'self'"));
  check('X-Content-Type-Options nosniff', H('x-content-type-options') === 'nosniff');
  check('X-Frame-Options DENY', H('x-frame-options') === 'DENY');
  check('Referrer-Policy set', H('referrer-policy').includes('strict-origin'));
  check('Permissions-Policy locks geolocation', H('permissions-policy').includes('geolocation=()'));
  check('COOP same-origin', H('cross-origin-opener-policy') === 'same-origin');
  check('API responses are no-store', H('cache-control').includes('no-store'));
  check('X-Request-Id echoed', /.+/.test(H('x-request-id')));
  if (IS_REMOTE) {
    check('HSTS 2y + preload', /max-age=63072000/.test(H('strict-transport-security')) && /preload/.test(H('strict-transport-security')));
  } else {
    check('HSTS correctly absent over plain http', H('strict-transport-security') === '');
  }
  const errH = await post('/api/posts/like', {});
  check('headers present on error responses', (errH.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  const shellResponse = await fetch(BASE + '/', { redirect: 'follow' });
  const shellHtml = await shellResponse.text();
  check('static shell references v170 release assets', shellHtml.includes('style.min.css?v=188') && shellHtml.includes('app.min.js?v=193') && !shellHtml.includes('auth.react.min.js'));
  if (IS_REMOTE) {
    check('static shell has CSP', (shellResponse.headers.get('content-security-policy') || '').includes("default-src 'self'"));
    check('static shell has HSTS', /max-age=63072000/.test(shellResponse.headers.get('strict-transport-security') || ''));
    check('static shell blocks framing', shellResponse.headers.get('x-frame-options') === 'DENY');
  }

  console.log('\nreadiness privacy');
  const ready = await j('/api/ready');
  check('/api/ready responds', ready.status === 200 || ready.status === 503);
  check('/api/ready exposes only coarse readiness', typeof ready.body?.ready === 'boolean' && !('checks' in ready.body) && !('load' in ready.body));

  console.log('\nstatic source blocking');
  for (const path of ['/app.js', '/style.css', '/react-auth/main.jsx', '/scripts/check.mjs', '/AUDIT_V169_2026-09-06.md', '/package.json', '/wrangler.toml', '/.git/config']) {
    const r = await j(path);
    check(`${path} is not publicly readable`, r.status === 404, `got ${r.status}`);
  }

  console.log('\nauthentication + cookie policy');
  const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cred = {
    username: 'sec' + uniq.slice(-8), email: `sec${uniq}@example.test`,
    password: 'SuiteTestPw123!', displayName: 'Suite', pin: '7392',
    termsAccepted: true, termsVersion: '1.0',
  };
  let activePassword = cred.password;
  let activeCookie = '';
  let accountCreated = false;

  const su = await post('/api/auth/signup', cred);
  const signupSetCookie = su.headers.get('set-cookie') || '';
  const signupCookie = cookieFrom(su);
  accountCreated = su.status === 200 && !!su.body?.user;
  activeCookie = signupCookie;
  check('signup succeeds (PBKDF2 hashing path)', accountCreated, `status ${su.status}`);
  check('auth response does not expose bearer token', accountCreated && !('token' in (su.body || {})));
  check('signup issues exactly 8 recovery codes once', Array.isArray(su.body?.recoveryCodes) && su.body.recoveryCodes.length === 8 && new Set(su.body.recoveryCodes).size === 8);
  check('__Host session cookie is issued', signupCookie.startsWith('__Host-ps_session='));
  check('session cookie is HttpOnly', /;\s*HttpOnly/i.test(signupSetCookie));
  check('session cookie is Secure', /;\s*Secure/i.test(signupSetCookie));
  check('session cookie is SameSite=Strict', /;\s*SameSite=Strict/i.test(signupSetCookie));
  check('session cookie has no Domain attribute', !/;\s*Domain=/i.test(signupSetCookie));

  if (!accountCreated || !signupCookie) {
    console.log('\n(no durable test account — authenticated assertions skipped)');
    return report();
  }

  const me = await get('/api/auth/me', signupCookie);
  check('cookie-authenticated /auth/me succeeds', me.status === 200 && me.body?.user?.username === cred.username);
  check('unauthenticated /auth/me is rejected', (await get('/api/auth/me')).status === 401);

  const good = await post('/api/auth/login', { identifier: cred.username, password: cred.password });
  const loginCookie = cookieFrom(good);
  check('login succeeds without JSON token', good.status === 200 && !!good.body?.user && !('token' in (good.body || {})) && !!loginCookie);
  const badPw = await post('/api/auth/login', { identifier: cred.username, password: 'wrongwrong' });
  const ghost = await post('/api/auth/login', { identifier: 'ghost' + uniq, password: 'wrongwrong' });
  check('wrong password -> 401', badPw.status === 401);
  check('unknown account -> 401', ghost.status === 401);
  check('no account enumeration (same stable public error)', JSON.stringify(publicError(badPw.body)) === JSON.stringify(publicError(ghost.body)),
    `${JSON.stringify(publicError(badPw.body))} vs ${JSON.stringify(publicError(ghost.body))}`);

  const logout = await post('/api/auth/logout', {}, loginCookie);
  check('logout succeeds and clears cookie', logout.status === 200 && /Max-Age=0/.test(logout.headers.get('set-cookie') || ''));
  check('logout revokes every older session version', (await get('/api/auth/me', signupCookie)).status === 401);
  const relogin = await post('/api/auth/login', { identifier: cred.username, password: cred.password });
  activeCookie = cookieFrom(relogin);
  const reloginMe = activeCookie ? await get('/api/auth/me', activeCookie) : null;
  check('fresh login works after revocation', relogin.status === 200 && !!activeCookie && reloginMe?.status === 200);

  console.log('\nmass assignment');
  const esc = await post('/api/user/update', {
    displayName: 'Legit Name', verified: true, isAdmin: true, tokenVersion: 9999,
    passwordHash: 'pwned', followers: ['x'], id: 'usr_someone_else',
  }, activeCookie);
  const u = esc.body?.user || {};
  check('privileged fields ignored: verified', u.verified !== true);
  check('privileged fields ignored: isAdmin', u.isAdmin !== true);
  check('privileged fields ignored: passwordHash', !('passwordHash' in u));
  check('legitimate field still applied', u.displayName === 'Legit Name');

  console.log('\ninput validation + authorization');
  const trav = await post('/api/user/follow', { targetId: '../../../etc/passwd' }, activeCookie);
  check('path traversal in id -> 400', trav.status === 400);
  const nosql = await post('/api/user/follow', { targetId: { $ne: null } }, activeCookie);
  check('object where string expected -> 400', nosql.status === 400);
  const badJson = await post('/api/posts/comment', '{"postId": broken,,,', activeCookie);
  check('malformed JSON -> 400 not 500', badJson.status === 400, `got ${badJson.status}`);
  const badEnum = await post('/api/user/follow-requests/respond', { requesterId: 'usr_a1', action: 'promote' }, activeCookie);
  check('invalid enum -> 400', badEnum.status === 400);
  const emptyBody = await post('/api/posts/comment', {}, activeCookie);
  check('missing required field -> 400', emptyBody.status === 400);
  const foreignDm = await post('/api/messages/send', { roomId: 'dm:usr_other_a:usr_other_b', text: 'forbidden', clientNonce: 'forbidden1' }, activeCookie);
  check('non-member DM send is forbidden', foreignDm.status === 403);
  const foreignTyping = await post('/api/user/typing', { roomId: 'dm:usr_other_a:usr_other_b' }, activeCookie);
  check('non-member typing signal is forbidden', foreignTyping.status === 403);

  console.log('\nrecovery codes + reset');
  const badRegen = await post('/api/user/recovery-codes', { password: 'wrongwrong' }, activeCookie);
  check('recovery-code regeneration requires password', badRegen.status === 401);
  const regen = await post('/api/user/recovery-codes', { password: cred.password }, activeCookie);
  const regeneratedCodes = regen.body?.recoveryCodes || [];
  check('password-confirmed regeneration returns 8 unique codes', regen.status === 200 && regeneratedCodes.length === 8 && new Set(regeneratedCodes).size === 8);
  check('recovery response never exposes code hashes', !LEAK_RE.test(JSON.stringify(regen.body || {})));
  const missingCode = await post('/api/auth/reset-by-pin', {
    identifier: cred.username, pin: cred.pin, recoveryCode: 'INVALID-CODE', newPassword: 'SuiteTestPw456!',
  });
  check('PIN alone cannot reset password', missingCode.status === 401);
  const reset = await post('/api/auth/reset-by-pin', {
    identifier: cred.username, pin: cred.pin, recoveryCode: regeneratedCodes[0], newPassword: 'SuiteTestPw456!',
  });
  const resetCookie = cookieFrom(reset);
  check('PIN + one-time recovery code resets password', reset.status === 200 && !!resetCookie && !('token' in (reset.body || {})));
  if (reset.status === 200 && resetCookie) {
    activePassword = 'SuiteTestPw456!';
    activeCookie = resetCookie;
  }
  const oldPasswordLogin = await post('/api/auth/login', { identifier: cred.username, password: cred.password });
  check('old password is rejected immediately after reset', oldPasswordLogin.status === 401);
  const replay = await post('/api/auth/reset-by-pin', {
    identifier: cred.username, pin: cred.pin, recoveryCode: regeneratedCodes[0], newPassword: 'SuiteTestPw789!',
  });
  check('used recovery code cannot be replayed', replay.status === 401);

  console.log('\nerror hygiene');
  const probes = [
    ['/api/posts/like', { postId: 'post_definitely_missing' }],
    ['/api/posts/delete', { postId: 'post_definitely_missing' }],
    ['/api/user/follow', { targetId: 'usr_definitely_missing' }],
    ['/api/messages/delete', { messageId: 'msg_definitely_missing' }],
  ];
  let leaked = null;
  for (const [path, payload] of probes) {
    const r = await post(path, payload, activeCookie);
    const s = JSON.stringify(r.body || '');
    if (LEAK_RE.test(s)) leaked = `${path}: ${s.slice(0, 160)}`;
  }
  check('no internals leaked in error bodies', leaked === null, leaked || '');
  const nf = await j('/api/route-that-does-not-exist');
  check('unknown route -> 404 JSON', nf.status === 404 && !!nf.body);

  if (IS_REMOTE) {
    const noVer = await get('/api/users', activeCookie, { version: false });
    check('version gate rejects client without X-App-Version', noVer.status === 426, `got ${noVer.status}`);
  }

  console.log('\nhappy paths + export');
  const created = await post('/api/posts/create', { text: 'security suite post', audience: 'public' }, activeCookie);
  const postId = created.body?.post?.id;
  check('post create', !!postId, `status ${created.status}`);
  if (postId) {
    const liked = await post('/api/posts/like', { postId }, activeCookie);
    check('post like', liked.status === 200, responseDetail(liked));
    const commented = await post('/api/posts/comment', { postId, text: 'hi' }, activeCookie);
    check('post comment', commented.status === 200, responseDetail(commented));
  }
  const noted = await post('/api/user/note', { text: 'note text' }, activeCookie);
  check('user note', noted.status === 200, responseDetail(noted));
  const typed = await post('/api/user/typing', { roomId: 'general-group' }, activeCookie);
  check('typing', typed.status === 200, responseDetail(typed));
  const sent = await post('/api/messages/send', { roomId: 'general-group', text: 'hello', clientNonce: 'n1' }, activeCookie);
  check('message send', sent.status === 200, responseDetail(sent));
  const read = await post('/api/messages/read', { roomId: 'general-group' }, activeCookie);
  check('message read', read.status === 200 || (read.status === 202 && read.body?.deferred === true), responseDetail(read));
  const feed = await get('/api/posts?limit=5', activeCookie);
  check('feed read', feed.status === 200, responseDetail(feed));
  const usersResponse = await get('/api/users', activeCookie);
  check('users read', usersResponse.status === 200, responseDetail(usersResponse));
  const otherUsers = (usersResponse.body?.users || []).filter(user => user.id !== su.body?.user?.id);
  check('other-user responses omit private/auth fields', otherUsers.every(user =>
    !['email','dateOfBirth','pushSubs','passwordHash','pinHash','recoveryCodeHashes','tokenVersion','passkeyPublicKeyJwk']
      .some(field => Object.prototype.hasOwnProperty.call(user, field))
  ));
  const exported = await post('/api/user/export', {}, activeCookie);
  const exportText = JSON.stringify(exported.body || {});
  check('data export succeeds', exported.status === 200 && exported.body?.format === 'priv-spaca-user-export-v1', responseDetail(exported));
  check('data export excludes credential material', !LEAK_RE.test(exportText) && !/passkeyPublicKey|tokenVersion/.test(exportText));

  console.log('\ncleanup');
  if (accountCreated) {
    let deleted = await post('/api/user/delete', { password: activePassword, pin: cred.pin, confirmation: 'DELETE' }, activeCookie);
    // Cleanup must survive an earlier session assertion failure so the suite
    // never strands a disposable account in production.
    if (deleted.status === 401) {
      const rescueLogin = await post('/api/auth/login', { identifier: cred.username, password: activePassword });
      const rescueCookie = cookieFrom(rescueLogin);
      if (rescueCookie) {
        deleted = await post('/api/user/delete', { password: activePassword, pin: cred.pin, confirmation: 'DELETE' }, rescueCookie);
      }
    }
    check('temporary suite account permanently deleted', deleted.status === 200 && deleted.body?.deleted === true, `status ${deleted.status}`);
    if (deleted.status === 200) accountCreated = false;
  }

  return report();
}

function report() {
  console.log(`\n${'-'.repeat(56)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  failed assertions:');
    for (const f of failures) console.log('    - ' + f);
  }
  console.log('');
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error('suite crashed:', e); process.exitCode = 2; });
