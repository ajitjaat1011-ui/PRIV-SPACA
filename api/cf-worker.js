/**
 * PRIV SPACA — Cloudflare Pages / Workers API entry point.
 *
 * This file is deliberately thin: it wires the modular Hono API together and
 * exports the app. All real logic lives in api/lib/** and api/routes/**.
 *
 * ARCHITECTURE
 * ------------
 *   lib/app.js        the shared Hono instance (own module = no import cycles)
 *   lib/config.js     `cfg` — runtime config refreshed per request from env
 *   lib/state.js      `state` — isolate-local caches
 *   lib/helpers.js    pure helpers (ids, time, validation, visibility rules)
 *   lib/schema.js     DB normalisation, merging, retention scheduler
 *   lib/store-turso.js / lib/store-github.js   storage backends
 *   lib/db.js         persistence facade used by routes
 *   lib/auth.js       JWT + crypto primitives
 *   lib/middleware.js requireAuth / requireAdmin
 *   lib/ratelimit.js  rate limiting + login lockout
 *   lib/events.js     in-memory pub/sub for SSE
 *   lib/push.js       Web Push (VAPID + RFC 8291)
 *   lib/rooms.js lib/media.js lib/rtc.js lib/feed.js   feature helpers
 *   routes/*.js       one module per API area; each imports the shared `app`
 *
 * Modules are layered so the dependency graph is acyclic:
 *   config/state -> helpers -> schema -> stores -> db -> middleware -> routes
 *
 * ORDER MATTERS (do not reorder casually):
 *   1. register-middleware.js must be imported BEFORE any route module —
 *      Hono composes handlers in registration order, so middleware registered
 *      after a route would never wrap that route.
 *   2. routes/misc.js must be imported LAST — it holds the `/api/*` 404
 *      catch-all, which would otherwise shadow every route defined after it.
 *
 * Required compatibility flag: nodejs_compat (AsyncLocalStorage).
 *
 * Soft-delete: posts, messages and users are marked with `deletedAt` instead
 * of being removed, filtered out of normal queries, restorable for 30 days
 * and purged after that by the scheduler in lib/schema.js.
 */

import { app } from './lib/app.js';

// 1. Global middleware — MUST come before routes.
import './lib/register-middleware.js';

// 2. Feature routes.
import './routes/auth.js';
import './routes/media.js';
import './routes/users.js';
import './routes/messages.js';
import './routes/notifications.js';
import './routes/posts.js';
import './routes/rtc.js';
import './routes/stream.js';
import './routes/push.js';

// 3. Catch-all 404 — MUST be imported last.
import './routes/misc.js';

export default app;
