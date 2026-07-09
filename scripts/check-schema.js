const { createClient } = require('@libsql/client');
const TURSO = 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
if (!TURSO_TOKEN) { console.error('Refusing to run: TURSO_AUTH_TOKEN env var is required.'); process.exit(2); }
(async () => {
  const c = createClient({ url: TURSO, authToken: TURSO_TOKEN });
  // Check schema of ps_users
  const schema = await c.execute("PRAGMA table_info(ps_users)");
  console.log('ps_users columns:');
  for (const r of schema.rows) console.log(' ', r.name, r.type);
  // Run the exact query the login uses
  const idLower = 'anushka_1011';
  console.log('\nRunning the new query with idLower =', idLower);
  const r = await c.execute({
    sql: "SELECT data_json FROM ps_users WHERE LOWER(username) = ? OR LOWER(email) = ? LIMIT 1",
    args: [idLower, idLower]
  });
  console.log('Rows returned:', r.rows.length);
  // Also try with the lowercase column
  const r2 = await c.execute({
    sql: "SELECT data_json FROM ps_users WHERE username_lower = ? OR email_lower = ? LIMIT 1",
    args: [idLower, idLower]
  });
  console.log('username_lower query rows:', r2.rows.length);
  if (r2.rows.length) {
    const d = JSON.parse(String(r2.rows[0].data_json));
    console.log('  username:', d.username, '| passwordHash prefix:', d.passwordHash?.slice(0,30));
  }
})();
