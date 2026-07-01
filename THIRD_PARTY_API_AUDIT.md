# PRIV-SPACA — Third-Party API Audit & Backlog Review

_Date: 2026-07-01 · Auditor: Arena Agent · Reference: https://github.com/public-apis/public-apis_

## 1. Current app state (verified)

- **Production backend:** `api/cf-worker.js` (Hono) served via `_worker.js` Advanced-Mode on Cloudflare Pages.
- **Persistence (LIVE, verified via `GET /api/diag`):** `neon-postgres` — 26 users, `canRead: true`, `canWrite: true`.
  GitHub-as-JSON storage is **already retired as primary**; it remains only as a fallback branch (`isNeonConfigured()` short-circuits every read/write to Neon first). No further action needed to "retire GitHub-JSON storage" — Neon is authoritative in prod.
- **Stories overhaul (commit `4e05529`) intact:** `pw_story_test.py` → all 23 checks PASS against the local dev harness.

## 2. Third-party APIs in use — live audit

Each candidate was verified with a **real live request** (per task requirement).

| API | Where | Purpose | Live check | Verdict |
|-----|-------|---------|-----------|---------|
| **iTunes Search API** (`itunes.apple.com/search`) | `app.js` story music picker | 30s song previews + artwork | ✅ `200`, returned `previewUrl` + `artworkUrl100` for real tracks | **KEEP** — free, no key, high-quality, exactly fits the story-music use case. `public-apis` lists no better keyless music-preview source. |
| **tmpfiles.org** (`/api/v1/upload`) | `app.js` `uploadToTmpfiles` (ephemeral image fallback) | Temp image host | ✅ `200`, `/dl/` URL serves raw `image/png` | **KEEP as fallback only.** Ephemeral (files expire ~1h) and unauthenticated — fine as a last-resort fallback, unsuitable as primary. |
| **GitHub Contents API** (`raw.githubusercontent.com`) | `cf-worker.js` `/api/upload-photo` | **Primary** durable media host | ✅ working | **REPLACE when possible** — see §3. This is the biggest architectural weakness. |
| **Pixabay CDN** (`cdn.pixabay.com`) | `app.js` `storyMusicCatalog` | Bundled royalty-free preset tracks | ✅ static CDN | KEEP — static assets, low risk. |

### `public-apis` cross-check
- For media hosting the community list points to provider object stores (Cloudflare R2, imgbb, Cloudinary). **Cloudflare R2 / Images is the correct upgrade** since the app already runs on Cloudflare Pages — same account, zero egress fees, first-class Worker bindings.

## 3. Biggest architectural upgrade: GitHub media → Cloudflare R2/Images

**Recommended, but BLOCKED by credentials in this environment.**

Diagnosis performed live with the provided Cloudflare token:
- `GET /user/tokens/verify` → `valid and active`.
- `GET /accounts/{acct}/r2/buckets` → **`Authentication error` (code 10000)**.
- `GET /accounts/{acct}/images/v1/stats` → **`Authentication error` (code 10000)**.
- `GET /accounts/{acct}/pages/projects/priv-spaca` → OK; project has **no `r2_buckets`, `kv_namespaces`, or `d1_databases` bindings**.

➡️ The supplied token is **Pages-scoped only**. Provisioning an R2 bucket or Images plan, and adding the Pages binding, cannot be done with these credentials. This is a **hard blocker**, not a code problem.

### What is needed to unblock (owner action)
1. Create an R2 bucket (e.g. `priv-spaca-media`) + a token with `R2 Read/Write`.
2. Add the R2 binding to the Pages project (`MEDIA` → bucket).
3. Optionally attach a public `r2.dev` domain or a custom domain for CDN reads.

### Migration design (ready to implement once unblocked)
`/api/upload-photo` in `cf-worker.js` would branch to R2 first:
```
if (env.MEDIA) {                      // R2 bucket binding
  await env.MEDIA.put(path, bytes, { httpMetadata: { contentType } });
  return { url: `${PUBLIC_MEDIA_BASE}/${path}`, persisted: true };
}
// else fall back to current GitHub Contents API path (unchanged)
```
Frontend needs **no change** — it already consumes `{ url, persisted }`.
Benefits: no repo bloat/commit churn, no GitHub API rate limits, proper cache headers, cheaper + faster CDN reads.

## 4. Backlog status this pass

| Item | Status |
|------|--------|
| Fix missing `GET /api/rtc/signals` parity in `api/index.js` | ✅ **DONE** — added GET route + durable `rtcSignals` store + terminal-signal cleanup in POST, mirroring `cf-worker.js`. New `rtc_parity_test.py` proves POST→poll round-trip (11 checks PASS). |
| Verify Neon Postgres in prod / retire GitHub-JSON storage | ✅ **VERIFIED** — Neon is authoritative in prod; GitHub-JSON already demoted to fallback. |
| Move GitHub-as-storage → R2/Images | ⚠️ **BLOCKED** on Pages-only token (see §3). Design documented & ready. |
| Video/GIF stories | Deferred — large viewer+editor+backend change; scoped for a follow-up pass to avoid regressing the just-shipped Stories overhaul. |
| Rate limiting / realtime architecture | Reviewed — in-memory per-IP buckets + SSE with Neon-backed poll fallback are sound for current scale. No change without KV/Durable Objects (also blocked by token scope). |
| Feed image resize/performance | Reviewed — `resizeImageToDataUrl` already uses `createImageBitmap` off-main-thread w/ legacy fallback; healthy. |
| Feed virtualization | Not a clear win at current post volume; skipped per "only if clear win". |

## 5. Verification performed
- `node --check` on all changed JS: **pass**.
- `pw_story_test.py`: **23/23 pass**.
- `rtc_parity_test.py`: **11/11 pass**.
- Live prod `curl` `/api/health` + `/api/diag`: neon-postgres confirmed.
