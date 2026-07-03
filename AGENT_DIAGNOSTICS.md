# PRIV SPACA — Agent Diagnostics System

This document describes the autonomous problem-detection system added so an
agent (or operator) can inspect user/system issues and start fixing them
without having to manually dig through logs.

## How it works

1. **Checks run automatically**
   - On Cloudflare Pages: a Cron Trigger runs every 5 minutes and executes the
     `scheduled` handler in `_worker.js`. Detected problems are stored in the
     Turso `ps_diagnostics` table.
   - On a real server/VM: `node scripts/monitor.js` runs continuously and writes
     problems to `data/diagnostics.json`.

2. **Checks detect things like**
   - Database unreachable / invalid
   - Orphaned posts, messages, or notifications
   - Users with repeated failed logins or lockouts
   - Unread notification backlogs (>50 unread)
   - Expired stories not cleaned up
   - Overdue scheduled messages
   - Stuck typing indicators
   - Stale RTC signals
   - Broken user records
   - Duplicate usernames/emails in structured Turso tables

3. **Agent/operator views problems**
   - Production (Cloudflare): `GET /api/diagnostics` (admin only) returns the
     unresolved problems from Turso.
   - Local/VM: read `data/diagnostics.json` directly.

## API endpoints

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| POST | `/api/report-issue` | public, rate-limited | Users/frontend can report a problem |
| POST | `/api/diagnostics/run` | admin | Manually run checks now |
| GET | `/api/diagnostics` | admin | List unresolved problems |
| POST | `/api/diagnostics/:id/resolve` | admin | Mark a problem resolved |

Query params for `GET /api/diagnostics`:
- `severity` — filter by `critical`, `error`, `warning`, `info` or `all`
- `limit` — max results (default 200, max 500)

## Files added/modified

- `api/diagnostics-lib.mjs` — shared check logic
- `api/cf-worker.js` — endpoints + Turso schema + scheduled-handler export
- `api/index.js` — same endpoints + schema for local Express dev
- `_worker.js` — `scheduled` handler that runs diagnostics on Cloudflare Cron
- `wrangler.toml` — Cron Trigger config (`*/5 * * * *`)
- `scripts/monitor.js` — continuous local monitor that writes to a file
- `data/.gitkeep` — directory for local diagnostics output
- `package.json` — `npm run monitor`
- `AGENT_DIAGNOSTICS.md` — this file

## Running the local monitor

```bash
# Requires the same Turso credentials used by the app
export TURSO_DATABASE_URL=libsql://...
export TURSO_AUTH_TOKEN=...

npm run monitor
# or
node scripts/monitor.js
```

The monitor writes `data/diagnostics.json`. The agent can read this file and
start working on the listed problems immediately.

## Running diagnostics manually

Cloudflare / production (admin token required):
```bash
curl -X POST https://priv-spaca.pages.dev/api/diagnostics/run \
  -H "Authorization: Bearer <admin-jwt>"

curl https://priv-spaca.pages.dev/api/diagnostics \
  -H "Authorization: Bearer <admin-jwt>"
```

Local dev server:
```bash
curl -X POST http://localhost:3000/api/diagnostics/run \
  -H "Authorization: Bearer <admin-jwt>"

curl http://localhost:3000/api/diagnostics \
  -H "Authorization: Bearer <admin-jwt>"
```

## Deployment notes

- The new `ps_diagnostics` table is created automatically by `tursoEnsure()` on
  the next DB operation, so no manual migration is needed.
- Cloudflare Cron Triggers may need to be enabled for the Pages project. The
  config in `wrangler.toml` tells Wrangler to register the cron.
- The GitHub repo is public; no secrets were added to committed files.
