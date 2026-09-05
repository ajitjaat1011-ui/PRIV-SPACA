/**
 * PRIV SPACA — Routes — stream
 *
 * Server-sent events stream and stream tokens.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { cfg } from '../lib/config.js';
import { b64url, b64urlJson, hmacSha256, verifyToken } from '../lib/auth.js';
import { loadConfig } from '../lib/config.js';
import { fetchPrimaryDatabase } from '../lib/db.js';
import { _eventQueues, _eventSubscribers } from '../lib/events.js';
import { requireAuth } from '../lib/middleware.js';
import { isTursoPrimary, tursoClient, tursoEnsure } from '../lib/store-turso.js';
import { supervisedTask } from '../lib/omni-engine.js';

// ---------- GetStream.io integration endpoints ----------
app.get('/api/stream/config', (c) => {
  if (c.env) loadConfig(c.env);
  const apiKey = cfg.STREAM_API_KEY || (c.env && c.env.STREAM_API_KEY) || null;
  const appId = cfg.STREAM_APP_ID || (c.env && c.env.STREAM_APP_ID) || null;
  const apiSecret = cfg.STREAM_API_SECRET || (c.env && c.env.STREAM_API_SECRET) || null;
  return c.json({
    enabled: !!(apiKey && apiSecret),
    apiKey: apiKey || null,
    appId: appId || null
  });
});

app.get('/api/stream/token', requireAuth, async (c) => {
  if (c.env) loadConfig(c.env);
  const apiKey = cfg.STREAM_API_KEY || (c.env && c.env.STREAM_API_KEY) || null;
  const appId = cfg.STREAM_APP_ID || (c.env && c.env.STREAM_APP_ID) || null;
  const apiSecret = cfg.STREAM_API_SECRET || (c.env && c.env.STREAM_API_SECRET) || null;
  if (!apiKey || !apiSecret) {
    return c.json({ error: 'GetStream API credentials are not configured on this server.' }, 501);
  }
  const myId = c.get('userId');
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = b64urlJson({ user_id: String(myId) });
  const signingInput = header + '.' + payload;
  const signature = b64url(await hmacSha256(apiSecret, signingInput));
  const token = signingInput + '.' + signature;
  return c.json({ token, userId: myId, apiKey, appId });
});

// ---------- SSE stream — real streaming on Workers using ReadableStream ----------
app.get('/api/stream', async (c) => {
  const token = c.req.query('token') || (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return c.text('', 401);
  let payload;
  try { payload = await verifyToken(token); } catch (_) { return c.text('', 401); }
  const authDb = await fetchPrimaryDatabase();
  const authUser = (authDb.users || []).find(u => u.id === payload.uid);
  if (!authUser || Number(payload.sv || 0) !== Number(authUser.tokenVersion || 0)) return c.text('', 401);
  const userId = payload.uid;
  const lastEventId = c.req.header('last-event-id') || c.req.query('lastEventId') || null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (text) => { try { controller.enqueue(encoder.encode(text)); } catch (_) {} };
      send(': connected\n\n');
      // Flush any queued events
      const queue = _eventQueues.get(userId) || [];
      let startIdx = 0;
      if (lastEventId) {
        const i = queue.findIndex(e => e.id === lastEventId);
        if (i >= 0) startIdx = i + 1;
      }
      for (let i = startIdx; i < queue.length; i++) {
        const e = queue[i];
        send(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      // Register as live subscriber
      const sub = { closed: false, write: send };
      if (!_eventSubscribers.has(userId)) _eventSubscribers.set(userId, new Set());
      _eventSubscribers.get(userId).add(sub);
      const heartbeat = setInterval(() => { try { send(': ping\n\n'); } catch (_) {} }, 10000);
      let lastSeenTs = Date.now() - 1500;
      const sentIds = new Set();
      const primaryPoller = isTursoPrimary() ? setInterval(async () => {
        if (sub.closed) return;
        try {
          let rows = [];
          await tursoEnsure();
          const rs = await tursoClient().execute({
            sql: `SELECT id, kind, data, created_at FROM ps_events
                  WHERE (user_id = ? OR user_id = ?) AND created_at > ?
                  ORDER BY created_at ASC LIMIT 30`,
            args: [userId, '__ALL__', lastSeenTs],
          });
          rows = rs.rows || [];
          for (const r of rows || []) {
            const ts = Number(r.created_at);
            if (ts > lastSeenTs) lastSeenTs = ts;
            if (!sentIds.has(r.id)) {
              sentIds.add(r.id);
              // Normalize data format: _pushEvent stores { id, ts, kind, data: <payload> }
              // while RTC signal handler stores { id, createdAt, fromId, author, signal }.
              // The client's handleRealtimeEvent expects evt.data to contain the actual
              // payload. Wrap raw payloads so the format is consistent.
              let parsed;
              try { parsed = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {}); } catch { parsed = {}; }
              const sseEvt = (parsed && typeof parsed.data === 'object') ? parsed : {
                id: r.id,
                ts: ts || Date.now(),
                kind: r.kind,
                data: parsed,
              };
              send(`id: ${r.id}\nevent: ${r.kind}\ndata: ${JSON.stringify(sseEvt)}\n\n`);
            }
          }
          if (Math.random() < 0.03) {
            const oldTs = Date.now() - 300_000;
            supervisedTask(c, tursoClient().execute({
              sql: 'DELETE FROM ps_events WHERE created_at < ?', args: [oldTs],
            }), 'stream.event-cleanup');
          }
        } catch (e) { console.warn('[SSE primaryPoller] error:', e && e.message); }
      }, 1500) : null;
      const autoclose = setTimeout(() => cleanup(), 24000);
      function cleanup() {
        if (sub.closed) return;
        sub.closed = true;
        clearInterval(heartbeat);
        if (primaryPoller) clearInterval(primaryPoller);
        clearTimeout(autoclose);
        const set = _eventSubscribers.get(userId);
        if (set) { set.delete(sub); if (set.size === 0) _eventSubscribers.delete(userId); }
        try { controller.close(); } catch (_) {}
      }
      c.req.raw.signal.addEventListener('abort', cleanup);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
