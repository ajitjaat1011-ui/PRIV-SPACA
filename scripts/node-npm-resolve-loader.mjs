/**
 * Dev-only Node loader — maps Deno/Supabase-edge style `npm:` specifiers to
 * the locally installed package so plain Node can import the api/ modules
 * during unit tests (scripts/test-v170.mjs, v169 suite, etc.).
 *
 * Why: api/lib/store-supabase.js imports `npm:pg@8.11.3` STATICALLY (the
 * Supabase edge runtime requires a static import to register the package).
 * Plain Node cannot resolve the `npm:` URL scheme, which breaks any suite
 * that imports api/lib (store-turso re-exports store-supabase helpers).
 * check.mjs bundles with `--alias:npm:pg@8.11.3=pg`; render/build.mjs
 * rewrites the specifier string; this loader is the equivalent for direct
 * ESM imports under Node. It is NOT used by any production entrypoint.
 *
 * Registered by scripts/node-register-npm.mjs (see package.json test
 * scripts). No production code depends on this file.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('npm:')) {
    // npm:pg@8.11.3            -> pg
    // npm:@scope/pkg@1.2.3     -> @scope/pkg
    // npm:@scope/pkg           -> @scope/pkg
    let name = specifier.slice(4);
    if (name.startsWith('@')) {
      const slash = name.indexOf('/');
      if (slash !== -1) {
        const at = name.indexOf('@', slash);
        if (at !== -1) name = name.slice(0, at);
      }
    } else {
      const at = name.indexOf('@');
      if (at > 0) name = name.slice(0, at);
    }
    try {
      return { url: pathToFileURL(require.resolve(name)).href, shortCircuit: true };
    } catch {
      // Not installed locally — let the default resolver report the error.
      return nextResolve(specifier, context);
    }
  }
  return nextResolve(specifier, context);
}
