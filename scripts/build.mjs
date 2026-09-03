#!/usr/bin/env node
/**
 * PRIV SPACA — build & version bump.
 *
 *   node scripts/build.mjs            # minify only, keep current version
 *   node scripts/build.mjs --bump     # bump app/sw + asset versions, then minify
 *   node scripts/build.mjs --set 140  # set an explicit app/sw version
 *
 * THE #1 RULE THIS SCRIPT ENFORCES
 * --------------------------------
 * APP_VERSION (app.js) and SW_VERSION (sw.js) must be the SAME string.
 * The client's SelfHeal probes /sw.js and compares them; a mismatch wipes
 * caches, unregisters the service worker and reloads on every page load —
 * users get stuck in an endless "updating" loop. The old scripts/build.js
 * hardcoded v104/v130 and would have re-created exactly that bug, so it was
 * deleted in favour of this script, which derives versions from the files
 * and verifies they agree before writing anything.
 *
 * Four places must stay in sync:
 *   1. app.js  -> const APP_VERSION = 'priv-spaca-vNNN'
 *   2. sw.js   -> SW_VERSION, STATIC_CACHE, RUNTIME_CACHE, APP_SHELL entries
 *   3. index.html -> ?v= on style.min.css and app.min.js
 *   4. the minified assets themselves
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const p = (f) => resolve(ROOT, f);
const read = (f) => readFileSync(p(f), 'utf8');
const write = (f, s) => writeFileSync(p(f), s);
const kb = (f) => (statSync(p(f)).size / 1024).toFixed(1) + 'KB';

const args = process.argv.slice(2);
const bump = args.includes('--bump');
const setIdx = args.indexOf('--set');
const explicit = setIdx !== -1 ? Number(args[setIdx + 1]) : null;

function replaceOnce(text, re, next, label) {
  const hits = text.match(new RegExp(re.source, re.flags.replace('g', '') + 'g')) || [];
  if (hits.length === 0) throw new Error(`build: pattern not found for ${label}`);
  return text.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), next);
}

// ---------- read current versions ----------
let appJs = read('app.js');
let swJs = read('sw.js');
let html = read('index.html');

const appV = appJs.match(/const APP_VERSION = 'priv-spaca-v(\d+)'/);
const swV = swJs.match(/const SW_VERSION = 'priv-spaca-v(\d+)'/);
if (!appV || !swV) throw new Error('build: could not read APP_VERSION / SW_VERSION');
if (appV[1] !== swV[1]) {
  console.error(`\n❌ APP_VERSION (v${appV[1]}) !== SW_VERSION (v${swV[1]}) — this causes the reload loop.`);
  console.error('   Re-run with --set <n> to force both to the same version.\n');
  if (!explicit) process.exit(1);
}

const cssV = Number((html.match(/style\.min\.css\?v=(\d+)/) || [])[1]);
const jsV = Number((html.match(/app\.min\.js\?v=(\d+)/) || [])[1]);
const cacheV = Number((swJs.match(/priv-spaca-static-v(\d+)/) || [])[1]);
if (!cssV || !jsV || !cacheV) throw new Error('build: could not read asset/cache versions');

const current = Number(appV[1]);
const nextApp = explicit ?? (bump ? current + 1 : current);
const nextCss = (bump || explicit) ? cssV + 1 : cssV;
const nextJs = (bump || explicit) ? jsV + 1 : jsV;
const nextCache = (bump || explicit) ? cacheV + 1 : cacheV;

console.log(`\nPRIV SPACA build`);
console.log(`  app/sw : v${current} -> v${nextApp}`);
console.log(`  css    : ?v=${cssV} -> ?v=${nextCss}`);
console.log(`  js     : ?v=${jsV} -> ?v=${nextJs}`);
console.log(`  caches : v${cacheV} -> v${nextCache}\n`);

if (nextApp !== current || nextCss !== cssV) {
  // app.js
  appJs = replaceOnce(appJs, /const APP_VERSION = 'priv-spaca-v\d+'/, `const APP_VERSION = 'priv-spaca-v${nextApp}'`, 'APP_VERSION');
  write('app.js', appJs);

  // sw.js — version, caches and the two app-shell entries
  swJs = replaceOnce(swJs, /const SW_VERSION = 'priv-spaca-v\d+'/, `const SW_VERSION = 'priv-spaca-v${nextApp}'`, 'SW_VERSION');
  swJs = swJs.replace(/priv-spaca-static-v\d+/g, `priv-spaca-static-v${nextCache}`);
  swJs = swJs.replace(/priv-spaca-runtime-v\d+/g, `priv-spaca-runtime-v${nextCache}`);
  swJs = swJs.replace(/style\.min\.css\?v=\d+/g, `style.min.css?v=${nextCss}`);
  swJs = swJs.replace(/app\.min\.js\?v=\d+/g, `app.min.js?v=${nextJs}`);
  swJs = swJs.replace(/auth\.react\.min\.js\?v=\d+/g, `auth.react.min.js?v=${nextJs}`);
  write('sw.js', swJs);

  // index.html — single line, so do exact string swaps
  html = html.replace(/style\.min\.css\?v=\d+/g, `style.min.css?v=${nextCss}`);
  html = html.replace(/app\.min\.js\?v=\d+/g, `app.min.js?v=${nextJs}`);
  html = html.replace(/auth\.react\.min\.js\?v=\d+/g, `auth.react.min.js?v=${nextJs}`);
  write('index.html', html);
}

// ---------- minify ----------
const bin = (name) => resolve(ROOT, 'node_modules/.bin/', name);
console.log('minifying style.css -> style.min.css');
execFileSync(bin('cleancss'), ['-o', 'style.min.css', 'style.css'], { cwd: ROOT, stdio: 'inherit' });
console.log(`  ${kb('style.css')} -> ${kb('style.min.css')}`);

console.log('minifying app.js -> app.min.js');
execFileSync(bin('terser'), ['app.js', '-c', '-m', '-o', 'app.min.js'], { cwd: ROOT, stdio: 'inherit' });
console.log(`  ${kb('app.js')} -> ${kb('app.min.js')}`);

// ---------- verify ----------
const finalApp = read('app.js').match(/const APP_VERSION = 'priv-spaca-v(\d+)'/)[1];
const finalSw = read('sw.js').match(/const SW_VERSION = 'priv-spaca-v(\d+)'/)[1];
const finalHtml = read('index.html');
const okVersions = finalApp === finalSw;
const okCss = finalHtml.includes(`style.min.css?v=${nextCss}`) && read('sw.js').includes(`style.min.css?v=${nextCss}`);
const okJs = finalHtml.includes(`app.min.js?v=${nextJs}`) && read('sw.js').includes(`app.min.js?v=${nextJs}`);
const okAuth = finalHtml.includes(`auth.react.min.js?v=${nextJs}`) && read('sw.js').includes(`auth.react.min.js?v=${nextJs}`);

console.log('\nverification');
console.log(`  ${okVersions ? '✅' : '❌'} APP_VERSION === SW_VERSION (v${finalApp})`);
console.log(`  ${okCss ? '✅' : '❌'} css ?v=${nextCss} in index.html + sw.js`);
console.log(`  ${okJs ? '✅' : '❌'} js  ?v=${nextJs} in index.html + sw.js`);
console.log(`  ${okAuth ? '✅' : '❌'} auth.react.min.js ?v=${nextJs} in index.html + sw.js`);
if (!okVersions || !okCss || !okJs || !okAuth) process.exit(1);
console.log('\nbuild complete.\n');
