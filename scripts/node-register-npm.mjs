/**
 * Dev-only — registers the npm: specifier loader (see
 * node-npm-resolve-loader.mjs). Used via:
 *   node --import ./scripts/node-register-npm.mjs <suite>
 * Works on Node >= 20.6 (module.register) and Node 22+ without flags.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./node-npm-resolve-loader.mjs', import.meta.url);
