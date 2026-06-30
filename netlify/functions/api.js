// Netlify Function wrapper for the Express API.
// netlify.toml redirects /api/* -> /.netlify/functions/api/:splat
// Inside the function, event.path arrives without the /api prefix; we re-add it
// so the Express routes (/api/health, /api/auth/login, etc.) match.
const serverless = require('serverless-http');
const app = require('../../api/index.js');

const handler = serverless(app);

exports.handler = async (event, context) => {
  // Normalise the path so Express sees /api/*
  let p = event.path || '/';
  // Strip the function prefix if present
  p = p.replace(/^\/\.netlify\/functions\/api/, '');
  // Re-add /api prefix
  if (!p.startsWith('/api')) {
    p = '/api' + (p.startsWith('/') ? p : '/' + p);
  }
  event.path = p;
  // Also fix rawUrl for libraries that look there
  if (event.rawUrl) {
    try {
      const u = new URL(event.rawUrl);
      event.rawUrl = u.origin + p + (u.search || '');
    } catch (_) {}
  }
  return handler(event, context);
};
