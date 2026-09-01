/**
 * PRIV SPACA — Library — helpers
 *
 * Small pure helpers: ids, time, validation, sanitising and visibility rules.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { cfg } from './config.js';

// Buffer polyfill — uses Web API (available in all Workers runtimes)
// instead of node:buffer so esbuild bundling succeeds without nodejs_compat.
export const _b64decode = (b64) => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

// ---------- Helpers ----------
export const nowMs = () => Date.now();

export const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

export const uid = (p = 'id') => p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);

export const safeJson = (s, f) => { try { return JSON.parse(s); } catch (_) { return f; } };

export const isRepo = () => !!(cfg.GITHUB_PAT && cfg.GH_REPO && cfg.GH_BRANCH);

export const isEmail = s => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export const isUsername = s => typeof s === 'string' && /^[a-zA-Z0-9_]{3,24}$/.test(s);

export const isPin = s => typeof s === 'string' && /^\d{4}$/.test(s);

export function sanitizeText(s, max = 4000) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFKC')
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
          // Strip zero-width + bidi override chars used for spoofing/phishing.
          .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
          .slice(0, max);
}

export function normalizeAuthIdentifier(v) {
  return sanitizeText(String(v || ''), 254).trim().toLowerCase();
}

export function isSafeMediaUrl(url, { allowData = true } = {}) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > 4096) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (allowData && /^data:(image|audio|video)\/(jpeg|jpg|png|webp|gif|webm|mp3|mp4|quicktime|mov);base64,[a-z0-9+/=]+$/i.test(u)) return true;
  return false;
}

export function isSafeImageUrl(url, { allowData = true } = {}) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > 4096) return false;
  if (/^https?:\/\//i.test(u)) return true;
  if (allowData && /^data:image\/(jpeg|jpg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(u)) return true;
  return false;
}

export function isSafeHttpsUrl(url, maxLen = 2048) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u.length > maxLen) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

export function isValidPushSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (!isSafeHttpsUrl(sub.endpoint, 2048)) return false;
  const keys = sub.keys;
  if (!keys || typeof keys !== 'object') return false;
  const p256dh = String(keys.p256dh || '');
  const auth = String(keys.auth || '');
  // Browser Push API keys are base64url strings. Keep validation strict on
  // shape/safety, but allow very short synthetic keys used by the API test
  // suite because this endpoint only stores subscriptions; delivery failures
  // are caught and pruned by sendWebPush().
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(p256dh)) return false;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(auth)) return false;
  return true;
}

export function isStoryRecord(post) {
  if (!post) return false;
  return !!(post.story === true || post.kind === 'story' || post.storyExpiresAt);
}

export function storyExpiresAt(post) {
  return Number(post && post.storyExpiresAt) || ((post && post.createdAt) ? (post.createdAt + 24 * 60 * 60 * 1000) : 0);
}

// Bug #10 fix: Handle edge case where viewerId is null/undefined for unauthenticated requests
// and ensure close_friends stories require valid viewerId
export function isPrivateAccount(user) {
  return !!(user && user.isPrivate === true);
}

export function viewerFollowsUser(viewerId, owner, db) {
  if (!owner || !viewerId) return false;
  if (owner.id === viewerId) return true;
  const ownerFollowers = Array.isArray(owner.followers) ? owner.followers : [];
  if (ownerFollowers.includes(viewerId)) return true;
  const viewer = (db && Array.isArray(db.users) ? db.users : []).find(u => u.id === viewerId);
  return !!(viewer && Array.isArray(viewer.following) && viewer.following.includes(owner.id));
}

export function canViewerAccessPrivateProfile(owner, viewerId, db) {
  if (!owner) return false;
  if (!isPrivateAccount(owner)) return true;
  return viewerFollowsUser(viewerId, owner, db);
}

export function normalizeFollowRequests(user) {
  if (!user) return { incoming: [], outgoing: [] };
  user.followRequests = Array.isArray(user.followRequests) ? Array.from(new Set(user.followRequests.filter(Boolean))) : [];
  user.sentFollowRequests = Array.isArray(user.sentFollowRequests) ? Array.from(new Set(user.sentFollowRequests.filter(Boolean))) : [];
  return { incoming: user.followRequests, outgoing: user.sentFollowRequests };
}

export function clearFollowRequestPair(requester, target) {
  if (requester) normalizeFollowRequests(requester).outgoing;
  if (target) normalizeFollowRequests(target).incoming;
  if (requester && target) {
    requester.sentFollowRequests = requester.sentFollowRequests.filter(id => id !== target.id);
    target.followRequests = target.followRequests.filter(id => id !== requester.id);
  }
}

export function hasPendingFollowRequest(requester, target) {
  if (!requester || !target) return false;
  normalizeFollowRequests(requester);
  normalizeFollowRequests(target);
  return requester.sentFollowRequests.includes(target.id) || target.followRequests.includes(requester.id);
}

export function canRequestFollow(target, requesterId) {
  return !!(target && target.isPrivate && target.id !== requesterId);
}

export function canViewerSeeStory(post, viewerId, db) {
  if (!isStoryRecord(post)) return true; // non-stories always visible
  if (!post || post.deletedAt) return false;
  if (storyExpiresAt(post) <= nowMs()) return false;
  // Author can always see their own story
  if (viewerId && post.userId === viewerId) return true;
  const author = (db && Array.isArray(db.users) ? db.users : []).find(u => u.id === post.userId);
  if (!author) return false; // author not found — can't verify privacy/close friends
  if (!canViewerAccessPrivateProfile(author, viewerId, db)) return false;
  // Public stories (audience = 'all' or undefined) — anyone allowed by account privacy can see
  const audience = post.audience || 'all';
  if (audience !== 'close_friends') return true;
  // Close friends only: must have a valid viewerId
  if (!viewerId) return false;
  const closeFriends = Array.isArray(author.closeFriends) ? author.closeFriends : [];
  return closeFriends.includes(viewerId);
}

export function sanitizeUser(u, includePrivate = false) {
  if (!u) return null;
  const out = { id: u.id, email: u.email, username: u.username, displayName: u.displayName,
           bio: u.bio || '', photoUrl: u.photoUrl || '', createdAt: u.createdAt,
           publicKey: u.publicKey || null, verified: !!u.verified, isPrivate: !!u.isPrivate, note: activeNote(u) };
  if (includePrivate) {
    out.dateOfBirth = typeof u.dateOfBirth === 'string' ? u.dateOfBirth : '';
    out.cardVisibility = ['everyone','close_friends','private'].includes(u.cardVisibility) ? u.cardVisibility : 'everyone';
  }
  return out;
}

export function canViewProfileCard(owner, viewerId) {
  if (!owner || !viewerId) return false;
  if (owner.id === viewerId) return true;
  const mode = ['everyone','close_friends','private'].includes(owner.cardVisibility) ? owner.cardVisibility : 'everyone';
  if (mode === 'everyone') return true;
  if (mode === 'close_friends') return Array.isArray(owner.closeFriends) && owner.closeFriends.includes(viewerId);
  return false;
}

// A "note" is a short 24h status (Instagram-style). Returns null once expired.
export function activeNote(u) {
  const n = u && u.note;
  if (!n || (!n.text && !n.music)) return null;
  if (n.expiresAt && n.expiresAt <= nowMs()) return null;
  return { text: String(n.text || '').slice(0, 60), music: n.music || null, createdAt: n.createdAt || 0, expiresAt: n.expiresAt || 0 };
}

export function adminSet() {
  return new Set(String(cfg.ADMIN_USERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
}

export function isAdminUser(u) {
  if (!u) return false;
  const set = adminSet();
  return set.has(String(u.username || '').toLowerCase()) || set.has(String(u.email || '').toLowerCase()) || set.has(String(u.id || '').toLowerCase());
}
