/**
 * PRIV SPACA — Library — store-supabase
 *
 * v182 — Supabase/Postgres as the primary store, exposed through the exact
 * same libsql-shaped interface the rest of the API already uses
 * ({ execute, batch, executeMultiple }):
 *
 *   const client = await tursoClient();
 *   const rs = await client.execute({ sql, args });      // single statement
 *   const out = await client.batch([...]);               // sequential batch
 *   await client.executeMultiple(ddl);                   // bootstrap DDL
 *
 * Transport: a DIRECT Postgres connection from the edge function to the
 * project database (SUPABASE_DB_URL is injected by the Supabase runtime —
 * no API keys, no PostgREST). Real parameterized queries: the store code's
 * `?` placeholders are translated to `$n` and passed through as an args
 * array, so user data never touches the SQL text.
 *
 * Dialect translation (the 8.7k lines of route/store SQL are untouched):
 *   - `?` placeholders          -> `$1..$n` (quote/comment aware)
 *   - PRAGMA table_info(x)      -> information_schema query
 *   - INSERT OR IGNORE          -> INSERT ... ON CONFLICT DO NOTHING
 *
 * Result shape mirrors libsql: { rows, columns, changes, rowsAffected,
 * lastInsertRowid } (lastInsertRowid is always null: every ps_* id is an
 * app-generated uid).
 */

import { cfg } from './config.js';

// node-pg comes from the edge runtime's npm: support. IMPORTANT: the import
// must be STATIC — the runtime's deploy-time scanner only registers npm:
// specifiers it can see in import statements (a dynamic import() of an npm:
// specifier fails at runtime with "Could not find constraint ... in the
// list of packages"). esbuild is told to leave the specifier out of the
// bundle (--external:npm:pg@8.11.3), so this exact line survives into
// worker-bundle.js and the runtime resolves it at load time.
import * as _pgNs from 'npm:pg@8.11.3';
let _PG_CLIENT = null;
async function getPgClient() {
  if (!_PG_CLIENT) {
    const m = _pgNs.default || _pgNs;
    _PG_CLIENT = (typeof m === 'function' && m) || m.Client || m.default?.Client;
    if (!_PG_CLIENT) throw new Error('node-pg Client unavailable');
  }
  return _PG_CLIENT;
}

// ---------- Per-isolate connection pool ----------
// Edge isolates are long-lived; keep at most two connections, created on
// demand. Broken connections are dropped and replaced lazily.
let _poolClients = [];
let _poolNext = 0;
// Single-flight connect per slot: a concurrent acquire (or the startup
// warmup) awaits the same in-flight handshake instead of opening a second
// connection to the same slot.
let _poolConnecting = [null, null];
function connectSlot(idx) {
  if (!_poolConnecting[idx]) {
    _poolConnecting[idx] = pgConnect()
      .then((cl) => { _poolClients[idx] = cl; return cl; })
      .catch((e) => { _poolConnecting[idx] = null; throw e; })
      .finally(() => { if (_poolConnecting[idx] && _poolClients[idx]) _poolConnecting[idx] = null; });
  }
  return _poolConnecting[idx];
}

async function pgConnect() {
  const PG_CLIENT = await getPgClient();
  const client = new PG_CLIENT({
    connectionString: cfg.SUPABASE_DB_URL,
    query_timeout: 10_000,
    // Fail a hung connect fast (inside the fault budget) instead of letting
    // one dead handshake eat the whole request.
    connectionTimeoutMillis: 4000,
  });
  await client.connect();
  return client;
}


async function acquirePg() {
  for (;;) {
    const idx = _poolNext % 2;
    _poolNext += 1;
    const existing = _poolClients[idx];
    if (existing && existing.connection && existing.connection.readyState !== 'closed') {
      return { client: existing };
    }
    const client = await connectSlot(idx);
    return { client };
  }
}

function releasePg({ client }, broke = false) {
  if (broke) {
    try { client.end(); } catch (_) {}
  }
}

// Warm the pool at isolate startup, OUTSIDE any fault-domain budget: the
// first request should find an open connection instead of paying the ~2s
// VPC/TLS handshake inside its 2.5-9s read window. Fire-and-forget — a
// warmup failure just means the first query pays for its own connect.
if (isSupabaseConfigured()) {
  for (const idx of [0, 1]) {
    void connectSlot(idx).catch(() => {}); // first real query reconnects
  }
}

function isConnectionError(e) {
  const m = String(e && e.message || e);
  return /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|protocol|closed|timeout|ETIMEDOUT|EAI_AGAIN|query timeout|terminat/i.test(m);
}

// ---------- Dialect translation ----------

// `?` -> `$n`, skipping string literals, line/block comments, and double
// quotes. Mirrors the rules of the SQL used by the app (placeholders are
// always in a top-level argument position).
function bindPlaceholders(sql) {
  let out = '';
  let n = 0;
  let inStr = false;
  let inDq = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const nx = sql[i + 1];
    if (inLine) {
      out += ch;
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      out += ch;
      if (ch === '*' && nx === '/') { out += '/'; i++; inBlock = false; }
      continue;
    }
    if (inStr) {
      out += ch;
      if (ch === "'" && nx === "'") { out += "'"; i++; continue; }
      if (ch === "'") inStr = false;
      continue;
    }
    if (inDq) {
      out += ch;
      if (ch === '"') inDq = false;
      continue;
    }
    if (ch === "'") { inStr = true; out += ch; continue; }
    if (ch === '"') { inDq = true; out += ch; continue; }
    if (ch === '-' && nx === '-') { inLine = true; out += ch; continue; }
    if (ch === '/' && nx === '*') { inBlock = true; out += '/*'; i++; continue; }
    if (ch === '?') { n++; out += '$' + n; continue; }
    out += ch;
  }
  return { sql: out, count: n };
}

// PRAGMA table_info(name) -> information_schema rows with libsql column
// names (cid, name, type, pk). The app only reads `name`; the rest is
// provided for parity with the libsql result shape.
function translatePragma(sql) {
  const m = sql.match(/^\s*PRAGMA\s+table_info\s*\(\s*["'`]?([a-zA-Z0-9_]+)["'`]?\s*\)\s*;?\s*$/i);
  if (!m) return null;
  const table = m[1]; // already validated as [a-zA-Z0-9_]+
  return `SELECT ordinal_position - 1 AS cid, column_name AS name, data_type AS type, CASE WHEN column_name = (SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.table_schema = 'public' AND tc.table_name = '${table}' AND tc.constraint_type = 'PRIMARY KEY' LIMIT 1) THEN 1 ELSE 0 END AS pk FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY ordinal_position`;
}

// INSERT OR IGNORE INTO ... -> INSERT INTO ... ON CONFLICT DO NOTHING
function translateInsertOrIgnore(sql) {
  const re = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i;
  if (!re.test(sql)) return null;
  // Strip a trailing semicolon, append the clause, restore it.
  const trimSemi = /;\s*$/.test(sql);
  let core = sql.replace(/;\s*$/, '');
  core = core.replace(re, 'INSERT INTO');
  core += ' ON CONFLICT DO NOTHING';
  return trimSemi ? core + ';' : core;
}

// SQLite instr(haystack, needle) -> Postgres strpos(haystack, needle). Both
// return the 1-based position of needle in haystack (0 when absent) and take
// arguments in the same order, so a plain rename is semantically exact.
function translateInstr(sql) {
  if (!/\binstr\s*\(/i.test(sql)) return null;
  return sql.replace(/\binstr\s*\(/gi, 'strpos(');
}

export function translateSql(sql) {
  const pragma = translatePragma(sql);
  if (pragma) return pragma;
  const orIgnore = translateInsertOrIgnore(sql);
  if (orIgnore) return bindPlaceholders(orIgnore).sql;
  const instr = translateInstr(sql);
  if (instr) return bindPlaceholders(instr).sql;
  return bindPlaceholders(sql).sql;
}

// ---------- libsql-shaped client ----------

export function isSupabaseConfigured() {
  return !!(cfg.SUPABASE_URL && cfg.SUPABASE_DB_URL);
}

function shapeResult(q) {
  // libsql ResultSets expose BOTH `changes` and `rowsAffected` (same value);
  // the app's CAS path reads rowsAffected, so provide both.
  const changes = q.rowCount ? parseInt(q.rowCount, 10) || 0 : 0;
  return {
    rows: q.rows || [],
    columns: q.fields ? q.fields.map(f => f.name) : (q.rows && q.rows[0] ? Object.keys(q.rows[0]) : []),
    changes,
    rowsAffected: changes,
    lastInsertRowid: null,
  };
}

async function runOne(sql, args = []) {
  const { client } = await acquirePg();
  let broke = false;
  try {
    const q = await client.query(translateSql(sql), args || []);
    return shapeResult(q);
  } catch (e) {
    if (isConnectionError(e)) {
      broke = true;
      const retry = await acquirePg();
      try {
        const q = await retry.client.query(translateSql(sql), args || []);
        return shapeResult(q);
      } catch (e2) {
        releasePg(retry, isConnectionError(e2));
        throw e2;
      }
    }
    throw e;
  } finally {
    releasePg({ client }, broke);
  }
}

// libsql `executeMultiple` returns an array with the LAST statement's result
// at the end plus a `results` array; the app only checks truthiness here.
// When the script has no placeholders it goes out as ONE pg simple-protocol
// round trip (node-pg executes a parameterless string query with all its
// statements in sequence) — N statements = 1 RTT instead of N, which keeps
// the cold-isolate bootstrap under the fault-domain timeout.
async function runMultiple(sql) {
  const trimmed = String(sql || '').trim();
  if (!trimmed) return { rows: [], changes: 0, lastInsertRowid: null, results: [] };
  if (!trimmed.includes('?')) {
    const { client } = await acquirePg();
    let broke = false;
    try {
      const q = await client.query(trimmed);
      const last = shapeResult(q);
      return { rows: last.rows, changes: last.changes, lastInsertRowid: last.lastInsertRowid, results: [last] };
    } catch (e) {
      if (isConnectionError(e)) {
        broke = true;
        const retry = await acquirePg();
        try {
          const q = await retry.client.query(trimmed);
          const last = shapeResult(q);
          return { rows: last.rows, changes: last.changes, lastInsertRowid: last.lastInsertRowid, results: [last] };
        } catch (e2) {
          releasePg(retry, isConnectionError(e2));
          throw e2;
        }
      }
      throw e;
    } finally {
      releasePg({ client }, broke);
    }
  }
  const statements = splitStatements(trimmed);
  const results = [];
  for (const st of statements) {
    results.push(await runOne(st));
  }
  const last = results[results.length - 1] || { rows: [], changes: 0, lastInsertRowid: null };
  return { rows: last.rows, changes: last.changes, lastInsertRowid: last.lastInsertRowid, results };
}

export function createSupabaseLibsqlClient() {
  return {
    __supabase: true,
    async execute(statement) {
      if (Array.isArray(statement)) return this.batch(statement);
      if (typeof statement === 'string') return runOne(statement);
      return runOne(statement.sql, statement.args);
    },
    async batch(statements) {
      // libsql returns a plain ARRAY of result sets (callers do batchRs[0]);
      // a .results self-reference is kept for the off-chance of the other shape.
      const results = [];
      for (const st of statements || []) {
        results.push(await runOne(typeof st === 'string' ? st : st.sql, typeof st === 'string' ? undefined : st.args));
      }
      results.results = results;
      return results;
    },
    executeMultiple: (sql) => runMultiple(sql),
  };
}

// ---------- statement splitting (DDL bootstrap only) ----------

// Splits a SQL script into executable statements. String literals, line
// comments, block comments and $$ dollar-quoted bodies (plpgsql functions)
// are respected so that semicolons inside them do not split.
export function splitStatements(script) {
  const out = [];
  let cur = '';
  let inStr = false;
  let inDq = false;
  let inLine = false;
  let inBlock = false;
  let inDollar = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const nx = script[i + 1];
    if (inLine) {
      cur += ch;
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      cur += ch;
      if (ch === '*' && nx === '/') { cur += '*/'; i++; inBlock = false; }
      continue;
    }
    if (inDollar) {
      if (script.startsWith(inDollar, i)) {
        cur += inDollar;
        i += inDollar.length - 1;
        inDollar = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (inStr) {
      cur += ch;
      if (ch === "'" && nx === "'") { cur += "''"; i++; continue; }
      if (ch === "'") inStr = false;
      continue;
    }
    if (inDq) {
      cur += ch;
      if (ch === '"') inDq = false;
      continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '"') { inDq = true; cur += ch; continue; }
    if (ch === '-' && nx === '-') { inLine = true; cur += ch; continue; }
    if (ch === '/' && nx === '*') { inBlock = true; cur += '/*'; i++; continue; }
    if (ch === '$') {
      const m = script.slice(i).match(/^\$[a-zA-Z_]*\$/);
      if (m) { inDollar = m[0]; cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (ch === ';') {
      const st = cur.trim();
      if (st) out.push(st);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}
