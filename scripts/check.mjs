#!/usr/bin/env node
/**
 * PRIV SPACA — repo sanity check.  `npm run check`
 *
 * Fails (exit 1) on the mistakes that have actually broken this app before:
 *   1. APP_VERSION !== SW_VERSION            -> production reload loop
 *   2. asset ?v= mismatch between index.html and sw.js
 *   3. the API bundle failing to resolve     -> 500s on every /api/* route
 *   4. route table regressions               -> middleware after routes, or
 *                                               the /api/* 404 not registered last
 *   5. dependencies imported but not declared in package.json
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
const appV = (read('app.js').match(/const APP_VERSION = 'priv-spaca-v(\d+)'/) || [])[1];
const swV = (read('sw.js').match(/const SW_VERSION = 'priv-spaca-v(\d+)'/) || [])[1];
appV && swV && appV === swV
  ? ok(`APP_VERSION === SW_VERSION (v${appV})`)
  : bad(`APP_VERSION (v${appV}) !== SW_VERSION (v${swV}) — causes the reload loop`);

const html = read('index.html'), sw = read('sw.js');
for (const asset of ['style.min.css', 'app.min.js']) {
  const re = new RegExp(asset.replace('.', '\\.') + '\\?v=(\\d+)', 'g');
  const inHtml = [...new Set([...html.matchAll(re)].map((m) => m[1]))];
  const inSw = [...new Set([...sw.matchAll(re)].map((m) => m[1]))];
  inHtml.length === 1 && inSw.length === 1 && inHtml[0] === inSw[0]
    ? ok(`${asset} ?v=${inHtml[0]} consistent in index.html + sw.js`)
    : bad(`${asset} version mismatch — index.html=[${inHtml}] sw.js=[${inSw}]`);
}

// ---------- 3: bundle resolves ----------
console.log('\napi bundle');
try {
  execFileSync(resolve(ROOT, 'node_modules/.bin/esbuild'),
    ['api/cf-worker.js', '--bundle', '--format=esm', '--platform=node',
      '--external:node:async_hooks', '--outfile=' + join('/tmp', 'priv-spaca-check.js'), '--log-level=warning'],
    { cwd: ROOT, stdio: 'pipe' });
  ok('api/cf-worker.js bundles — every import resolves');
} catch (e) {
  bad('bundle failed:\n' + String(e.stderr || e.message).split('\n').slice(0, 12).map((l) => '     ' + l).join('\n'));
}

// ---------- 4: route table ----------
console.log('\nroute table');
try {
  const code = readFileSync('/tmp/priv-spaca-check.js', 'utf8');
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

// ---------- 5: declared dependencies ----------
console.log('\ndependencies');
const pkg = JSON.parse(read('package.json'));
const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
const files = [];
(function scan(d) {
  for (const f of readdirSync(d)) {
    const full = join(d, f);
    if (statSync(full).isDirectory()) { if (f !== 'node_modules') scan(full); }
    else if (f.endsWith('.js') || f.endsWith('.mjs')) files.push(full);
  }
})(resolve(ROOT, 'api'));
files.push(resolve(ROOT, 'scripts/dev-server.mjs'));

const used = new Set();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s+['"]([^'".][^'"]*)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('node:')) continue;
    used.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
}
const missing = [...used].filter((u) => !declared.has(u));
missing.length ? bad('imported but NOT in package.json: ' + missing.join(', '))
  : ok(`all ${used.size} imported packages are declared (${[...used].sort().join(', ')})`);

const runtime = new Set(['hono', '@libsql/client', 'bcryptjs', 'js-base64', 'promise-limit']);
const undeclaredRuntime = [...runtime].filter((r) => !(pkg.dependencies || {})[r]);
undeclaredRuntime.length
  ? bad('worker bundle needs these as dependencies: ' + undeclaredRuntime.join(', '))
  : ok('worker runtime packages present in dependencies');

console.log(failed === 0 ? '\n✅ all checks passed\n' : `\n❌ ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 1 && 0 : 1);
