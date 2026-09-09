// PRIV SPACA — Render build: bundle the Hono API (written for CF/Deno) into
// a single Node ESM file with all deps (hono, pg) inlined.
//
// The API uses Deno-style `npm:pg@8.11.3` import specifiers; esbuild cannot
// resolve those for platform=node, so we rewrite them to plain `pg` (which
// comes from the repo root package.json) in a temp copy before bundling.

import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const tmpApi = join(repoRoot, '.tmp-api-node');
// CJS output: the dep tree (pg and friends) contains CJS modules whose
// dynamic require() breaks under --format=esm in Node.
const outfile = join(here, 'dist', 'api.bundle.cjs');

rmSync(tmpApi, { recursive: true, force: true });
mkdirSync(tmpApi, { recursive: true });
cpSync(join(repoRoot, 'api'), tmpApi, { recursive: true });

// Rewrite Deno npm: specifiers -> plain node resolvable names.
const walkDir = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) {
      walkDir(p);
    } else if (p.endsWith('.js')) {
      const src = readFileSync(p, 'utf8');
      if (src.includes('npm:pg@8.11.3')) {
        writeFileSync(p, src.split("'npm:pg@8.11.3'").join("'pg'"));
        console.log('[render:build] rewrote npm:pg specifier in', p.slice(repoRoot.length + 1));
      }
    }
  }
};
walkDir(tmpApi);

try {
  await build({
    entryPoints: [join(tmpApi, 'cf-worker.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    minify: true,
    sourcemap: false,
    outfile,
    alias: { crypto: 'node:crypto' },
    logLevel: 'warning',
    banner: { js: '// PRIV SPACA API — bundled for Node (render) — do not edit' },
  });
} finally {
  rmSync(tmpApi, { recursive: true, force: true });
}

console.log(`[render:build] wrote ${outfile.slice(repoRoot.length + 1)} (${statSync(outfile).size} bytes)`);
