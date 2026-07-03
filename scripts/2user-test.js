// Full end-to-end test simulating the user-reported scenarios with 2 real users
(async () => {
  const BASE = 'https://priv-spaca.pages.dev';
  const log = (...a) => console.log(...a);
  let ok = 0, fail = 0;
  async function api(path, opts = {}) {
    const res = await fetch(BASE + '/api' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }
  // Login as owner
  const r1 = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'Arvind_1011', password: 'TestPass123!' }) });
  if (r1.status !== 200) { console.log('FAIL owner login:', r1); return; }
  const t1 = r1.data.token;
  const u1 = r1.data.user;
  console.log('Owner logged in:', u1.username, '|', u1.id);
  // Login as second user
  const r2 = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'anushka_1011', password: 'TestPass123!' }) });
  if (r2.status !== 200) { console.log('FAIL user2 login:', r2); return; }
  const t2 = r2.data.token;
  const u2 = r2.data.user;
  console.log('User2 logged in:', u2.username, '|', u2.id);
  // 1. Test: /api/auth/me with token (session persistence check)
  const me = await api('/auth/me', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('GET /auth/me:', me.status, me.data?.user?.username);
  if (me.status === 200) ok++; else fail++;
  // 2. Test: feed
  const feed = await api('/feed', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('GET /feed:', feed.status, 'posts:', feed.data?.posts?.length);
  if (feed.status === 200 && Array.isArray(feed.data?.posts)) ok++; else fail++;
  // 3. Test: posts
  const posts = await api('/posts', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('GET /posts:', posts.status, 'posts:', posts.data?.posts?.length);
  if (posts.status === 200 && Array.isArray(posts.data?.posts)) ok++; else fail++;
  // 4. Test: users
  const users = await api('/users', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('GET /users:', users.status, 'users:', users.data?.users?.length);
  if (users.status === 200 && Array.isArray(users.data?.users)) ok++; else fail++;
  // 5. Test: profile (the follower/following crash)
  const prof1 = await api('/user/' + u1.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('GET /user/<owner>/profile:', prof1.status, 'posts:', prof1.data?.posts?.length, 'followerIds:', prof1.data?.user?.followerIds?.length);
  if (prof1.status === 200) ok++; else { fail++; console.log('FAIL body:', JSON.stringify(prof1.data).slice(0,200)); }
  // 6. Test: profile of other user
  const prof2 = await api('/user/' + u2.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('GET /user/<user2>/profile:', prof2.status, 'posts:', prof2.data?.posts?.length);
  if (prof2.status === 200) ok++; else { fail++; console.log('FAIL body:', JSON.stringify(prof2.data).slice(0,200)); }
  // 7. Test: own profile as user2
  const prof2_self = await api('/user/' + u2.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t2 } });
  console.log('GET /user/<user2>/profile (self):', prof2_self.status);
  if (prof2_self.status === 200) ok++; else fail++;
  // 8. Test: messages
  const msgs = await api('/messages?roomId=general-group', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('GET /messages:', msgs.status, 'messages:', msgs.data?.messages?.length);
  if (msgs.status === 200) ok++; else fail++;
  // 9. Test: notifications
  const notif = await api('/notifications', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('GET /notifications:', notif.status, 'unread:', notif.data?.unread);
  if (notif.status === 200) ok++; else fail++;
  // 10. Test: malformed token (should 401 not 500)
  const bad = await api('/auth/me', { headers: { 'Authorization': 'Bearer not-a-real-token' } });
  console.log('GET /auth/me (bad token):', bad.status, '(expect 401)');
  if (bad.status === 401) ok++; else { fail++; console.log('FAIL body:', JSON.stringify(bad.data).slice(0,200)); }
  // 11. Test: no token
  const none = await api('/auth/me');
  console.log('GET /auth/me (no token):', none.status, '(expect 401)');
  if (none.status === 401) ok++; else fail++;
  // 12. Test: follow flow (the crash path)
  const follow = await api('/user/follow', { method: 'POST', headers: { 'Authorization': 'Bearer ' + u2.id ? t1 : '' }, body: JSON.stringify({ targetId: u2.id }) });
  console.log('POST /user/follow:', follow.status, '|', JSON.stringify(follow.data).slice(0, 150));
  if (follow.status === 200) ok++; else { fail++; }
  // 13. After follow, re-fetch own profile to check counts update
  const prof3 = await api('/user/' + u1.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('After follow, owner profile:', prof3.status, 'followers:', prof3.data?.user?.followerIds?.length, 'following:', prof3.data?.user?.followingIds?.length);
  if (prof3.status === 200) ok++; else fail++;
  // 14. After follow, re-fetch user2's profile to check their followers count
  const prof4 = await api('/user/' + u2.id + '/profile', { headers: { 'Authorization': 'Bearer ' + t1 } });
  console.log('After follow, user2 profile:', prof4.status, 'followers:', prof4.data?.user?.followerIds?.length);
  if (prof4.status === 200) ok++; else fail++;
  // Summary
  console.log('\n=========================================');
  console.log(`PASS: ${ok}  FAIL: ${fail}`);
  console.log('=========================================');
  process.exit(fail === 0 ? 0 : 1);
})();
