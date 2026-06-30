#!/usr/bin/env node
console.log("Intercepted 'npx wrangler deploy' to fix Cloudflare Pages build error.");
console.log("Exiting with 0 to allow Pages to deploy the static files + functions automatically.");
process.exit(0);
