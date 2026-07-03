#!/usr/bin/env node
/**
 * PRIV SPACA — local continuous diagnostics monitor.
 *
 * Runs on a real server/VM, polls the Turso database directly, runs the same
 * diagnostic checks as the Cloudflare Worker, and writes detected problems to
 * a local JSON file (`data/diagnostics.json`).
 *
 * This lets an agent or operator inspect problems without calling the API.
 *
 * Usage:
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/monitor.js
 *
 * Optional env:
 *   MONITOR_INTERVAL_MS  - loop interval (default: 300000 = 5 min)
 *   MONITOR_OUTPUT_FILE  - output JSON file (default: data/diagnostics.json)
 *   MONITOR_SEVERITY     - minimum severity to keep (default: info)
 */

const fs = require('fs');
const path = require('path');
const { createClient: createTursoClient } = require('@libsql/client');

const INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 5 * 60 * 1000);
const OUTPUT_FILE = process.env.MONITOR_OUTPUT_FILE || path.join(process.cwd(), 'data', 'diagnostics.json');
const MIN_SEVERITY = process.env.MONITOR_SEVERITY || 'info';

const SEVERITY_ORDER = { critical: 0, error: 1, warning: 2, info: 3 };

function nowMs() {
  return Date.now();
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function safeJson(str, fallback) {
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function normalizeDb(remote) {
  if (!remote || typeof remote !== 'object') {
    return { users: [], messages: [], scheduledMessages: [], posts: [], notifications: [], typing: {}, heartbeat: {}, rtcSignals: [], meta: {} };
  }
  return {
    users: Array.isArray(remote.users) ? remote.users : [],
    messages: Array.isArray(remote.messages) ? remote.messages : [],
    scheduledMessages: Array.isArray(remote.scheduledMessages) ? remote.scheduledMessages : [],
    posts: Array.isArray(remote.posts) ? remote.posts : [],
    notifications: Array.isArray(remote.notifications) ? remote.notifications : [],
    typing: remote.typing || {},
    heartbeat: remote.heartbeat || {},
    rtcSignals: Array.isArray(remote.rtcSignals) ? remote.rtcSignals : [],
    meta: remote.meta || {},
  };
}

async function ensureOutputDir() {
  const dir = path.dirname(OUTPUT_FILE);
  await fs.promises.mkdir(dir, { recursive: true });
}

async function readPrimaryDb(client) {
  const rs = await client.execute({ sql: 'SELECT value FROM ps_kv WHERE key = ? LIMIT 1', args: ['db'] });
  if (!rs.rows || rs.rows.length === 0) return normalizeDb({});
  return normalizeDb(safeJson(String(rs.rows[0].value || '{}'), normalizeDb({})));
}

async function run() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set');
  }

  const lib = await import(path.join(process.cwd(), 'api', 'diagnostics-lib.mjs'));
  const client = createTursoClient({ url, authToken });

  log('Monitor started. Interval:', INTERVAL_MS, 'ms. Output:', OUTPUT_FILE);

  while (true) {
    const loopStart = nowMs();
    let problems = [];
    let dbReachable = false;
    let dbError = null;
    let db = null;

    try {
      db = await readPrimaryDb(client);
      dbReachable = true;
    } catch (e) {
      dbError = e.message;
      log('Failed to read primary DB:', e.message);
    }

    try {
      problems = await lib.runFullDiagnostics({
        db,
        now: loopStart,
        dbReachable,
        dbError,
        query: async (sql, args = []) => client.execute({ sql, args }),
      });
    } catch (e) {
      log('Diagnostics run failed:', e.message);
      problems.push({
        severity: 'critical',
        category: 'system',
        code: 'monitor_runtime_error',
        title: 'Diagnostics monitor runtime error',
        description: e.message,
        data: {},
      });
    }

    const minRank = SEVERITY_ORDER[MIN_SEVERITY] ?? 3;
    const filtered = problems.filter(p => (SEVERITY_ORDER[p.severity] ?? 3) <= minRank);

    const output = {
      generatedAt: loopStart,
      generatedAtIso: new Date(loopStart).toISOString(),
      intervalMs: INTERVAL_MS,
      dbReachable,
      dbError,
      count: filtered.length,
      problems: filtered,
    };

    try {
      await ensureOutputDir();
      await fs.promises.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
      log('Wrote', filtered.length, 'problem(s) to', OUTPUT_FILE);
    } catch (e) {
      log('Failed to write output file:', e.message);
    }

    const elapsed = nowMs() - loopStart;
    const sleepMs = Math.max(1000, INTERVAL_MS - elapsed);
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

run().catch(e => {
  console.error('[monitor] fatal:', e.message);
  process.exit(1);
});
