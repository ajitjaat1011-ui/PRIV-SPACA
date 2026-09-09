#!/usr/bin/env node
/**
 * PRIV SPACA — build & version bump.
 *
 *   node scripts/build.mjs            # minify only, keep current version
 *   node scripts/build.mjs --bump     # bump release + asset versions, then minify
 *   node scripts/build.mjs --set 1.1  # set an explicit release version, then minify
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
 * Release token: 'priv-spaca-v<token>' where <token> is numeric (v180) or
 * dotted (v1.0, v93.4) — release lines can restart (v1.0 "fresh start").
 *
 * Places that must stay in sync on a release:
 *   1. app.js  -> const APP_VERSION = 'priv-spaca-v<token>'
 *   2. sw.js   -> SW_VERSION, STATIC_CACHE/RUNTIME_CACHE (priv-spaca-*-v<token>),
 *                 APP_SHELL entries (style.min.css, app.min.js, boot-guard,
 *                 icons-v2.js, auth.react.min.js, vendor local-fonts/lucide/
 *                 motion + heic2any — the ?v= of every asset the page loads)
 *   3. index.html -> ?v= on style.min.css and app.min.js
 *      app.js  -> lazy auth.react.min.js ?v=
 *   4. the minified assets themselves
 *
 * Asset cache counters (the ?v= numbers and vendor bump counters) start at
 * 10 for the v1.0 line and are independent integers, bumped +1 on every
 * release so immutable browser/HTTP-cache entries (?v= URLs are served
 * max-age=1y, immutable) never collide with new bytes.
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
const explicit = setIdx !== -1 ? String(args[setIdx + 1] || '') : null;

// ---------- helpers ----------
function replaceOnce(text, re, next, label) {
  const hits = text.match(new RegExp(re.source, re.flags.replace('g', '') + 'g')) || [];
  if (hits.length === 0) throw new Error(`build: pattern not found for ${label}`);
  return text.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), next);
}
const vRe = /priv-spaca-v([\d.]+)/;
const bumpToken = (t) => {
  if (/^\d+$/.test(t)) return String(Number(t) + 1);      // 180 -> 181
  if (/^[\d.]+$/.test(t)) {                               // 1.0 -> 1.1, 93.4 -> 93.5
    const parts = t.split('.');
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
    return parts.join('.');
  }
  throw new Error(`build: cannot bump version token "${t}"`);
};

// ---------- read current versions ----------
let appJs = read('app.js');
let swJs = read('sw.js');
let html = read('index.html');

const appM = appJs.match(/const APP_VERSION = 'priv-spaca-v([\d.]+)'/);
const swM = swJs.match(/const SW_VERSION = 'priv-spaca-v([\d.]+)'/);
if (!appM || !swM) throw new Error('build: could not read APP_VERSION / SW_VERSION');
if (appM[1] !== swM[1]) {
  console.error(`\n❌ APP_VERSION (v${appM[1]}) !== SW_VERSION (v${swM[1]}) — this causes the reload loop.`);
  console.error('   Re-run with --set <n> to force both to the same version.\n');
  if (!explicit) process.exit(1);
}

const cssV = Number((html.match(/style\.min\.css\?v=(\d+)/) || [])[1]);
const jsV = Number((html.match(/app\.min\.js\?v=(\d+)/) || [])[1]);
const authV = Number((appJs.match(/auth\.react\.min\.js\?v=(\d+)/) || [])[1]);
if (!cssV || !jsV || !authV) throw new Error('build: could not read asset ?v= counters (index.html / app.js)');

const current = appM[1];
const nextTok = explicit || (bump ? bumpToken(current) : current);
const nextCss = (bump || explicit) ? cssV + 1 : cssV;
const nextJs = (bump || explicit) ? jsV + 1 : jsV;
const nextAuth = (bump || explicit) ? authV + 1 : authV;

console.log(`\nPRIV SPACA build`);
console.log(`  app/sw : v${current} -> v${nextTok}`);
console.log(`  css    : ?v=${cssV} -> ?v=${nextCss}`);
console.log(`  js     : ?v=${jsV} -> ?v=${nextJs}`);
console.log(`  auth   : ?v=${authV} -> ?v=${nextAuth}`);
console.log(`  caches : priv-spaca-{static,runtime}-v${nextTok}\n`);

if (nextTok !== current || nextCss !== cssV || nextJs !== jsV || nextAuth !== authV) {
  // app.js
  appJs = replaceOnce(appJs, /const APP_VERSION = 'priv-spaca-v[\d.]+'/, `const APP_VERSION = 'priv-spaca-v${nextTok}'`, 'APP_VERSION');
  appJs = appJs.replace(/auth\.react\.min\.js\?v=[\w.]+/g, `auth.react.min.js?v=${nextAuth}`);
  write('app.js', appJs);

  // sw.js — version, caches and the app-shell asset entries
  swJs = replaceOnce(swJs, /const SW_VERSION = 'priv-spaca-v[\d.]+'/, `const SW_VERSION = 'priv-spaca-v${nextTok}'`, 'SW_VERSION');
  swJs = swJs.replace(/priv-spaca-static-v[\d.]+/g, `priv-spaca-static-v${nextTok}`);
  swJs = swJs.replace(/priv-spaca-runtime-v[\d.]+/g, `priv-spaca-runtime-v${nextTok}`);
  swJs = swJs.replace(/style\.min\.css\?v=\d+/g, `style.min.css?v=${nextCss}`);
  swJs = swJs.replace(/app\.min\.js\?v=\d+/g, `app.min.js?v=${nextJs}`);
  swJs = swJs.replace(/auth\.react\.min\.js\?v=[\w.]+/g, `auth.react.min.js?v=${nextAuth}`);
  write('sw.js', swJs);

  // index.html
  html = html.replace(/style\.min\.css\?v=\d+/g, `style.min.css?v=${nextCss}`);
  html = html.replace(/app\.min\.js\?v=\d+/g, `app.min.js?v=${nextJs}`);
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
const finalApp = read('app.js').match(/const APP_VERSION = 'priv-spaca-v([\d.]+)'/)[1];
const finalSw = read('sw.js').match(/const SW_VERSION = 'priv-spaca-v([\d.]+)'/)[1];
const finalHtml = read('index.html');
const finalSwJs = read('sw.js');
const finalAppJs = read('app.js');
const okVersions = finalApp === finalSw;
const okCache = finalSwJs.includes(`priv-spaca-static-v${finalSw}`) && finalSwJs.includes(`priv-spaca-runtime-v${finalSw}`);
const okCss = finalHtml.includes(`style.min.css?v=${nextCss}`) && finalSwJs.includes(`style.min.css?v=${nextCss}`);
const okJs = finalHtml.includes(`app.min.js?v=${nextJs}`) && finalSwJs.includes(`app.min.js?v=${nextJs}`);
const okBoot = (finalHtml.match(/boot-guard\.min\.js\?v=([\w.]+)/) || [])[1] === (finalSwJs.match(/boot-guard\.min\.js\?v=([\w.]+)/) || [])[1];
const okAuth = (finalAppJs.match(/auth\.react\.min\.js\?v=([\w.]+)/) || [])[1] === (finalSwJs.match(/auth\.react\.min\.js\?v=([\w.]+)/) || [])[1];

console.log('\nverification');
console.log(`  ${okVersions ? '✅' : '❌'} APP_VERSION === SW_VERSION (v${finalApp})`);
console.log(`  ${okCache ? '✅' : '❌'} cache names on release line (v${finalSw})`);
console.log(`  ${okCss ? '✅' : '❌'} css ?v=${nextCss} in index.html + sw.js`);
console.log(`  ${okJs ? '✅' : '❌'} js  ?v=${nextJs} in index.html + sw.js`);
console.log(`  ${okBoot ? '✅' : '❌'} boot-guard ?v in index.html + sw.js`);
console.log(`  ${okAuth ? '✅' : '❌'} lazy auth.react.min.js ?v in app.js + sw.js`);
if (!okVersions || !okCache || !okCss || !okJs || !okBoot || !okAuth) process.exit(1);
console.log('\nbuild complete.\n');
