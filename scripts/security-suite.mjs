/**
 * PRIV SPACA — Phase 1 security regression suite.
 *
 *   node scripts/security-suite.mjs [baseUrl]
 *
 * Defaults to http://127.0.0.1:8787 (scripts/dev-server.mjs). Pass a deployed
 * URL to run the same assertions against production.
 *
 * Every assertion maps to a Phase 1 acceptance item, and each one is written so
 * that it fails if the protection is removed — a test that passes on the old
 * code would tell us nothing.
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const IS_REMOTE = !/127\.0\.0\.1|localhost/.test(BASE);

// Production enforces a minimum client version and answers 426 to anything
// that does not identify itself. Real clients send this header from app.js, so
// a suite that omitted it was testing the version gate, not the security work.
const APP_VERSION = process.env.PS_APP_VERSION || 'priv-spaca-v153';

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
}

const j = async (path, opts = {}) => {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'X-App-Version': APP_VERSION, ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, headers: r.headers, body };
};

const post = (path, data, token) => j(path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-App-Version': APP_VERSION,
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  },
  body: typeof data === 'string' ? data : JSON.stringify(data),
});

/** Anything that must never appear in a response body. */
const LEAK_RE = /ECONNREFUSED|SQLITE|libsql|node_modules|\/home\/user|\.js:\d+|at \w+ \(|ReferenceError|TypeError|eyJhbGciOiJFZERTQS|password_hash|passwordHash/i;

async function main() {
  console.log(`\nPRIV SPACA — Phase 1 security suite\ntarget: ${BASE}\n`);

  // ---------------------------------------------------------------- headers
  console.log('security headers');
  const h = await j('/api/health');
  const H = (k) => h.headers.get(k) || '';
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

  // Headers must also be on error responses — a header an attacker can dodge
  // by provoking a failure is not a control.
  const errH = await post('/api/posts/like', {});
  check('headers present on error responses', (errH.headers.get('content-security-policy') || '').includes("default-src 'self'"));

  // ------------------------------------------------------------- /api/ready
  console.log('\nreadiness');
  const ready = await j('/api/ready');
  check('/api/ready responds', ready.status === 200 || ready.status === 503);
  check('/api/ready reports checks', !!(ready.body && ready.body.checks));
  check('/api/ready reports load', !!(ready.body && ready.body.checks && ready.body.checks.load));

  // ------------------------------------------------------------------- auth
  console.log('\nauthentication');
  const uniq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cred = { username: 'sec' + uniq.slice(-8), email: `sec${uniq}@example.test`, password: 'SuiteTestPw123', displayName: 'Suite', bio: '', pin: '7392', termsAccepted: true };
  const su = await post('/api/auth/signup', cred);
  const token = su.body && su.body.token;
  check('signup succeeds (PBKDF2 hashing path)', !!token, `status ${su.status}`);

  const good = await post('/api/auth/login', { identifier: cred.username, password: cred.password });
  check('login with correct password', good.status === 200 && !!(good.body && good.body.token));

  const badPw = await post('/api/auth/login', { identifier: cred.username, password: 'wrongwrong' });
  const ghost = await post('/api/auth/login', { identifier: 'ghost' + uniq, password: 'wrongwrong' });
  check('wrong password -> 401', badPw.status === 401);
  check('unknown account -> 401', ghost.status === 401);
  check('no account enumeration (identical bodies)', JSON.stringify(badPw.body) === JSON.stringify(ghost.body),
    `${JSON.stringify(badPw.body)} vs ${JSON.stringify(ghost.body)}`);

  if (!token) {
    console.log('\n(no token — skipping authenticated assertions)');
    return report();
  }

  // ------------------------------------------------------- mass assignment
  console.log('\nmass assignment');
  const esc = await post('/api/user/update', {
    displayName: 'Legit Name',
    verified: true, isAdmin: true, tokenVersion: 9999,
    passwordHash: 'pwned', followers: ['x'], id: 'usr_someone_else',
  }, token);
  const u = (esc.body && esc.body.user) || {};
  check('privileged fields ignored: verified', u.verified !== true);
  check('privileged fields ignored: isAdmin', u.isAdmin !== true);
  check('privileged fields ignored: passwordHash', !('passwordHash' in u));
  check('legitimate field still applied', u.displayName === 'Legit Name');

  // ------------------------------------------------------------ validation
  console.log('\ninput validation');
  const trav = await post('/api/user/follow', { targetId: '../../../etc/passwd' }, token);
  check('path traversal in id -> 400', trav.status === 400);
  check('validation names the bad field', !!(trav.body && trav.body.details && trav.body.details.targetId));

  const nosql = await post('/api/user/follow', { targetId: { $ne: null } }, token);
  check('object where string expected -> 400', nosql.status === 400);

  const badJson = await post('/api/posts/comment', '{"postId": broken,,,', token);
  check('malformed JSON -> 400 not 500', badJson.status === 400, `got ${badJson.status}`);
  check('malformed JSON has a clear message', /valid JSON/i.test((badJson.body && badJson.body.message) || ''));

  const badEnum = await post('/api/user/follow-requests/respond', { requesterId: 'usr_a1', action: 'promote' }, token);
  check('invalid enum -> 400', badEnum.status === 400);

  const emptyBody = await post('/api/posts/comment', {}, token);
  check('missing required field -> 400', emptyBody.status === 400);

  // ------------------------------------------------------- error hygiene
  console.log('\nerror hygiene');
  const probes = [
    ['/api/posts/like', { postId: 'post_definitely_missing' }],
    ['/api/posts/delete', { postId: 'post_definitely_missing' }],
    ['/api/user/follow', { targetId: 'usr_definitely_missing' }],
    ['/api/messages/delete', { messageId: 'msg_definitely_missing' }],
  ];
  let leaked = null;
  for (const [path, payload] of probes) {
    const r = await post(path, payload, token);
    const s = JSON.stringify(r.body || '');
    if (LEAK_RE.test(s)) leaked = `${path}: ${s.slice(0, 120)}`;
  }
  check('no internals leaked in error bodies', leaked === null, leaked || '');

  const nf = await j('/api/route-that-does-not-exist');
  check('unknown route -> 404 JSON', nf.status === 404 && !!nf.body);

  // The version gate must still reject un-versioned clients (426), otherwise
  // the assertions above would be passing for the wrong reason.
  if (IS_REMOTE) {
    const noVer = await fetch(BASE + '/api/users', { headers: { Authorization: 'Bearer ' + token } });
    check('version gate rejects client without X-App-Version', noVer.status === 426, `got ${noVer.status}`);
  }

  // ----------------------------------------------------------- happy paths
  console.log('\nhappy paths (validation must not break normal use)');
  const created = await post('/api/posts/create', { text: 'security suite post', audience: 'public' }, token);
  const postId = created.body && created.body.post && created.body.post.id;
  check('post create', !!postId, `status ${created.status}`);
  if (postId) {
    check('post like', (await post('/api/posts/like', { postId }, token)).status === 200);
    check('post comment', (await post('/api/posts/comment', { postId, text: 'hi' }, token)).status === 200);
  }
  check('user note', (await post('/api/user/note', { text: 'note text' }, token)).status === 200);
  check('typing', (await post('/api/user/typing', { roomId: 'general-group' }, token)).status === 200);
  check('message send', (await post('/api/messages/send', { roomId: 'general-group', text: 'hello', clientNonce: 'n1' }, token)).status === 200);
  check('message read', (await post('/api/messages/read', { roomId: 'general-group' }, token)).status === 200);
  check('feed read', (await j('/api/posts?limit=5', { headers: { Authorization: 'Bearer ' + token } })).status === 200);
  check('users read', (await j('/api/users', { headers: { Authorization: 'Bearer ' + token } })).status === 200);

  return report();
}

function report() {
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\n  failed assertions:');
    for (const f of failures) console.log('    - ' + f);
  }
  console.log('');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('suite crashed:', e); process.exit(2); });
