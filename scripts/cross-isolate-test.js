// Simulate two users on potentially different isolates by making them both
// subscribe to SSE and check if events flow in real-time
const BASE = 'https://priv-spaca.pages.dev';
async function api(p, opts = {}) {
  const res = await fetch(BASE + '/api' + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  let d = null; try { d = await res.json(); } catch (_) {}
  return { status: res.status, data: d };
}

async function readSSE(token, onEvent, maxMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), maxMs);
  try {
    const r = await fetch(BASE + '/api/stream?token=' + token, { signal: ctrl.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        onEvent(block);
      }
    }
  } catch (e) {
    // expected on abort
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  const r1 = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'Arvind_1011', password: 'TestPass123!' }) });
  const r2 = await api('/auth/login', { method: 'POST', body: JSON.stringify({ identifier: 'Anushka_1011', password: 'TestPass123!' }) });
  const t1 = r1.data.token, u1 = r1.data.user;
  const t2 = r2.data.token, u2 = r2.data.user;

  // Open SSE for user2
  let user2GotOffer = null;
  let user2GotAnswer = null;
  const ssePromise = readSSE(t2, (block) => {
    if (block.includes('event: rtc_signal')) {
      const m = block.match(/data: (.*?)(?:\n|$)/);
      if (m) {
        try {
          const obj = JSON.parse(m[1]);
          const kind = obj.data?.signal?.type;
          if (kind === 'offer') user2GotOffer = Date.now();
          if (kind === 'answer') user2GotAnswer = Date.now();
        } catch (_) {}
      }
    }
  }, 10000);

  // Wait a bit for SSE to connect
  await new Promise(r => setTimeout(r, 1500));

  // User1 sends offer via REST (not via _pushEvent on user1's session)
  const t0 = Date.now();
  await api('/rtc/signal', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + t1 },
    body: JSON.stringify({ targetId: u2.id, signal: { type: 'offer', offer: { type: 'offer', sdp: 'v=0\nfake' }, video: false } })
  });
  console.log('Offer sent at t+0');

  // Wait for SSE to deliver
  await new Promise(r => setTimeout(r, 5000));

  console.log('User2 got offer via SSE?', !!user2GotOffer, user2GotOffer ? `(+${user2GotOffer - t0}ms)` : '');
  console.log('User2 got answer via SSE?', !!user2GotAnswer, user2GotAnswer ? `(+${user2GotAnswer - t0}ms)` : '');

  await ssePromise;
  process.exit(user2GotOffer ? 0 : 1);
})();
