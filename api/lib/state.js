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
  // v74/v75-turso-per-request-client-fix:
  //
  // v74 problem: `_turso` was a module-level singleton created once and reused
  // by every subsequent request handled by this Worker isolate. Cloudflare
  // Workers explicitly forbid reusing I/O objects (fetches, streams, and
  // anything that holds a reference to one) across different requests'
  // execution contexts — each incoming request gets its own context, and once
  // that context ends, any pending I/O tied to it is torn down.
  // @libsql/client's HttpClient keeps exactly this kind of cross-request state
  // internally: a lazily-resolving `_endpointPromise` for protocol negotiation
  // and a shared `promiseLimit` concurrency queue. Reusing the same HttpClient
  // instance across requests meant a later request could end up waiting on a
  // promise/queue slot that belonged to an earlier, possibly already-torn-down
  // request context. That is precisely what the Workers runtime was killing
  // (confirmed live via `wrangler pages deployment tail`: exceptions "Promise
  // will never complete" and "The Workers runtime canceled this request
  // because it detected that your Worker's code had hung...").
  //
  // v74 fix (creating a brand new client on every tursoClient() call) solved
  // the hangs, but overcorrected: many request handlers call tursoClient()
  // several times (e.g. fetchDatabase()'s 3-statement batch, then again later
  // in the same handler), and constructing a fresh HttpClient + its internal
  // promiseLimit() queue on every single call added enough CPU overhead under
  // load to trip Cloudflare's per-request CPU-time limit (confirmed live:
  // "error code: 1102" / exceededCpu on some requests).
  //
  // v75 fix: scope exactly ONE Turso client per incoming request using
  // AsyncLocalStorage (available via the nodejs_compat flag already set in
  // wrangler.toml). The very first middleware run for each request creates one
  // client and stores it in ALS; every tursoClient() call within that same
  // request's async call graph reuses that one instance; the next incoming
  // request gets an entirely fresh one. This keeps the safety property from
  // v74 (no I/O object ever crosses a request boundary) while restoring the
  // low per-request overhead of "create once, reuse within this request".
  _tursoReady: false,
  _tursoBootstrapped: false,
  // Cached ps_meta 'unread_epoch': messages older than this are treated as
  // already read, so shipping unread counts doesn't light up historic chats.
  _unreadEpoch: 0,
  // Set once ps_notifications has been confirmed/patched to have post_id +
  // comment_id, so the repair is attempted at most once per isolate.
  _notifColsHealed: false,
};
