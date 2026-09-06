/**
 * PRIV SPACA — deploy preflight.
 *
 * Wired into `npm run deploy` (runs before wrangler). Guards against the
 * class of incident that shipped in v170: a dirty / half-built working
 * tree deployed to Pages, which poisoned users' immutable CSS caches
 * (`_headers` sets *.min.css to max-age=1y, immutable — a stale byte
 * served under a new ?v= URL is stuck on a device for a year).
 *
 * Checks, in order:
 *   1. Version markers agree (APP_VERSION == SW_VERSION; ?v= refs in
 *      index.html / sw.js / app.js all consistent).
 *   2. Minified assets match a fresh rebuild of their sources
 *      (style.css, app.js, react-auth/main.jsx) — catches "source edited,
 *      build never run/committed".
 *   3. `npm run check` passes.
 *   4. Working tree is clean (commit + push before deploying).
 *      Override only with PS_ALLOW_DIRTY=1 — not recommended.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');
const bin = (n) => resolve(ROOT, 'node_modules/.bin/', n);
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, ...opts }).toString().trim();

const fail = (msg) => {
  console.error(`\n❌ preflight failed: ${msg}\n`);
  process.exit(1);
};

console.log('preflight: pre-deploy checks');

// ---------- 1. version markers ----------
const appJs = read('app.js');
const swJs = read('sw.js');
const html = read('index.html');

const appV = appJs.match(/const APP_VERSION = 'priv-spaca-v(\d+)'/)?.[1];
const swV = swJs.match(/const SW_VERSION = 'priv-spaca-v(\d+)'/)?.[1];
if (!appV || !swV || appV !== swV)
  fail(`APP_VERSION (v${appV}) !== SW_VERSION (v${swV}) — run: node scripts/build.mjs --bump`);

const ref = (text, label) => {
  const m = text.match(new RegExp(label.replace(/\./g, '\\.') + '\\?v=(\\d+)'));
  return m ? m[1] : null;
};
const htmlCss = ref(html, 'style.min.css');
const htmlJs = ref(html, 'app.min.js');
const swCss = ref(swJs, 'style.min.css');
const swJsV = ref(swJs, 'app.min.js');
const swAuth = ref(swJs, 'auth.react.min.js');
const jsAuth = ref(appJs, 'auth.react.min.js');

if (!htmlCss || !htmlJs || !swCss || !swJsV || !swAuth || !jsAuth)
  fail('could not read all ?v= markers (index.html / sw.js / app.js)');
if (htmlCss !== swCss)
  fail(`style.min.css ?v mismatch: index.html v${htmlCss} vs sw.js v${swCss}`);
if (htmlJs !== swJsV)
  fail(`app.min.js ?v mismatch: index.html v${htmlJs} vs sw.js v${swJsV}`);
if (swAuth !== jsAuth)
  fail(`auth.react.min.js ?v mismatch: sw.js v${swAuth} vs app.js v${jsAuth}`);
console.log(`  ✅ versions: app/sw v${appV}, css ?v=${htmlCss}, js ?v=${htmlJs}, auth ?v=${jsAuth}`);

// ---------- 2. minified assets in sync with sources ----------
const tmp = mkdtempSync(resolve(tmpdir(), 'ps-preflight-'));
const targets = [
  { tool: 'cleancss', args: ['-o', resolve(tmp, 'style.min.css'), 'style.css'], file: 'style.min.css' },
  { tool: 'terser', args: ['app.js', '-c', '-m', '-o', resolve(tmp, 'app.min.js')], file: 'app.min.js' },
  {
    tool: 'esbuild',
    args: ['react-auth/main.jsx', '--bundle', '--format=iife', '--minify', '--target=es2019', `--outfile=${resolve(tmp, 'auth.react.min.js')}`],
    file: 'auth.react.min.js',
  },
];
for (const { tool, args, file } of targets) {
  try {
    execFileSync(bin(tool), args, { cwd: ROOT, stdio: 'ignore' });
  } catch {
    fail(`could not rebuild ${file} with ${tool} — is node_modules installed? (npm install)`);
  }
  const fresh = readFileSync(resolve(tmp, file));
  const current = readFileSync(resolve(ROOT, file));
  if (!fresh.equals(current))
    fail(`${file} is STALE — its source changed but the minified build was not regenerated. Run: npm run build  (then commit the output)`);
  console.log(`  ✅ ${file} matches source`);
}

// ---------- 3. repo checks ----------
try {
  sh('npm', ['run', 'check'], { stdio: 'pipe' });
} catch {
  fail('npm run check failed — see output above');
}
console.log('  ✅ npm run check passed');

// ---------- 4. clean working tree ----------
const dirty = sh('git', ['status', '--porcelain']);
if (dirty && process.env.PS_ALLOW_DIRTY !== '1')
  fail(
    'working tree is dirty:\n  ' +
      dirty +
      '\n\n  Commit + push before deploying. A dirty deploy can ship a half-built tree, which — with immutable 1y CSS caching — bricks existing users until the next version bump.' +
      '\n  (PS_ALLOW_DIRTY=1 overrides this — not recommended)',
  );
console.log(dirty ? '  ⚠️  dirty tree — PS_ALLOW_DIRTY=1 override active' : '  ✅ working tree clean');

console.log('\n✅ preflight passed — safe to deploy.');
