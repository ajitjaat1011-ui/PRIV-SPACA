/**
 * PRIV SPACA — Library — rooms
 *
 * Room id normalisation and DM room keys.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { sanitizeText } from './helpers.js';

// ---------- Rooms ----------
// Bug #16 fix: Log warning when roomId is coerced to prevent silent failures
export function normalizeRoomId(roomId, currentUserId) {
  const raw = sanitizeText(String(roomId || 'general-group'), 160).trim();
  if (!raw || raw === 'general-group') return 'general-group';
  if (/^group:[a-zA-Z0-9_-]{1,64}$/.test(raw)) return raw;
  if (raw.startsWith('dm:')) {
    const parts = raw.slice(3).split(':').filter(Boolean);
    if (parts.length === 2 && parts.every(x => /^[a-zA-Z0-9_-]{1,96}$/.test(x))) {
      return 'dm:' + [...parts].sort().join(':');
    }
    // Invalid DM format
    console.warn('[normalizeRoomId] Invalid DM roomId format, coercing to general-group:', raw);
  } else if (raw !== 'general-group') {
    // Unrecognized format
    console.warn('[normalizeRoomId] Unrecognized roomId format, coercing to general-group:', raw);
  }
  return 'general-group';
}

export function dmRoomFor(a, b) { return 'dm:' + [a, b].sort().join(':'); }
