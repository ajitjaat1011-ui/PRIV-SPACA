/**
 * PRIV SPACA — local dev server.
 *
 * Runs the REAL production Hono app (api/cf-worker.js) on Node, so local
 * behaviour matches Cloudflare Pages instead of a parallel Express copy.
 * (The old Express duplicate, api/index.js, was deleted — it had drifted
 * from the worker and doubled every backend change.)
 *
 *   node scripts/dev-server.mjs            # port 8787, in-memory storage
 *   PORT=3000 node scripts/dev-server.mjs  # custom port
 *
 * Environment (all optional — without them the API uses in-memory storage):
 *   JWT_SECRET, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, GITHUB_PAT, ...
 *
 * Requires Node >= 20 (global fetch/Request/Response, node:async_hooks).
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const app = (await import('../api/cf-worker.js')).default;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

// Files that must never be served, mirroring _worker.js / _redirects.
const BLOCKED = [/^\/\.git/, /^\/\.github\//, /^\/scripts\//, /^\/backups\//, /^\/api\//,
  /^\/(package(-lock)?\.json|wrangler\.toml|README\.md|\.cloudflareignore|\.gitlab-ci\.yml)$/];

async function serveStatic(pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return null;
  try {
    const s = await stat(file);
    if (!s.isFile()) return null;
    return { body: await readFile(file), type: MIME[extname(file).toLowerCase()] || 'application/octet-stream' };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };

  try {
    if (url.pathname.startsWith('/api/')) {
      // Collect the body so the Request is a faithful copy of the original.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: hasBody && chunks.length ? Buffer.concat(chunks) : undefined,
      });
      // process.env doubles as the Workers `env` binding locally.
      const response = await app.fetch(request, process.env, {
        waitUntil: (p) => { Promise.resolve(p).catch(() => {}); },
        passThroughOnException() {},
      });
      const headers = Object.fromEntries(response.headers.entries());
      res.writeHead(response.status, headers);
      if (response.body) {
        // Stream so SSE (/api/stream) works instead of buffering forever.
        const reader = response.body.getReader();
        req.on('close', () => reader.cancel().catch(() => {}));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      return res.end();
    }

    if (BLOCKED.some((re) => re.test(url.pathname))) return send(404, { 'Content-Type': 'text/plain' }, 'Not found');

    const asset = await serveStatic(url.pathname === '/' ? '/index.html' : url.pathname);
    if (asset) return send(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-cache' }, asset.body);

    // SPA fallback.
    const index = await serveStatic('/index.html');
    if (index) return send(200, { 'Content-Type': index.type, 'Cache-Control': 'no-cache' }, index.body);
    return send(404, { 'Content-Type': 'text/plain' }, 'Not found');
  } catch (err) {
    console.error('[dev-server]', req.method, url.pathname, err);
    if (!res.headersSent) send(500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: String(err && err.message || err) }));
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PRIV SPACA dev server → http://${HOST}:${PORT}`);
  console.log(`Storage: ${process.env.TURSO_DATABASE_URL ? 'Turso' : 'in-memory (set TURSO_DATABASE_URL for real data)'}`);
});
