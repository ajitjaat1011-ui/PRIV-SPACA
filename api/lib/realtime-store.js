/** Durable realtime state and one-time WebAuthn challenges in the store. */

import { dbClient, dbEnsure } from './store.js';

export async function putWebAuthnChallenge({ id, userId, purpose, challenge, rpId, origin, expiresAt }) {
  await dbEnsure();
  const now = Date.now();
  await dbClient().batch([
    { sql: 'DELETE FROM ps_webauthn_challenges WHERE expires_at < ?', args: [now] },
    { sql: `INSERT INTO ps_webauthn_challenges (id, user_id, purpose, challenge, rp_id, origin, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: [id, userId, purpose, challenge, rpId, origin, expiresAt, now] },
  ], 'write');
}

/** Atomically consume a challenge before verification, preventing replay. */
export async function consumeWebAuthnChallenge({ id, userId, purpose }) {
  await dbEnsure();
  const now = Date.now();
  const c = dbClient();
  const rs = await c.execute({
    sql: 'DELETE FROM ps_webauthn_challenges WHERE id = ? AND user_id = ? AND purpose = ? AND expires_at >= ? RETURNING challenge, rp_id, origin',
    args: [id, userId, purpose, now],
  });
  const row = rs.rows?.[0];
  if (!row) return null;
  return { challenge: String(row.challenge), rpId: String(row.rp_id), origin: String(row.origin) };
}

export async function touchPresence(userId, at = Date.now()) {
  await dbEnsure();
  await dbClient().execute({
    sql: `INSERT INTO ps_presence (user_id, last_seen_at, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`,
    args: [userId, at, Date.now()],
  });
}

export async function readPresence(userIds, cutoff) {
  await dbEnsure();
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))].slice(0, 500);
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const rs = await dbClient().execute({
    sql: `SELECT user_id, last_seen_at FROM ps_presence WHERE user_id IN (${marks}) AND last_seen_at >= ?`,
    args: [...ids, cutoff],
  });
  return (rs.rows || []).map(r => ({ userId: String(r.user_id), at: Number(r.last_seen_at) }));
}

export async function setTypingState(roomId, userId, active, ttlMs = 8000) {
  await dbEnsure();
  const c = dbClient();
  if (!active) {
    await c.execute({ sql: 'DELETE FROM ps_typing_state WHERE room_id = ? AND user_id = ?', args: [roomId, userId] });
    return;
  }
  const now = Date.now();
  await c.execute({
    sql: `INSERT INTO ps_typing_state (room_id, user_id, expires_at, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(room_id, user_id) DO UPDATE SET expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
    args: [roomId, userId, now + Math.min(15000, Math.max(1000, ttlMs)), now],
  });
}

export async function readTypingState(roomId) {
  await dbEnsure();
  const now = Date.now();
  const c = dbClient();
  const rs = await c.execute({ sql: 'SELECT user_id, expires_at FROM ps_typing_state WHERE room_id = ? AND expires_at >= ?', args: [roomId, now] });
  return (rs.rows || []).map(r => ({ userId: String(r.user_id), until: Number(r.expires_at) }));
}
