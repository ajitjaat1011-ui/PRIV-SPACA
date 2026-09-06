# PRIV SPACA security operations

This runbook describes required controls; it contains no credential values.

## Production invariants

- Production persistence is Turso-only. Missing `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `FIELD_KEY` or a strong `JWT_SECRET` must make protected API routes fail closed.
- `FIELD_KEY` protects email, date of birth and all push-subscription endpoint/key material in both `ps_users` and the `ps_kv` mirror. Never place it in Git or `wrangler.toml`.
- `APP_VERSION` and `SW_VERSION` must be identical. Versioned JS/CSS URLs must be new values whenever immutable asset bytes change.
- Deploy only from a clean, reviewed commit with Node 22+ and Wrangler. A Git push is not a production deployment.
- Do not reintroduce GitHub `db.json`, Netlify or Vercel persistence/deployment fallbacks.

## Release gate

Run, in order:

```bash
npm ci
npm run check
npm run test:omni
npm run test:v169
npm run test:v170
npm run test:browser
npm audit --omit=dev
npm audit
npm run build

git diff --check
```

Run the live security suite against a local secret-configured test server, then against the immutable Pages deployment. The suite creates and permanently deletes its isolated account:

```bash
PS_APP_VERSION=priv-spaca-v170 node scripts/security-suite.mjs https://DEPLOYMENT.priv-spaca.pages.dev
```

Deploy manually and record the immutable URL and commit:

```bash
npx wrangler pages deploy . --project-name=priv-spaca --branch=main --commit-dirty=false
```

Verify the immutable URL first, then `https://priv-spaca.pages.dev`: static CSP/HSTS, `/api/health`, coarse `/api/ready`, current asset URLs, auth render, cookie attributes, login/logout revocation, recovery-code reset, source blocking and offline service-worker launch.

## Backups and restore drills

Turso backup retention is an external platform control and must be enabled/monitored in the Turso account. Do not write plaintext JSON backups into this public repository.

At least monthly, an operator should:

1. Create a timestamped Turso database backup/snapshot using the approved private account.
2. Restore it into an isolated non-production database with separate credentials.
3. Confirm schema/table creation, row counts, representative encrypted `ps_users`/`ps_kv` envelopes and application reads using a temporary Worker configuration.
4. Confirm no protected field or push-subscription secret is plaintext at rest.
5. Delete the temporary restore and record only date, operator, backup identifier, result and recovery time—not user data or secrets.

A release is not evidence that a restore drill happened. Track backup and drill alerts outside the repository.

## Secret and key rotation

- Rotate Turso, Cloudflare, Cloudinary, VAPID and administrative credentials immediately on suspected exposure and on the organization’s regular schedule.
- Rotating `JWT_SECRET` intentionally invalidates all sessions.
- `FIELD_KEY` rotation requires a dual-key migration: deploy read-old/write-new support, rewrite and verify all protected rows/mirror values, then remove the old key. Never replace it without migration or encrypted PII becomes unreadable.
- Regenerate user recovery codes only after password confirmation; old codes must become invalid immediately.

## Incident response and rollback

1. Preserve request/correlation IDs and provider logs; never paste tokens, PII or database exports into issues.
2. For suspected auth compromise, rotate JWT/admin secrets and revoke affected account token versions.
3. For suspected database-only compromise, rotate the Turso token, preserve forensic access logs and assess encrypted-envelope exposure separately from Worker-secret exposure.
4. Roll back with a known-good immutable Pages deployment only when its minimum-version/session behavior remains compatible. Otherwise ship a forward fix with a new app/SW and asset version.
5. Re-run canonical health, auth, storage, cookie and service-worker checks after rollback or forward repair.

## Claims and residual assurance

Field encryption is protection against database-only compromise; it does not protect against an attacker who also controls Worker secrets. “Secret chat” must not be described as independently audited Signal-grade E2EE. Independent penetration testing and recurring restore/load/soak drills remain external operational assurance requirements.
