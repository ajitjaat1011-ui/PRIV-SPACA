# render/

Node build of the PRIV SPACA API for hosting on **Render** (free web service).

- `server.js` — entrypoint (`@hono/node-server` serving the bundled Hono app)
- `build.mjs` — esbuild bundle of `api/cf-worker.js` (Deno `npm:` specifiers rewritten for Node)
- `dist/` — build output (git-ignored)

Render service settings (free plan):

| Setting      | Value                                   |
| ------------ | --------------------------------------- |
| Root Directory | *(empty — repo root)*                   |
| Build Command  | `npm ci --no-audit --no-fund && node render/build.mjs` |
| Start Command  | `node render/server.js`                 |
| Plan         | Free                                    |

Environment (on the Render service):

| Var                | Value / notes                                        |
| ------------------ | ---------------------------------------------------- |
| `SUPABASE_URL`     | `https://ikpknzvpxpptmxrjeclz.supabase.co`            |
| `SUPABASE_SERVICE_KEY` | service-role key (secret)                          |
| `SUPABASE_DB_URL`  | direct Postgres connection string (secret)            |
| `FIELD_KEY`        | PII field-encryption key (secret)                     |
| `PS_PUBLIC_BASE`   | `https://priv-spaca.pages.dev`                        |

Free-tier note: idle services sleep after ~15 min; the first request after a
sleep takes 30–60 s to boot. A periodic free uptime ping keeps it warm.
