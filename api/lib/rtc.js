/**
 * PRIV SPACA — Library — rtc
 *
 * WebRTC signal row normalisation and dedupe.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { nowMs } from './helpers.js';

/**
 * Normalize a ps_events row into the ONE flat shape the client's
 * handleRTCSignal() understands: { id, createdAt, fromId, author, signal }.
 *
 * Historically two shapes could land in ps_events for the same signal:
 *   flat      -> { id, createdAt, fromId, author, signal }
 *   envelope  -> { id, ts, kind: 'rtc_signal', data: { fromId, author, signal } }
 * Spreading the envelope shape produced a payload with no top-level `signal`,
 * which the client silently dropped => callee never rang. Always unwrap.
 */
export function normalizeRtcSignalRow(rowId, createdAt, rawData) {
  let obj;
  try { obj = typeof rawData === 'string' ? JSON.parse(rawData) : (rawData || null); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  // Unwrap _pushEvent-style envelopes (possibly nested more than once).
  let guard = 0;
  while (obj && !obj.signal && obj.data && typeof obj.data === 'object' && guard++ < 4) obj = obj.data;
  if (!obj || !obj.signal || typeof obj.signal !== 'object') return null;
  return {
    id: rowId,
    createdAt: Number(createdAt) || nowMs(),
    fromId: obj.fromId || (obj.author && obj.author.id) || '',
    author: obj.author || null,
    signal: obj.signal,
  };
}

// Two rows can still describe the same signal (e.g. a client retry after a
// 503, or legacy duplicate rows already in ps_events). Collapse them so the
// callee doesn't process the same offer/answer twice.
export function dedupeRtcSignals(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const sig = s.signal || {};
    const finger = JSON.stringify(sig.offer || sig.answer || sig.candidate || sig.type || '').slice(0, 200);
    const key = (s.fromId || '') + '|' + (sig.type || '') + '|' + finger;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
