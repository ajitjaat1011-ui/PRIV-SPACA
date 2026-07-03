// Deep audit: simulate the EXACT user-reported flows with real network calls.
// We measure:
//   1. Call receive flow (offer → poll → answer) — what user says fails
//   2. Load time (time to fetch /, /app.js, /style.css, /sw.js, /api/*)
//   3. Concurrent request handling (50 parallel calls)
//   4. Any 500s during normal usage

const BASE = 'https://priv-spaca.pages.dev';

const results = [];
function record(name, ok, info) {
  results.push({ name, ok, info: info || '' });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${info ? '  [' + info + ']' : ''}`);
}
function pad(s, n) { s = String(s); return s.length < n ? s + ' '.repeat(n - s.length) : s; }

async function api(path, opts = {}) {
  const start = Date.now();
  const res = await fetch(BASE + '/api' + path, {
    ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const ms = Date.now() - start;
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, ms };
}
async function rawFetch(url, opts = {}) {
  const start = Date.now();
  const res = await fetch(url, opts);
  const ms = Date.now() - start;
  let data = null; try { data = await res.text(); } catch (_) {}
  return { status: res.status, ms, data, len: data ? data.length : 0 };
}

(async () => {
  console.log('\n=== 1. LOAD-TIME AUDIT ===');
  // Cold-cache load (no SW interception here, just direct fetches)
  const home = await rawFetch(BASE + '/', { headers: { 'Cache-Control': 'no-cache' } });
  record('GET / loads fast (<2s)', home.ms < 2000, `${home.ms}ms, ${home.len}b`);
  const css = await rawFetch(BASE + '/style.css?v=65-auth-sync-fix', { headers: { 'Cache-Control': 'no-cache' } });
  record('GET /style.css loads fast (<3s)', css.ms < 3000, `${css.ms}ms, ${css.len}b`);
  const app = await rawFetch(BASE + '/app.js?v=65-auth-sync-fix', { headers: { 'Cache-Control': 'no-cache' } });
  record('GET /app.js loads fast (<4s)', app.ms < 4000, `${app.ms}ms, ${app.len}b`);
  const sw = await rawFetch(BASE + '/sw.js?v=65-auth-sync-fix', { headers: { 'Cache-Control': 'no-cache' } });
  record('GET /sw.js loads fast (<1s)', sw.ms < 1000, `${sw.ms}ms, ${sw.len}b`);

  console.log('\n=== 2. LOGIN FLOW ===');
  const r1 = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'Arvind_1011', password: 'TestPass123!' }) });
  record('Owner login', r1.status === 200, `${r1.ms}ms, status=${r1.status}`);
  if (r1.status !== 200) { console.log('STOPPING — cannot continue without login'); return; }
  const t1 = r1.data.token, u1 = r1.data.user;
  const r2 = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'Anushka_1011', password: 'TestPass123!' }) });
  record('User2 login', r2.status === 200, `${r2.ms}ms, status=${r2.status}`);
  const t2 = r2.data.token, u2 = r2.data.user;

  console.log('\n=== 3. CALL FLOW (the reported bug) ===');
  // User1 sends an offer to User2
  const fakeOffer = {
    type: 'offer',
    sdp: 'v=0\r\no=- 1234567890 1234567890 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n'
  };
  const offer = await api('/rtc/signal', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 },
    body: JSON.stringify({ targetId: u2.id, signal: { type: 'offer', offer: fakeOffer, video: false } })
  });
  record('User1 → User2: offer signal', offer.status === 200, `${offer.ms}ms, ${JSON.stringify(offer.data).slice(0,80)}`);

  // User2 polls for signals — this is what their app does every 1.5s
  const rtcLastSignalAt = 0;
  const poll = await api('/rtc/signals?since=' + rtcLastSignalAt, { headers: { 'Authorization': 'Bearer ' + t2 } });
  const gotOffer = poll.data?.signals?.some(s => s.fromId === u1.id && s.signal?.type === 'offer');
  record('User2 polls /rtc/signals and gets the offer', poll.status === 200 && gotOffer, `${poll.ms}ms, signals=${poll.data?.signals?.length}, gotOffer=${!!gotOffer}`);

  // User2 sends answer back
  const fakeAnswer = { type: 'answer', sdp: 'v=0\r\no=- 9876543210 9876543210 IN IP4 0.0.0.0\r\n' };
  const answer = await api('/rtc/signal', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + t2 },
    body: JSON.stringify({ targetId: u1.id, signal: { type: 'answer', answer: fakeAnswer, video: false } })
  });
  record('User2 → User1: answer signal', answer.status === 200, `${answer.ms}ms`);

  // User1 polls — should get the answer
  const sinceAfterOffer = Date.now() - 5000;
  const poll2 = await api('/rtc/signals?since=' + sinceAfterOffer, { headers: { 'Authorization': 'Bearer ' + t1 } });
  const gotAnswer = poll2.data?.signals?.some(s => s.fromId === u2.id && s.signal?.type === 'answer');
  record('User1 polls /rtc/signals and gets the answer', poll2.status === 200 && gotAnswer, `${poll2.ms}ms, signals=${poll2.data?.signals?.length}, gotAnswer=${!!gotAnswer}`);

  // ICE candidates
  const candidate = await api('/rtc/signal', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 },
    body: JSON.stringify({ targetId: u2.id, signal: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0 } } })
  });
  record('ICE candidate signal', candidate.status === 200, `${candidate.ms}ms`);

  // User2 polls — should get the ICE
  const poll3 = await api('/rtc/signals?since=' + sinceAfterOffer, { headers: { 'Authorization': 'Bearer ' + t2 } });
  const gotCandidate = poll3.data?.signals?.some(s => s.signal?.type === 'candidate');
  record('User2 polls and gets ICE candidate', poll3.status === 200 && gotCandidate, `${poll3.ms}ms`);

  console.log('\n=== 4. MESSAGING FLOW ===');
  const roomId = 'dm:' + [u1.id, u2.id].sort().join(':');
  const send = await api('/messages/send', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 },
    body: JSON.stringify({ roomId, targetUserId: u2.id, text: 'audit-msg' })
  });
  record('Send DM', send.status === 200, `${send.ms}ms`);
  const list = await api('/messages?roomId=' + roomId, { headers: { 'Authorization': 'Bearer ' + t1 } });
  record('List messages', list.status === 200 && list.data?.messages?.length > 0, `${list.ms}ms, count=${list.data?.messages?.length}`);

  console.log('\n=== 5. CONCURRENT LOAD (50 parallel requests) ===');
  // Simulate 50 users all loading the feed at the same time
  const start = Date.now();
  const tasks = [];
  for (let i = 0; i < 50; i++) {
    tasks.push(api('/feed', { headers: { 'Authorization': 'Bearer ' + t1 } }));
  }
  const results50 = await Promise.all(tasks);
  const elapsed = Date.now() - start;
  const ok50 = results50.filter(r => r.status === 200).length;
  const fail50 = results50.filter(r => r.status >= 500).length;
  const p50 = results50.map(r => r.ms).sort((a, b) => a - b);
  const p50Latency = p50[Math.floor(p50.length / 2)]; // median
  record('50 parallel /feed requests: all 200', ok50 === 50, `${ok50}/50 ok, ${fail50} 5xx, ${elapsed}ms total, median=${p50Latency}ms`);
  record('50 parallel requests finish in <10s', elapsed < 10000, `${elapsed}ms`);

  // 20 parallel /auth/me (simulating a refresh storm)
  const refreshStart = Date.now();
  const refreshTasks = [];
  for (let i = 0; i < 20; i++) {
    refreshTasks.push(api('/auth/me', { headers: { 'Authorization': 'Bearer ' + t1 } }));
  }
  const refreshResults = await Promise.all(refreshTasks);
  const refreshOk = refreshResults.filter(r => r.status === 200).length;
  const refreshElapsed = Date.now() - refreshStart;
  record('20 parallel /auth/me: all 200', refreshOk === 20, `${refreshOk}/20 ok, ${refreshElapsed}ms total`);

  // 10 parallel /messages/send (simulating a fast chat)
  const sendStart = Date.now();
  const sendTasks = [];
  for (let i = 0; i < 10; i++) {
    sendTasks.push(api('/messages/send', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 },
      body: JSON.stringify({ roomId, targetUserId: u2.id, text: 'concurrent-msg-' + i })
    }));
  }
  const sendResults = await Promise.all(sendTasks);
  const sendOk = sendResults.filter(r => r.status === 200).length;
  const sendElapsed = Date.now() - sendStart;
  record('10 parallel /messages/send: all 200', sendOk === 10, `${sendOk}/10 ok, ${sendElapsed}ms total`);

  console.log('\n=== 6. SSE / STREAM (real-time delivery) ===');
  // Open SSE stream and check it gets data
  const sseStart = Date.now();
  const ctrl = new AbortController();
  const sseTimeout = setTimeout(() => ctrl.abort(), 6000);
  let sseData = null;
  try {
    const r = await fetch(BASE + '/api/stream?token=' + t1, { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (Date.now() - sseStart < 5000) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (buf.includes('data:') || buf.includes('event:')) { sseData = buf.slice(0, 200); break; }
    }
  } catch (e) {
    // Expected for some servers
  } finally {
    clearTimeout(sseTimeout);
  }
  record('SSE /api/stream gets data within 5s', !!sseData, sseData ? sseData.replace(/\n/g, '\\n').slice(0, 100) : 'no data');

  console.log('\n=== 7. SUMMARY ===');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log('Total: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) {
    console.log('\nFailed:');
    for (const r of results.filter(r => !r.ok)) console.log('  - ' + r.name + ' [' + r.info + ']');
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('Audit crashed:', e); process.exit(2); });
