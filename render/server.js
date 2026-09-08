// PRIV SPACA — Render (Node) entrypoint
//
// Serves the same Hono app (api/cf-worker.js) that runs on the Supabase
// edge function, bundled for Node by render/build.mjs into
// render/dist/api.bundle.js.
//
// Required env (set on the Render service):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_DB_URL  (database + GoTrue)
//   FIELD_KEY                                           (PII field encryption)
//   PS_PUBLIC_BASE=https://priv-spaca.pages.dev         (media URLs go back through the Pages proxy)
// Optional:
//   PORT (Render sets it), APP_MIN_VERSION, MIGRATE_TOKEN (one-shot migration, see api/routes/migrate.js)

import { serve } from '@hono/node-server';
import bundleMod from './dist/api.bundle.cjs';

// CJS interop: the esbuild CJS output of our ESM entry puts the Hono app on
// module.exports.default (with the __esModule marker).
const app = bundleMod && typeof bundleMod.fetch === 'function' ? bundleMod : bundleMod.default;
if (!app || typeof app.fetch !== 'function') {
  console.error('[render] bundle did not expose a Hono app — refusing to start');
  process.exit(1);
}

const port = Number(process.env.PORT || 10000);

// The Hono API loads its config from the per-request `env` object (Workers
// convention). On Node we pass process.env on every request.
const wrapFetch = (req) => app.fetch(req, process.env);

serve({ fetch: wrapFetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`[render] PRIV SPACA API listening on :${info.port}`);
});
