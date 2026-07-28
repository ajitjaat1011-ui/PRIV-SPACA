#!/usr/bin/env node
/**
 * Live end-to-end RTC signalling probe.
 *
 * Reproduces the reported bug: "user A sees the calling screen but user B
 * never gets the incoming-call popup".
 *
 * Usage: node scripts/rtc-live-test.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'https://priv-spaca.pages.dev';

const fails = [];
function check(name, ok, detail = '') {
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ` -- ${detail}` : ''));
  if (!ok) fails.push(name);
}

async function req(path, { method = 'GET', token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-App-Version': 'priv-spaca-v104',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

function rnd() {
  const s = Math.random().toString(36).slice(2, 8);
  return { username: `rtc${s}`, email: `rtc${s}@example.com` };
}

async function signup() {
  const { username, email } = rnd();
  const r = await req('/api/auth/signup', {
    method: 'POST',
    body: {
      username, email, displayName: username,
      password: 'pw123456', pin: '7391',
      termsAccepted: true, termsVersion: 1,
    },
  });
  if (r.status !== 200 || !r.json?.token) {
    throw new Error(`signup failed ${r.status} ${r.text.slice(0, 400)}`);
  }
  return { token: r.json.token, id: r.json.user.id, username };
}

(async () => {
  console.log('BASE =', BASE);

  const health = await req('/api/health');
  check('GET /api/health 200', health.status === 200, JSON.stringify(health.json || health.text.slice(0, 200)));
  console.log('    health:', JSON.stringify(health.json));

  const A = await signup();
  const B = await signup();
  console.log(`    A=${A.username} (${A.id})`);
  console.log(`    B=${B.username} (${B.id})`);

  // Baseline: B polls
  const base = await req('/api/rtc/signals?since=0', { token: B.token });
  check('GET /api/rtc/signals 200', base.status === 200, String(base.status));
  const serverNow = base.json?.now || 0;
  check('server returns now', serverNow > 0, String(serverNow));
  const skew = Date.now() - serverNow;
  console.log(`    client-vs-server clock skew: ${skew}ms`);

  // A -> B offer
  const offer = { type: 'offer', offer: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nfake-sdp' }, video: false };
  const sent = await req('/api/rtc/signal', { method: 'POST', token: A.token, body: { targetId: B.id, signal: offer } });
  check('POST /api/rtc/signal (offer) ok', sent.status === 200 && sent.json?.ok === true, `${sent.status} ${sent.text.slice(0, 300)}`);

  // Poll from since=0 (the reliable case)
  let got = await req('/api/rtc/signals?since=0', { token: B.token });
  let sigs = got.json?.signals || [];
  check('B receives offer with since=0', sigs.length >= 1, `count=${sigs.length} body=${got.text.slice(0, 300)}`);
  if (sigs[0]) {
    console.log('    signal keys:', Object.keys(sigs[0]).join(','));
    check('signal has fromId', sigs[0].fromId === A.id, String(sigs[0].fromId));
    check('signal has author', !!sigs[0].author, JSON.stringify(sigs[0].author || null));
    check('signal has createdAt', !!sigs[0].createdAt, String(sigs[0].createdAt));
    check('signal.signal.type === offer', sigs[0].signal?.type === 'offer', JSON.stringify(sigs[0].signal?.type));
  }

  // *** This is the client's real behaviour: since = Date.now() - 5000 ***
  const clientSince = Date.now() - 5000;
  const got2 = await req('/api/rtc/signals?since=' + clientSince, { token: B.token });
  const sigs2 = got2.json?.signals || [];
  check('B receives offer with since=clientClock-5s (real client behaviour)', sigs2.length >= 1,
    `count=${sigs2.length} since=${clientSince} serverNow=${got2.json?.now} skew=${Date.now() - (got2.json?.now || 0)}`);

  // Retry poll several times to detect flakiness / isolate issues
  let hits = 0;
  for (let i = 0; i < 6; i++) {
    const r = await req('/api/rtc/signals?since=0', { token: B.token });
    if ((r.json?.signals || []).length >= 1) hits++;
    await new Promise(r2 => setTimeout(r2, 700));
  }
  check('poll is stable across 6 attempts', hits === 6, `${hits}/6 polls saw the offer`);

  // 'end' should clear
  const ended = await req('/api/rtc/signal', { method: 'POST', token: A.token, body: { targetId: B.id, signal: { type: 'end' } } });
  check('POST end ok', ended.status === 200, String(ended.status));

  console.log('\n' + (fails.length ? `FAILURES (${fails.length}): ${fails.join(', ')}` : 'ALL PASS'));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
