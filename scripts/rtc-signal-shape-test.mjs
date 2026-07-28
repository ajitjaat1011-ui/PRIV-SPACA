#!/usr/bin/env node
/**
 * Regression test for the "callee never sees the incoming-call popup" bug.
 *
 * Root cause: POST /api/rtc/signal wrote the SAME WebRTC signal into ps_events
 * twice in two different shapes (a flat row + a `_pushEvent` envelope row).
 * GET /api/rtc/signals spread whichever row it read, so the envelope row was
 * delivered to the browser as { id, createdAt, ts, kind, data } with NO
 * top-level `signal`. The client's handleRTCSignal() started with
 * `if (!data.signal) return;` and dropped it — while pollRTCSignals() had
 * already advanced its `since` watermark past that row, so the flat sibling row
 * (equal or earlier timestamp) was then excluded by the server's
 * `created_at > since` filter. The offer was lost and user B never rang.
 *
 * This test locks in the two invariants that prevent a regression:
 *   1. server: normalizeRtcSignalRow() flattens every historical shape
 *   2. client: normalizeRtcSignal() flattens every historical shape
 *   3. neither implementation writes/emits a shape without a top-level `signal`
 *
 * Run: node scripts/rtc-signal-shape-test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fails = [];
function check(name, ok, detail = '') {
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ` -- ${detail}` : ''));
  if (!ok) fails.push(name);
}

/** Extract a top-level `function name(...) { ... }` from a source file. */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name}() not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const workerSrc = readFileSync(path.join(root, 'api', 'cf-worker.js'), 'utf8');
const expressSrc = readFileSync(path.join(root, 'api', 'index.js'), 'utf8');
const clientSrc = readFileSync(path.join(root, 'app.js'), 'utf8');

const mkServerNormalizer = (src) =>
  new Function('nowMs', `${extractFn(src, 'normalizeRtcSignalRow')}; return normalizeRtcSignalRow;`)(() => 1700000000000);
const mkDeduper = (src) =>
  new Function(`${extractFn(src, 'dedupeRtcSignals')}; return dedupeRtcSignals;`)();

const workerNorm = mkServerNormalizer(workerSrc);
const expressNorm = mkServerNormalizer(expressSrc);
const clientNorm = new Function(`${extractFn(clientSrc, 'normalizeRtcSignal')}; return normalizeRtcSignal;`)();

const OFFER = { type: 'offer', offer: { type: 'offer', sdp: 'v=0\r\nfake' }, video: false };
const AUTHOR = { id: 'usr_a', username: 'alice', displayName: 'Alice', photoUrl: '' };

// The three shapes that have ever existed in ps_events / on the wire.
const SHAPES = {
  flat: { id: 'rtc_1', createdAt: 1700000000000, fromId: 'usr_a', author: AUTHOR, signal: OFFER },
  envelope: { id: 'evt_1', ts: 1700000000000, kind: 'rtc_signal', data: { fromId: 'usr_a', author: AUTHOR, signal: OFFER } },
  doubleEnvelope: { id: 'evt_2', ts: 1700000000000, kind: 'rtc_signal', data: { id: 'evt_2', ts: 1700000000000, kind: 'rtc_signal', data: { fromId: 'usr_a', author: AUTHOR, signal: OFFER } } },
};

for (const [label, row] of Object.entries(SHAPES)) {
  for (const [impl, fn] of [['cf-worker', workerNorm], ['express', expressNorm]]) {
    const out = fn('row_' + label, 1700000000000, JSON.stringify(row));
    check(`${impl}: normalizes ${label} shape`, !!(out && out.signal && out.signal.type === 'offer'), JSON.stringify(out));
    check(`${impl}: recovers fromId from ${label}`, out && out.fromId === 'usr_a', out && out.fromId);
    check(`${impl}: recovers author from ${label}`, !!(out && out.author && out.author.username === 'alice'));
  }
  const c = clientNorm(row);
  check(`client: normalizes ${label} shape`, !!(c && c.signal && c.signal.type === 'offer'), JSON.stringify(c && c.signal && c.signal.type));
  check(`client: recovers fromId from ${label}`, c && c.fromId === 'usr_a', c && c.fromId);
}

// Objects that carry no usable signal must be rejected, not half-parsed.
for (const bad of [null, undefined, {}, { id: 'x' }, { data: {} }, 'nope', 42]) {
  const c = clientNorm(bad);
  check(`client: rejects junk payload ${JSON.stringify(bad) || String(bad)}`, c === null, JSON.stringify(c));
}
check('cf-worker: rejects unparseable JSON', workerNorm('r', 1, '{{{') === null);
check('express: rejects unparseable JSON', expressNorm('r', 1, '{{{') === null);

// Duplicate rows for the same signal collapse to one delivery.
for (const [impl, src] of [['cf-worker', workerSrc], ['express', expressSrc]]) {
  const dedupe = mkDeduper(src);
  const norm = mkServerNormalizer(src);
  const rows = [
    norm('a', 1700000000000, JSON.stringify(SHAPES.flat)),
    norm('b', 1700000000001, JSON.stringify(SHAPES.envelope)),
    norm('c', 1700000000002, JSON.stringify(SHAPES.doubleEnvelope)),
  ];
  const out = dedupe(rows);
  check(`${impl}: dedupes 3 rows describing one offer -> 1`, out.length === 1, `got ${out.length}`);
  const twoPeers = dedupe([
    ...rows,
    { id: 'd', createdAt: 3, fromId: 'usr_b', author: null, signal: OFFER },
  ]);
  check(`${impl}: keeps distinct callers`, twoPeers.length === 2, `got ${twoPeers.length}`);
  const answerToo = dedupe([...rows, { id: 'e', createdAt: 4, fromId: 'usr_a', author: null, signal: { type: 'answer', answer: {} } }]);
  check(`${impl}: keeps distinct signal types`, answerToo.length === 2, `got ${answerToo.length}`);
}

// The write path must not re-introduce the duplicate envelope row.
check('cf-worker: rtc route pushes event with persist:false',
  /_pushEvent\(targetId, 'rtc_signal', payload, \{ persist: false \}\)/.test(workerSrc));
check('express: rtc route pushes event with persist:false',
  /_pushEvent\(targetId, 'rtc_signal', payload, \{ persist: false \}\)/.test(expressSrc));
check('cf-worker: _pushEvent honours persist:false', /if \(opts\.persist === false\) return evt;/.test(workerSrc));
check('cf-worker: failed signal write reports 503, not fake ok',
  /Call signal storage unavailable/.test(workerSrc) && /if \(!wrote\) return c\.json/.test(workerSrc));

// Client watermark must come from the server clock, never the device clock.
check('client: watermark seeded at 0 (no device-clock seed)', /rtcLastSignalAt: 0,/.test(clientSrc));
check('client: watermark derived from server now', /const nextWatermark = serverNow - RTC_POLL_GRACE_MS;/.test(clientSrc));
check('client: poll dedupes by row id', /_rtcSignalAlreadySeen\(sig\.id\)/.test(clientSrc));
check('client: app version bumped past v104', /const APP_VERSION = 'priv-spaca-v105';/.test(clientSrc));
check('sw version matches app version',
  /const SW_VERSION = 'priv-spaca-v105';/.test(readFileSync(path.join(root, 'sw.js'), 'utf8')));

console.log('\n' + (fails.length ? `FAILURES (${fails.length}):\n - ${fails.join('\n - ')}` : `ALL ${'PASS'} (0 failures)`));
process.exit(fails.length ? 1 : 0);
