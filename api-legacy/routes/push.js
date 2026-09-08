/**
 * PRIV SPACA — Routes — push
 *
 * Web Push subscription management.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';
import { cfg } from '../lib/config.js';
import { fetchDatabase, saveDatabase } from '../lib/db.js';
import { isSafeHttpsUrl, isValidPushSubscription } from '../lib/helpers.js';
import * as S from '../lib/schemas.js';
import { body as vbody } from '../lib/validate.js';
import { requireAuth } from '../lib/middleware.js';

// ---------- Push (subscribe endpoints - actual delivery is no-op for now) ----------
app.get('/api/push/vapid-public', (c) => c.json({ key: cfg.VAPID_PUBLIC || '' }));

app.post('/api/push/subscribe', requireAuth, async (c) => {
  const body = await vbody(c, S.PushSubscribeBody);
  const { subscription } = body;
  if (!isValidPushSubscription(subscription)) return c.json({ error: 'Invalid subscription' }, 400);
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!u) return c.json({ error: 'Not found' }, 404);
  u.pushSubs = u.pushSubs || [];
  const i = u.pushSubs.findIndex(s => s.endpoint === subscription.endpoint);
  if (i >= 0) u.pushSubs[i] = subscription; else u.pushSubs.push(subscription);
  if (u.pushSubs.length > 5) u.pushSubs = u.pushSubs.slice(-5);
  await saveDatabase(db, false);
  return c.json({ ok: true, devices: u.pushSubs.length });
});

app.post('/api/push/unsubscribe', requireAuth, async (c) => {
  const { endpoint } = await vbody(c, S.PushUnsubscribeBody);
  if (!isSafeHttpsUrl(endpoint, 2048)) return c.json({ error: 'Invalid endpoint' }, 400);
  const db = await fetchDatabase();
  const u = db.users.find(x => x.id === c.get('userId'));
  if (!u) return c.json({ error: 'Not found' }, 404);
  u.pushSubs = (u.pushSubs || []).filter(s => s.endpoint !== endpoint);
  await saveDatabase(db, false);
  return c.json({ ok: true });
});
