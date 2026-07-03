// Comprehensive 2-user scenario test covering all reported bugs:
// - "after tab refresh, logout" — session restoration from localStorage
// - "feed becomes empty" — feed rendering after refresh
// - "follower/following count error" — follow counts
// - "crashing" — every endpoint returns valid data without throwing
const BASE = 'https://priv-spaca.pages.dev';
let pass = 0, fail = 0;
const results = [];
function record(name, ok, info) {
  if (ok) pass++; else fail++;
  results.push({ name, ok, info: info || '' });
  console.log((ok ? '✓' : '✗') + ' ' + name + (info ? '  [' + info + ']' : ''));
}
async function api(path, opts = {}) {
  const res = await fetch(BASE + '/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

(async () => {
  // ====== Login both users ======
  const r1 = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'Arvind_1011', password: 'TestPass123!' }) });
  record('Owner login', r1.status === 200, `status=${r1.status}`);
  const t1 = r1.data.token, u1 = r1.data.user;
  const r2 = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'Anushka_1011', password: 'TestPass123!' }) });
  record('User2 login', r2.status === 200, `status=${r2.status}`);
  const t2 = r2.data.token, u2 = r2.data.user;

  // ====== Scenario 1: "After tab refresh, logout" ======
  // Simulate by validating that the session is still valid on a fresh
  // /auth/me call with the same token (this is what boot() does on reload)
  const me = await api('/auth/me', { headers: { 'Authorization': 'Bearer ' + t1 } });
  record('Session survives "refresh" (auth/me with stored token)', me.status === 200 && me.data?.user?.id === u1.id);
  // Validate that user2's token also works
  const me2 = await api('/auth/me', { headers: { 'Authorization': 'Bearer ' + t2 } });
  record('User2 session survives "refresh"', me2.status === 200 && me2.data?.user?.id === u2.id);

  // ====== Scenario 2: "Feed becomes empty" ======
  // /api/feed should return at least the owner's own posts
  const feed = await api('/feed', { headers: { 'Authorization': 'Bearer ' + t1 } });
  record('Feed loads with posts (owner)', feed.status === 200 && Array.isArray(feed.data?.posts) && feed.data.posts.length > 0, `posts=${feed.data?.posts?.length}`);
  const feed2 = await api('/feed', { headers: { 'Authorization': 'Bearer ' + t2 } });
  record('Feed loads (user2)', feed2.status === 200 && Array.isArray(feed2.data?.posts), `posts=${feed2.data?.posts?.length}`);

  // ====== Scenario 3: "Follower/following count error" ======
  // Make sure unfollow works correctly and counts decrement
  const profBefore = await api('/user/' + u1.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  const followersBefore = (profBefore.data?.user?.followerIds || []).length;
  // owner follows user2
  const f1 = await api('/user/follow', { method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 }, body: JSON.stringify({ targetId: u2.id }) });
  record('Owner can follow user2', f1.status === 200, JSON.stringify(f1.data || {}).slice(0, 100));
  // Check counts updated
  const profAfter = await api('/user/' + u1.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  const prof2After = await api('/user/' + u2.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  record('Owner following count incremented', (profAfter.data?.user?.followingIds || []).length > followersBefore);
  record('User2 follower count incremented', (prof2After.data?.user?.followerIds || []).length > 0);
  // Unfollow and verify counts decrement
  const f2 = await api('/user/unfollow', { method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 }, body: JSON.stringify({ targetId: u2.id }) });
  record('Owner can unfollow user2', f2.status === 200);
  const profFinal = await api('/user/' + u1.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  const prof2Final = await api('/user/' + u2.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  record('Owner following count back to baseline', (profFinal.data?.user?.followingIds || []).length === followersBefore);
  record('User2 follower count back to baseline', (prof2Final.data?.user?.followerIds || []).length === 0);

  // ====== Scenario 4: "Crashing" — check no endpoint throws 500 ======
  const endpoints = [
    ['GET', '/auth/me', t1],
    ['GET', '/feed', t1],
    ['GET', '/posts', t1],
    ['GET', '/users', t1],
    ['GET', '/messages?roomId=general-group', t1],
    ['GET', '/notifications', t1],
    ['GET', '/user/' + u1.id + '/profile', t1],
    ['GET', '/user/' + u2.id + '/profile', t1],
    ['GET', '/user/close-friends', t1],
    ['GET', '/posts/load-scheduled', t1],  // typo'd to test 404 handling
  ];
  for (const [m, p, t] of endpoints) {
    const r = await api(p, { method: m, headers: t ? { 'Authorization': 'Bearer ' + t } : {} });
    record(`No 500 on ${m} ${p}`, r.status !== 500, `status=${r.status}`);
  }

  // ====== Bonus: signup creates valid user that can log in ======
  const ts = Date.now();
  const su = await api('/auth/signup', { method: 'POST', body: JSON.stringify({
    username: 'scenariotest_' + ts, email: 'scenariotest_' + ts + '@example.com',
    displayName: 'Scenario', password: 'TestPass123!', pin: '4729',
    termsAccepted: true, termsVersion: '1.0'
  }) });
  record('Signup works', su.status === 200, `status=${su.status}`);
  if (su.status === 200) {
    const li = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'scenariotest_' + ts, password: 'TestPass123!' }) });
    record('Newly-signed-up user can log in', li.status === 200);
  }

  // ====== Summary ======
  console.log('\n=========================================');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  console.log('=========================================');
  if (fail > 0) {
    console.log('\nFailed tests:');
    for (const r of results) if (!r.ok) console.log('  - ' + r.name + (r.info ? ' [' + r.info + ']' : ''));
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('Test crashed:', e); process.exit(2); });
