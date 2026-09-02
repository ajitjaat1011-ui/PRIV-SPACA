/**
 * PRIV SPACA — Runtime configuration
 *
 * Runtime configuration. All values live on the mutable `cfg` object so that
 * loadConfig(env) can refresh them per-request (Workers pass env per fetch).
 * NEVER hardcode secrets here — they arrive from encrypted Pages secrets.
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

export const cfg = {
  // ---------- Config (refreshed on every request from c.env) ----------
  // SECURITY: never default to a known public secret. isDefaultJwtSecret() +
  // the global middleware (below) refuses to serve /api/* when this is empty
  // or still the legacy default, so deploys without JWT_SECRET set fail closed.
  JWT_SECRET: '',
  GITHUB_PAT: '',
  TURSO_DATABASE_URL: '',
  TURSO_AUTH_TOKEN: '',
  GH_REPO: 'ajitjaat1011-ui/PRIV-SPACA',
  GH_BRANCH: 'data',
  GH_FILE: 'db.json',
  VAPID_PUBLIC: 'BG5msm1YiW_5l5N2ZNAvz5CkzQDGchg99ZSpkXVhXb4mm70X8vPPZs_7lrsaDXtvPns7QloRkh40vY4J5O0pqlI',
  VAPID_PRIVATE: '',
  // must be set as encrypted env secret in production
  VAPID_SUBJECT: 'mailto:admin@priv-spaca.app',
  // Bug #11 fix: Avoid hardcoding admin users in source. These are now fallback
  // defaults for development only. Production should use encrypted secrets.
  ADMIN_USERS: '',
  // Set via env secret: ADMIN_USERS
  OWNER_EMAIL: '',
  // Set via env secret: OWNER_EMAIL
  OWNER_USERNAME: '',
  // Set via env secret: OWNER_USERNAME
  VIP_UNLOCK_KEY: '',
  // Bug #12 fix: Cloudinary is optional. When not configured, uploads fall back to
  // GitHub raw content CDN. Set these as encrypted secrets only if you want faster
  // uploads via Cloudinary's CDN:
  //   wrangler pages secret put CLOUDINARY_CLOUD_NAME --project-name priv-spaca
  //   wrangler pages secret put CLOUDINARY_API_KEY --project-name priv-spaca
  //   wrangler pages secret put CLOUDINARY_API_SECRET --project-name priv-spaca
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
  CLOUDINARY_FOLDER: 'priv-spaca',
  STREAM_API_KEY: '',
  STREAM_API_SECRET: '',
  STREAM_APP_ID: '',
  // When set to a non-empty version string (e.g. 'priv-spaca-v90'), ALL
  // authenticated API requests from clients running an older APP_VERSION will
  // be rejected with 426 + { minVersion, upgradeUrl }. This force-logs-out
  // every user on older code so they pick up the new version. Set to '' to
  // disable (normal operation).
  APP_MIN_VERSION: '',
};

export function isAllowedCorsOrigin(origin) {
  if (!origin) return true; // curl/server/API agents send no Origin
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    if (h === 'priv-spaca.pages.dev' || h.endsWith('.priv-spaca.pages.dev')) return true;
    if (h === 'localhost' || h === '127.0.0.1') return true;
  } catch (_) {}
  return false;
}

export function applyCors(c) {
  const origin = c.req.header('origin') || '';
  if (origin && isAllowedCorsOrigin(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
  }
  c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Last-Event-ID');
  c.header('Access-Control-Max-Age', '86400');
}

export function isDefaultJwtSecret() {
  return !cfg.JWT_SECRET || cfg.JWT_SECRET === 'priv-spaca-dev-secret-change-me';
}

export function isProductionRequest(c) {
  // SECURITY: treat any non-localhost request as production. Previously this
  // only matched *.priv-spaca.pages.dev, leaving custom-domain deploys
  // vulnerable to JWT forgery using the public default secret.
  const host = new URL(c.req.url).hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return false;
  return true;
}

export function loadConfig(env) {
  if (!env) return;
  // Always overwrite — values can change per-deploy
  if (env.JWT_SECRET) cfg.JWT_SECRET = env.JWT_SECRET;
  if (env.GITHUB_PAT) cfg.GITHUB_PAT = env.GITHUB_PAT;
  if (env.TURSO_DATABASE_URL) cfg.TURSO_DATABASE_URL = String(env.TURSO_DATABASE_URL).trim();
  if (env.TURSO_AUTH_TOKEN) cfg.TURSO_AUTH_TOKEN = String(env.TURSO_AUTH_TOKEN).trim();
  if (env.GH_REPO) cfg.GH_REPO = env.GH_REPO;
  if (env.GH_BRANCH) cfg.GH_BRANCH = env.GH_BRANCH;
  if (env.GH_FILE) cfg.GH_FILE = env.GH_FILE;
  if (env.VAPID_PUBLIC_KEY) cfg.VAPID_PUBLIC = env.VAPID_PUBLIC_KEY;
  if (env.VAPID_PRIVATE_KEY) cfg.VAPID_PRIVATE = env.VAPID_PRIVATE_KEY;
  if (env.VAPID_SUBJECT) cfg.VAPID_SUBJECT = env.VAPID_SUBJECT;
  if (env.ADMIN_USERS) cfg.ADMIN_USERS = env.ADMIN_USERS;
  if (env.OWNER_EMAIL) cfg.OWNER_EMAIL = env.OWNER_EMAIL;
  if (env.OWNER_USERNAME) cfg.OWNER_USERNAME = env.OWNER_USERNAME;
  if (env.VIP_UNLOCK_KEY) cfg.VIP_UNLOCK_KEY = env.VIP_UNLOCK_KEY;
  if (env.CLOUDINARY_CLOUD_NAME) cfg.CLOUDINARY_CLOUD_NAME = env.CLOUDINARY_CLOUD_NAME;
  if (env.CLOUDINARY_API_KEY) cfg.CLOUDINARY_API_KEY = env.CLOUDINARY_API_KEY;
  if (env.CLOUDINARY_API_SECRET) cfg.CLOUDINARY_API_SECRET = env.CLOUDINARY_API_SECRET;
  if (env.CLOUDINARY_FOLDER) cfg.CLOUDINARY_FOLDER = env.CLOUDINARY_FOLDER;
  if (env.STREAM_API_KEY) cfg.STREAM_API_KEY = String(env.STREAM_API_KEY).trim();
  if (env.STREAM_API_SECRET) cfg.STREAM_API_SECRET = String(env.STREAM_API_SECRET).trim();
  if (env.STREAM_APP_ID) cfg.STREAM_APP_ID = String(env.STREAM_APP_ID).trim();
  if (env.APP_MIN_VERSION) cfg.APP_MIN_VERSION = String(env.APP_MIN_VERSION).trim();
}

export const JWT_EXPIRES_DAYS = 7;

// DEPRECATED (v154) — password hashing moved to lib/password.js, which uses
// PBKDF2-HMAC-SHA256 at 600k iterations on native WebCrypto instead of
// pure-JS bcryptjs. Measured on this runtime: bcryptjs cost 12 costs ~310ms of
// interpreted CPU per login and risks the Cloudflare CPU limit (error 1102),
// while PBKDF2 600k costs ~198ms native and is the OWASP recommendation when
// Argon2id is unavailable. Existing bcrypt hashes still verify and are
// upgraded transparently on next login, so no user is logged out.
// Retained only so any straggling import keeps resolving; do not use.
export const PASSWORD_HASH_ROUNDS = 8;

// Cache TTL on Cloudflare tuned for up to 100 concurrent users (absorbs polling spikes across isolates)
export const CACHE_TTL_MS = 2500;

export const EPHEMERAL_WRITE_INTERVAL_MS = 30000;
