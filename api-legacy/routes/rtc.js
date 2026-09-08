/**
 * PRIV SPACA — Routes — rtc
 *
 * WebRTC signalling for voice/video calls.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { fetchDatabase, isPersist, saveDatabaseVerified } from '../lib/db.js';
import { _pushEvent } from '../lib/events.js';
import { nowMs, sanitizeText, uid } from '../lib/helpers.js';
import * as S from '../lib/schemas.js';
import { body as vbody } from '../lib/validate.js';
import { requireAuth } from '../lib/middleware.js';
import { dedupeRtcSignals, normalizeRtcSignalRow } from '../lib/rtc.js';
import { isTursoConfigured, tursoClient } from '../lib/store-turso.js';
import { getOmniContext, supervisedTask } from '../lib/omni-engine.js';

app.post('/api/rtc/signal', requireAuth, async (c) => {
  const body = await vbody(c, S.RtcSignalBody);
  const { targetId, signal } = body;
  if (typeof targetId !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(targetId) || !signal || typeof signal !== 'object') return c.json({ error: 'Missing data' }, 400);
  const signalType = sanitizeText(signal.type || '', 24);
  if (!['offer','answer','candidate','end','reject','busy'].includes(signalType)) return c.json({ error: 'Invalid signal' }, 400);
  if (JSON.stringify(signal).length > 20000) return c.json({ error: 'Signal too large' }, 413);
  const myId = c.get('userId');
  if (targetId === myId) return c.json({ error: 'Invalid target' }, 400);
  const db = await fetchDatabase();
  const target = db.users.find(u => u.id === targetId);
  if (!target) return c.json({ error: 'Target not found' }, 404);
  // SECURITY: mutual block check — a blocked user must not be able to call-bomb
  // the blocker with RTC offers.
  const me = db.users.find(u => u.id === myId);
  if (me && Array.isArray(me.blocked) && me.blocked.includes(targetId)) return c.json({ error: 'Cannot call this user' }, 403);
  if (Array.isArray(target.blocked) && target.blocked.includes(myId)) return c.json({ error: 'Cannot call this user' }, 403);
  const author = me ? { id: me.id, username: me.username, displayName: me.displayName, photoUrl: me.photoUrl || '' } : { id: myId, displayName: 'Member', username: 'member' };
  const payload = { fromId: myId, author, signal };
  const now = nowMs();
  // persist:false — the canonical ps_events row is written below in the ONE
  // flat shape the client understands. See the note above _pushEvent().
  _pushEvent(targetId, 'rtc_signal', payload, { persist: false });

  if (isTursoConfigured()) {
    const rtcId = uid('rtc');
    const fullRow = { id: rtcId, createdAt: now, signalType, correlationId: getOmniContext()?.correlationId || null, ...payload };
    // A silently-dropped INSERT here is exactly the "caller rings forever,
    // callee never sees the popup" failure, so retry once and then tell the
    // caller the truth (503) instead of a fake { ok: true }.
    let wrote = await tursoClient().execute({
      sql: 'INSERT INTO ps_events (id, user_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [rtcId, targetId, 'rtc_signal', JSON.stringify(fullRow), now]
    }).then(() => true).catch(e => { console.warn('[rtc] event insert failed:', e && e.message); return false; });
    if (!wrote) {
      wrote = await tursoClient().execute({
        sql: 'INSERT INTO ps_events (id, user_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        args: [rtcId, targetId, 'rtc_signal', JSON.stringify(fullRow), now]
      }).then(() => true).catch(e => { console.warn('[rtc] event insert retry failed:', e && e.message); return false; });
    }
    if (Math.random() < 0.1) {
      supervisedTask(c, tursoClient().execute({
        sql: 'DELETE FROM ps_events WHERE created_at < ? AND kind = ?',
        args: [now - 60000, 'rtc_signal'],
      }), 'rtc.event-cleanup');
    }
    if (!wrote) return c.json({ error: 'Call signal storage unavailable. Please retry.' }, 503);
    return c.json({ ok: true });
  }

  db.rtcSignals = Array.isArray(db.rtcSignals) ? db.rtcSignals : [];
  if (signalType === 'end' || signalType === 'reject' || signalType === 'busy') {
    db.rtcSignals = db.rtcSignals.filter(x => !( (x.targetId === targetId && x.payload?.fromId === myId) || (x.targetId === myId && x.payload?.fromId === targetId) ));
  }
  const expiresAt = now + (signalType === 'offer' ? 20000 : 60000);
  db.rtcSignals.push({ id: uid('rtc'), targetId, payload, createdAt: now, expiresAt });
  if (db.rtcSignals.length > 200) db.rtcSignals = db.rtcSignals.slice(-200);
  const persisted = await saveDatabaseVerified(db, d => (d.rtcSignals || []).some(x => x.id === db.rtcSignals[db.rtcSignals.length - 1].id));
  if (isPersist() && !persisted) return c.json({ error: 'Call signal storage unavailable. Please retry.' }, 503);
  return c.json({ ok: true });
});

app.get('/api/rtc/signals', requireAuth, async (c) => {
  const since = Number(c.req.query('since') || 0) || 0;
  const myId = c.get('userId');
  const now = nowMs();

  if (isTursoConfigured()) {
    const rs = await tursoClient().execute({
      sql: 'SELECT id, data, created_at FROM ps_events WHERE user_id = ? AND kind = ? AND created_at > ? AND created_at >= ? ORDER BY created_at ASC LIMIT 50',
      args: [myId, 'rtc_signal', since, now - 45000]
    }).catch(() => ({ rows: [] }));
    const signals = dedupeRtcSignals(
      (rs.rows || []).map(r => normalizeRtcSignalRow(r.id, r.created_at, r.data)).filter(Boolean)
    );
    return c.json({ signals, now });
  }

  const db = await fetchDatabase();
  db.rtcSignals = Array.isArray(db.rtcSignals) ? db.rtcSignals.filter(x => !x.expiresAt || x.expiresAt > now) : [];
  let signals = dedupeRtcSignals(db.rtcSignals
    .filter(x => x.targetId === myId && (x.createdAt || 0) > since && (now - (x.createdAt || 0) <= 45000))
    .sort((a,b) => (a.createdAt||0) - (b.createdAt||0))
    .slice(-30)
    .map(x => normalizeRtcSignalRow(x.id, x.createdAt, x.payload))
    .filter(Boolean));
  return c.json({ signals, now });
});
