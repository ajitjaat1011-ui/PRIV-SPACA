# PRIV SPACA

**Live:** https://priv-spaca.pages.dev

A private Instagram/WhatsApp-hybrid PWA: vanilla-JS frontend + a Hono API running
on Cloudflare Pages (advanced mode `_worker.js`), with Turso/libSQL storage.

## Layout

```
index.html  app.js  style.css      frontend sources (edit these)
app.min.js  style.min.css          what the browser actually loads (generated)
sw.js                              service worker / offline shell
_worker.js                         Pages entry: /api/* -> Hono, everything else -> static
api/cf-worker.js                   API entry point — wires the modules together
api/lib/**                         backend libraries (see below)
api/routes/**                      one module per API area
scripts/dev-server.mjs             local dev server (runs the real worker)
scripts/build.mjs                  minify + version bump
scripts/check.mjs                  repo sanity checks
```

### Backend modules

`api/cf-worker.js` is a thin entry point. Real code lives in layered modules
with an acyclic dependency graph:

```
config / state  ->  helpers  ->  schema  ->  stores  ->  db  ->  middleware  ->  routes
```

| Module | Responsibility |
|---|---|
| `lib/app.js` | the shared Hono instance (own module so nothing imports in a cycle) |
| `lib/config.js` | `cfg` object, refreshed from `env` on every request |
| `lib/state.js` | `state` object — isolate-local caches |
| `lib/helpers.js` | ids, time, validation, sanitising, visibility rules |
| `lib/schema.js` | DB normalisation, merging, retention scheduler |
| `lib/store-turso.js` / `lib/store-github.js` | storage backends |
| `lib/db.js` | persistence facade used by routes |
| `lib/auth.js` | JWT + HMAC/base64url primitives |
| `lib/middleware.js` | `requireAuth`, `requireAdmin` |
| `lib/ratelimit.js` | rate limiting + login lockout |
| `lib/events.js` | in-memory pub/sub behind SSE |
| `lib/push.js` | Web Push (VAPID ES256 + RFC 8291) |
| `lib/rooms.js` `lib/media.js` `lib/rtc.js` `lib/feed.js` | feature helpers |

Config and isolate state are plain objects (`cfg.X`, `state.X`) rather than bare
`let` exports, because ES module bindings are read-only for importers — a route
in another file could not assign to them otherwise.

Two ordering rules are enforced by `npm run check`:

1. `lib/register-middleware.js` is imported **before** any route module — Hono
   composes handlers in registration order.
2. `routes/misc.js` is imported **last** — it holds the `/api/*` 404 catch-all,
   which would otherwise shadow every route registered after it.

## Run locally

```bash
npm install
npm run dev            # http://localhost:8787 — API + static files
```

The dev server runs the **same** Hono app as production, so local behaviour
matches Cloudflare. Without `TURSO_*` set it uses in-memory storage.

```bash
# against real data
TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... JWT_SECRET=... npm run dev
```

## Checks, build, deploy

```bash
npm run check          # versions, bundle, route table, dependencies
npm run build          # minify css/js
npm run build -- --bump   # bump versions, then minify
npm run deploy         # wrangler pages deploy
```

### Versioning — the rule that matters

`APP_VERSION` (app.js) and `SW_VERSION` (sw.js) **must be the same string**.
The client compares them on every load; a mismatch wipes caches, unregisters
the service worker and reloads forever. `scripts/build.mjs --bump` keeps
`app.js`, `sw.js` and `index.html` in sync, and `npm run check` fails the build
if they ever drift.

## Environment variables

Set these as **encrypted Cloudflare Pages secrets**, never in `wrangler.toml`.

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | HMAC secret for JWTs. The API refuses to serve `/api/*` in production without it. |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Primary datastore. |
| `GITHUB_PAT`, `GH_REPO`, `GH_BRANCH`, `GH_FILE` | Fallback `db.json` store. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push. |
| `CLOUDINARY_*` | Optional faster media uploads. |
| `ADMIN_USERS`, `OWNER_EMAIL`, `OWNER_USERNAME` | Admin identification. |
| `APP_MIN_VERSION` | Reject clients older than this version (force refresh). |

Storage precedence: Turso → GitHub `db.json` → in-memory.

## Features

- JWT auth, signup/login, 4-digit PIN recovery, account lockout
- Group chat + private DMs, replies, images, voice notes, scheduled messages
- Disappearing messages and secret chat, soft-delete with 30-day restore
- Social feed: posts, likes, comments, stories with view analytics
- Follow/unfollow, follow requests for private accounts, blocking, close friends
- Live typing indicators, presence heartbeat, SSE event stream
- WebRTC voice/video signalling, Web Push notifications
- Installable PWA with offline shell
