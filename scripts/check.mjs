#!/usr/bin/env node
/**
 * PRIV SPACA — repo sanity check.  `npm run check`
 *
 * Fails (exit 1) on the mistakes that have actually broken this app before:
 *   1. APP_VERSION !== SW_VERSION            -> production reload loop
 *   2. asset ?v= mismatch between index.html and sw.js
 *   3. an API bundle failing to resolve      -> 500s on every /api/* route
 *   4. route table regressions               -> middleware after routes, or
 *                                               the /api/* 404 not registered last
 *   5. dependencies imported but not declared in package.json
 *
 * Version tokens may be numeric (priv-spaca-v180) or dotted
 * (priv-spaca-v1.0 / v93.4) — release lines can restart, so the markers are
 * compared as opaque strings for exact equality, never numerically here.
 *
 * Two API entrypoints are exercised:
 *   - api/cf-worker.js       Supabase-mode API (Render backend / edge standby).
 *                            Imports `pg` via a Deno-style `npm:pg@8.11.3`
 *                            specifier, aliased to the root 'pg' dependency so
 *                            the Node-side bundle resolves (render/build.mjs
 *                            performs the same rewrite before bundling).
 *   - api-legacy/cf-worker.js Turso-backed API, currently served by the Pages
 *                            advanced-mode worker as the production fallback.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');
let failed = 0;
const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => { console.log('  ❌ ' + m); failed++; };

console.log('\nPRIV SPACA — sanity check\n');

// ---------- 1 + 2: versions ----------
console.log('versions');
const appV = (read('app.js').match(/const APP_VERSION = 'priv-spaca-v([\d.]+)'/) || [])[1];
const swV = (read('sw.js').match(/const SW_VERSION = 'priv-spaca-v([\d.]+)'/) || [])[1];
appV && swV && appV === swV
  ? ok(`APP_VERSION === SW_VERSION (v${appV})`)
  : bad(`APP_VERSION (v${appV}) !== SW_VERSION (v${swV}) — causes the reload loop`);

const appSource = read('app.js'), html = read('index.html'), sw = read('sw.js');
const cacheLine = (sw.match(/priv-spaca-static-v([\d.]+)/) || [])[1];
if (appV && cacheLine && appV === cacheLine)
  ok(`static cache name matches release line (v${cacheLine})`);
else if (cacheLine)
  bad(`cache name priv-spaca-static-v${cacheLine} does not match release v${appV} — stale caches will never be cleaned`);
for (const asset of ['style.min.css', 'app.min.js', 'auth.react.min.js']) {
  const re = new RegExp(asset.replace('.', '\\.') + '\\?v=([\\w.]+)', 'g');
  const primary = asset === 'auth.react.min.js' ? appSource : html;
  const primaryLabel = asset === 'auth.react.min.js' ? 'app.js' : 'index.html';
  const inPrimary = [...new Set([...primary.matchAll(re)].map((m) => m[1]))];
  const inSw = [...new Set([...sw.matchAll(re)].map((m) => m[1]))];
  inPrimary.length === 1 && inSw.length === 1 && inPrimary[0] === inSw[0]
    ? ok(`${asset} ?v=${inPrimary[0]} consistent in ${primaryLabel} + sw.js`)
    : bad(`${asset} version mismatch — ${primaryLabel}=[${inPrimary}] sw.js=[${inSw}]`);
}

// ---------- 3: bundles resolve ----------
const esbuild = resolve(ROOT, 'node_modules/.bin/esbuild');
function bundleCheck(entry, label, extra = []) {
  console.log(`\napi bundle: ${label}`);
  const out = join('/tmp', 'priv-spaca-check-' + entry.replace(/[/\\]/g, '_') + '.js');
  try {
    execFileSync(esbuild,
      [entry, '--bundle', '--format=esm', '--platform=node',
        '--external:node:async_hooks', '--outfile=' + out, '--log-level=warning', ...extra],
      { cwd: ROOT, stdio: 'pipe' });
    ok(`${entry} bundles — every import resolves`);
    return out;
  } catch (e) {
    bad('bundle failed:\n' + String(e.stderr || e.message).split('\n').slice(0, 12).map((l) => '     ' + l).join('\n'));
    return null;
  }
}

// Route analysis on the bundles' registration order.
function analyzeRoutes(outFile, label) {
  console.log(`route table: ${label}`);
  try {
    const code = readFileSync(outFile, 'utf8');
    const ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: 'module' });
    const seq = [];
    walk.full(ast, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression') {
        const o = n.callee.object, pr = n.callee.property;
        if (o.type === 'Identifier' && o.name === 'app' && ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].includes(pr.name)) {
          const a = n.arguments[0];
          if (a && a.type === 'Literal') seq.push({ m: pr.name, path: String(a.value), pos: n.start });
        }
      }
    });
    seq.sort((a, b) => a.pos - b.pos);
    const routes = seq.filter((r) => r.m !== 'use');
    ok(`${routes.length} routes + ${seq.length - routes.length} middleware registered`);

    const lastUse = seq.map((r) => r.m).lastIndexOf('use');
    const firstRoute = seq.findIndex((r) => r.m !== 'use');
    lastUse < firstRoute ? ok('all middleware registered before routes')
      : bad('middleware registered AFTER a route — it will not wrap earlier routes');

    const last = seq[seq.length - 1];
    last && last.m === 'all' && last.path === '/api/*'
      ? ok('/api/* 404 catch-all is registered last')
      : bad(`last registration is ${last && last.m} ${last && last.path} — the /api/* catch-all must be last or it shadows later routes`);

    const dupes = Object.entries(routes.reduce((a, r) => ((a[r.m + ' ' + r.path] = (a[r.m + ' ' + r.path] || 0) + 1), a), {}))
      .filter(([, n]) => n > 1);
    dupes.length ? bad('duplicate routes: ' + dupes.map(([k, n]) => `${k} x${n}`).join(', '))
      : ok('no duplicate method+path registrations');
  } catch (e) {
    bad('route analysis failed: ' + e.message);
  }
}

const apiOut = bundleCheck('api/cf-worker.js', 'api/cf-worker.js (Supabase-mode / Render)',
  ['--alias:npm:pg@8.11.3=pg']);
if (apiOut) analyzeRoutes(apiOut, 'api/cf-worker.js (Supabase-mode / Render)');

const legacyOut = bundleCheck('api-legacy/cf-worker.js', 'api-legacy/cf-worker.js (Turso, Pages fallback)');
if (legacyOut) analyzeRoutes(legacyOut, 'api-legacy/cf-worker.js (Turso, Pages fallback)');

// ---------- 5: declared dependencies ----------
console.log('\ndependencies');
const pkg = JSON.parse(read('package.json'));
const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
const files = [];
const scan = (d, ext = ['.js', '.mjs']) => {
  for (const f of readdirSync(d)) {
    const full = join(d, f);
    if (statSync(full).isDirectory()) { if (f !== 'node_modules') scan(full, ext); }
    else if (ext.some((e) => f.endsWith(e))) files.push(full);
  }
};
scan(resolve(ROOT, 'api'));
scan(resolve(ROOT, 'api-legacy'), ['.js']);
files.push(resolve(ROOT, 'scripts/dev-server.mjs'));

// Normalise a specifier to its package name:
//   'npm:pg@8.11.3'  -> 'pg'      (Deno-style npm: specifier)
//   '@scope/pkg@1.2' -> '@scope/pkg'
const pkgName = (spec) => {
  let s = spec.startsWith('npm:') ? spec.slice(4) : spec;
  s = s.replace(/@[\w.+-]+$/, '');   // strip trailing @version (unscoped)
  if (s.startsWith('@') && s.split('/').length === 2) {
    // scoped '@scope/pkg' — the replace above already handled '@scope/pkg@1.2'
  }
  return s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
};

const used = new Set();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s+['"]([^'".][^'"]*)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('node:')) continue;
    const name = pkgName(spec);
    if (!name) continue;
    used.add(name);
  }
}
const missing = [...used].filter((u) => !declared.has(u));
missing.length ? bad('imported but NOT in package.json: ' + missing.join(', '))
  : ok(`all ${used.size} imported packages are declared (${[...used].sort().join(', ')})`);

const runtime = new Set(['hono', '@libsql/client', 'bcryptjs', 'js-base64', 'promise-limit', 'pg']);
const undeclaredRuntime = [...runtime].filter((r) => !(pkg.dependencies || {})[r]);
undeclaredRuntime.length
  ? bad('worker bundle needs these as dependencies: ' + undeclaredRuntime.join(', '))
  : ok('worker runtime packages present in dependencies');

console.log(failed === 0 ? '\n✅ all checks passed\n' : `\n❌ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
