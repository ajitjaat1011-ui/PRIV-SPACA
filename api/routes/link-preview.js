/** Secure, cached OpenGraph link previews. */
import { app } from '../lib/app.js';
import { requireAuth } from '../lib/middleware.js';
import { isTursoConfigured, tursoClient, tursoEnsure } from '../lib/store-turso.js';
import { safeJson } from '../lib/helpers.js';
import { withFaultDomain } from '../lib/omni-engine.js';

const MAX_HTML_BYTES = 320 * 1024;
const OK_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 30 * 60 * 1000;

export function blockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '::' || host.includes('::ffff:') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
  const parts = host.split('.');
  if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
    const n = parts.map(Number);
    if (n.some(x => x < 0 || x > 255)) return true;
    return n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224
      || (n[0] === 100 && n[1] >= 64 && n[1] <= 127)
      || (n[0] === 169 && n[1] === 254)
      || (n[0] === 172 && n[1] >= 16 && n[1] <= 31)
      || (n[0] === 192 && n[1] === 168);
  }
  return false;
}

export function safePublicUrl(value, base) {
  try {
    if (!value || !String(value).trim()) return null;
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || blockedHostname(url.hostname)) return null;
    if (url.port && !['80', '443'].includes(url.port)) return null;
    url.hash = '';
    return url;
  } catch (_) { return null; }
}

async function hashUrl(url) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n) || 0)))
    .replace(/\s+/g, ' ').trim();
}

function attrs(tag) {
  const out = {};
  const re = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = re.exec(tag))) out[String(match[1]).toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return out;
}

export function parsePreview(html, finalUrl) {
  const meta = {};
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const key = String(a.property || a.name || '').toLowerCase();
    if (key && a.content && !(key in meta)) meta[key] = decodeEntities(a.content);
  }
  const titleTag = /<title\b[^>]*>([^]*?)<\/title>/i.exec(html);
  const title = (meta['og:title'] || meta['twitter:title'] || (titleTag && decodeEntities(titleTag[1])) || '').slice(0, 180);
  const description = (meta['og:description'] || meta.description || meta['twitter:description'] || '').slice(0, 320);
  const siteName = (meta['og:site_name'] || new URL(finalUrl).hostname.replace(/^www\./, '')).slice(0, 80);
  const imageCandidate = meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'];
  const image = imageCandidate ? safePublicUrl(imageCandidate, finalUrl) : null;
  return { url: finalUrl, title, description, siteName, imageUrl: image ? image.toString() : '' };
}

async function readLimited(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_HTML_BYTES) throw new Error('Preview document too large');
  if (!response.body || !response.body.getReader) return (await response.text()).slice(0, MAX_HTML_BYTES);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (total < MAX_HTML_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (total >= MAX_HTML_BYTES) break;
    }
  } finally {
    try { await reader.cancel(); } catch (_) {}
  }
  return text + decoder.decode();
}

async function fetchPreview(startUrl) {
  let current = startUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9',
        'user-agent': 'PRIV-SPACA-LinkPreview/1.0',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const next = safePublicUrl(response.headers.get('location'), current);
      if (!next) throw new Error('Unsafe redirect');
      current = next.toString();
      continue;
    }
    if (!response.ok) throw new Error(`Preview returned ${response.status}`);
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('application/xhtml')) throw new Error('Not an HTML page');
    return parsePreview(await readLimited(response), current);
  }
  throw new Error('Too many redirects');
}

app.get('/api/link-preview', requireAuth, async (c) => {
  const input = c.req.query('url') || '';
  const parsed = safePublicUrl(input);
  if (!parsed) return c.json({ error: 'Invalid or private URL' }, 400);
  const normalized = parsed.toString();
  const key = await hashUrl(normalized);
  const now = Date.now();
  if (isTursoConfigured()) {
    await tursoEnsure();
    const cached = await tursoClient().execute({
      sql: 'SELECT data_json FROM ps_link_previews WHERE url_hash = ? AND expires_at > ? LIMIT 1',
      args: [key, now],
    }).catch(() => ({ rows: [] }));
    const row = cached.rows && cached.rows[0];
    if (row) return c.json({ preview: safeJson(String(row.data_json || '{}'), {}), cached: true });
  }
  let preview;
  try {
    preview = await withFaultDomain('scraping.preview', () => fetchPreview(normalized), {
      idempotent: true,
      timeoutMs: 4500,
      delays: [150],
    });
  } catch (_) {
    preview = { url: normalized, title: '', description: '', siteName: parsed.hostname.replace(/^www\./, ''), imageUrl: '' };
  }
  if (isTursoConfigured()) {
    const expiresAt = now + (preview.title || preview.description || preview.imageUrl ? OK_TTL_MS : EMPTY_TTL_MS);
    await tursoClient().execute({
      sql: `INSERT INTO ps_link_previews (url_hash, url, title, description, image_url, site_name, expires_at, updated_at, data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url_hash) DO UPDATE SET title=excluded.title, description=excluded.description,
              image_url=excluded.image_url, site_name=excluded.site_name, expires_at=excluded.expires_at,
              updated_at=excluded.updated_at, data_json=excluded.data_json`,
      args: [key, normalized, preview.title, preview.description, preview.imageUrl, preview.siteName, expiresAt, now, JSON.stringify(preview)],
    }).catch(() => {});
  }
  return c.json({ preview, cached: false });
});
