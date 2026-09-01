/**
 * PRIV SPACA — Routes — misc
 *
 * Removed-admin stub and the /api/* 404 catch-all (MUST be registered last).
 *
 * Part of the modular Hono API (api/). Entry point: api/cf-worker.js
 */

import { app } from '../lib/app.js';

// ---------- Admin panel removed by owner request ----------
app.all('/api/admin/*', (c) => c.json({ error: 'Admin panel removed' }, 404));

// ---------- 404 ----------
// Must be registered LAST (after every real route above, including /api/feed).
// Hono matches routes in registration order, so a catch-all placed earlier
// would shadow any route defined after it — which is exactly what happened
// to /api/feed before this fix (it always hit this 404 handler instead).
app.all('/api/*', (c) => c.json({ error: 'Route not found', path: c.req.path }, 404));
