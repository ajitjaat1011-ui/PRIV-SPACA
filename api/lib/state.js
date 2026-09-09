/**
 * PRIV SPACA — Isolate-local state
 *
 * Cross-request in-memory state for a single Worker isolate.
 * Held on one mutable `state` object because ES module bindings are read-only
 * when imported — `state.x = 1` works, `import { x }; x = 1` does not.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

export const state = {
  // ---------- In-memory cache + DB ----------
  localCache: {
  users: [], messages: [], scheduledMessages: [], posts: [], notifications: [],
  typing: {}, heartbeat: {}, rtcSignals: [],
},
  cacheTimestamp: 0,
  lastEphemeralWrite: 0,
  ghFileSha: null,
  // Per-request store client (ALS-scoped): each incoming request gets exactly
  // one store client created by the first middleware and reused throughout
  // that request's async call graph via AsyncLocalStorage (nodejs_compat in
  // wrangler.toml). I/O objects never cross request contexts, and the
  // create-once-per-request overhead is negligible.
  _dbReady: false,
  _dbBootstrapped: false,
  // Cached ps_meta 'unread_epoch': messages older than this are treated as
  // already read, so shipping unread counts doesn't light up historic chats.
  _unreadEpoch: 0,
  // Set once ps_notifications has been confirmed/patched to have post_id +
  // comment_id, so the repair is attempted at most once per isolate.
  _notifColsHealed: false,
};
