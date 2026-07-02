# PRIV-SPACA security check — 2026-07-02

Scope checked:
1. Exposed secrets
2. Rate limiting
3. Input validation

Focus: current Cloudflare Pages worker (`api/cf-worker.js`), with parity notes for `api/index.js`.

---

## 1) Exposed secrets

### Status: **Partly mitigated, but not clean**

### Good
- The repo does **not** appear to commit `GITHUB_PAT`, `DATABASE_URL`, or `VAPID_PRIVATE_KEY` directly.
- Production refuses API traffic if the default JWT secret is still active:
  - `api/cf-worker.js`: `isDefaultJwtSecret()` + production guard
  - `api/index.js`: same pattern

### Problems found
- A **hardcoded VIP unlock fallback** existed in source before this session:
  - `api/cf-worker.js`: `VIP_UNLOCK_KEY = 'arvshub1718'`
  - `api/index.js`: `process.env.VIP_UNLOCK_KEY || 'arvshub1718'`
- Because the repo is public, that fallback effectively made the VIP key public if prod env did not override it.
- Public owner/admin identity values are committed in config/code:
  - `api/cf-worker.js`: `ADMIN_USERS`, `OWNER_EMAIL`, `OWNER_USERNAME`
  - `wrangler.toml`: `ADMIN_USERS`, `OWNER_EMAIL`, `OWNER_USERNAME`
  - These are not secrets, but they are public PII / config leakage.

### Fix applied locally
- Removed the hardcoded VIP fallback.
- VIP redeem now fails closed when not configured:
  - returns `503 VIP unlock is not configured`

Files patched:
- `api/cf-worker.js`
- `api/index.js`

### Recommended next step
- Rotate any real credentials that were ever shared outside encrypted secret storage.
- Move owner/admin identifiers out of public defaults if you want to reduce public exposure.

---

## 2) Rate limiting

### Status: **Exists, but live enforcement is weak**

### What exists in code
- Global API rate limit:
  - `400 req/min per IP`
  - `api/cf-worker.js`: `globalRateLimit`
  - mounted on `app.use('/api/*', globalRateLimit)`
- Auth-specific rate limit:
  - `40 attempts / 15 min per IP`
- Credential-specific throttle:
  - `20 login attempts / 15 min` per `(IP + identifier)`
- Per-account lockout:
  - `5 wrong passwords in 5 min -> 15 min lockout`

### Live verification
- `GET https://priv-spaca.pages.dev/api/health` returns:
  - `X-RateLimit-Limit: 400`
  - `X-RateLimit-Remaining: ...`

### Problem found
- Current limiter is **in-memory only** (`Map()`), which is not shared across Cloudflare Worker isolates.
- Practical result: enforcement is inconsistent under real traffic.
- Probe result from this session:
  - 22 bad login attempts with the **same bogus identifier** did **not** trigger `429`.
  - That strongly suggests requests were spread across isolates, so counters did not aggregate reliably.

### Conclusion
- This is **not “no rate limiting”**, but it was **not strong enough for production abuse resistance**.

### Fix applied locally
Implemented a **shared Neon-backed rate limiter** for:
- global API throttling
- auth route throttling
- credential-subject throttling

This keeps live Cloudflare enforcement shared across isolates instead of isolate-local memory only.

---

## 3) Input validation

### Status: **Mostly present, but uneven**

### Strong areas already in place
- Auth validation:
  - email / username / password / PIN checks
- Text sanitization:
  - control chars + bidi spoof chars stripped
- Media URL validation:
  - `isSafeMediaUrl()` / `isSafeImageUrl()`
- Upload size limits:
  - request body cap + media caps
- RTC signal bounds
- DM room normalization and authorization
- Post/story payload clamping

### Problems found
#### A. Scheduled message validation inconsistency in live worker
Before patch:
- `api/cf-worker.js` `/api/messages/schedule`
- `imageUrl` only checked for string length, not safe scheme/type.
- `replyTo.imageUrl` also lacked safe-media validation.

Risk:
- bad URLs could be stored through this route even though normal message send was stricter.

#### B. Push subscription validation too weak
Before patch:
- `/api/push/subscribe` only required `subscription.endpoint`
- `/api/push/unsubscribe` accepted unchecked endpoint strings

Risk:
- malformed / oversized / non-HTTPS subscription objects could be stored
- unnecessary DB bloat / noisy downstream failures

### Fixes applied locally
- Added `isSafeHttpsUrl()`
- Added `isValidPushSubscription()`
- Tightened `/api/push/subscribe`
- Tightened `/api/push/unsubscribe`
- Tightened worker `/api/messages/schedule` media validation
- Mirrored the same push/VIP hardening into `api/index.js`

Files patched:
- `api/cf-worker.js`
- `api/index.js`

### Remaining lower-priority cleanup opportunities
- Add ID-format regex checks on some simple mutation routes (`follow`, `block`, `delete`, etc.) for consistency
- Add shared schema helpers to reduce drift between Express and Cloudflare versions

---

## Overall verdict

### Exposed secrets
- **Needs improvement**
- biggest concrete issue found: hardcoded VIP fallback secret
- **patched locally**

### Rate limiting
- **Present, but weak on live Cloudflare** due to in-memory isolate-local storage
- **needs architectural fix**

### Input validation
- **Present in most important paths**
- not absent, but had a few gaps
- **patched locally**

---

## Local hardening patch validation

Validated after patch:
- `api/index.js` loads successfully
- `api/cf-worker.js` imports successfully

---

## Suggested next action order
1. **Deploy the secret/input-validation/rate-limit hardening patch**
2. **Verify production behavior after deploy**
3. Optionally remove public owner/admin identifiers from committed defaults
