// Regenerates supabase/functions/app/assets-b64.ts from the static files in
// supabase/functions/app/ (gzip + base64, embedded so the edge function is a
// single deploy unit).
//
//   node scripts/gen-assets-b64.mjs

import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'supabase', 'functions', 'app');
const outPath = join(appDir, 'assets-b64.ts');

const EXCLUDE = new Set(['index.ts', 'worker-bundle.js', 'assets-b64.ts', 'config.toml']);
const EXCLUDE_DIRS = new Set(['.temp']);

const files = [];
(function walk(dir, prefix = '') {
  for (const name of readdirSync(dir).sort()) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const p = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(p).isDirectory()) {
      walk(p, rel);
    } else {
      if (!prefix && EXCLUDE.has(name)) continue;
      files.push({ path: p, key: rel });
    }
  }
})(appDir);

const entries = files.map(({ path, key }) => {
  const raw = readFileSync(path);
  const b64 = gzipSync(raw, { level: 9 }).toString('base64');
  return `  [${JSON.stringify(key)}, ${JSON.stringify(b64)}],`;
});

const header = `// @ts-nocheck
// AUTO-GENERATED — embedded static site assets (base64).
// Regenerate: node scripts/gen-assets-b64.mjs
export const ASSETS = new Map<string, string>([
`;
const out = header + entries.join('\n') + '\n]);\n';
writeFileSync(outPath, out);
console.log(`[gen-assets-b64] ${files.length} assets -> ${relative(here, outPath)} (${statSync(outPath).size} bytes)`);
