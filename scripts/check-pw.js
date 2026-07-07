const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const TURSO = 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
if (!TURSO_TOKEN) { console.error('Refusing to run: TURSO_AUTH_TOKEN env var is required.'); process.exit(2); }
(async () => {
  const c = createClient({ url: TURSO, authToken: TURSO_TOKEN });
  // Get the structured row
  const u = await c.execute("SELECT data_json FROM ps_users WHERE username_lower = 'anushka_1011'");
  const userStructured = JSON.parse(String(u.rows[0].data_json));
  // Get the ps_kv mirror
  const kv = await c.execute("SELECT value FROM ps_kv WHERE key = 'db'");
  const db = JSON.parse(String(kv.rows[0].value));
  const userMirror = db.users.find(x => x.id === userStructured.id);
  console.log('--- structured row ---');
  console.log('  username:', userStructured.username);
  console.log('  email:', userStructured.email);
  console.log('  passwordHash:', userStructured.passwordHash);
  console.log('--- ps_kv mirror ---');
  console.log('  username:', userMirror?.username);
  console.log('  email:', userMirror?.email);
  console.log('  passwordHash:', userMirror?.passwordHash);
  // Test the password against the mirror's hash
  const ok = await bcrypt.compare('TestPass123!', userMirror?.passwordHash || '');
  console.log('--- bcrypt test ---');
  console.log('  TestPass123! matches mirror hash?', ok);
  const ok2 = await bcrypt.compare('TestPass123!', userStructured.passwordHash);
  console.log('  TestPass123! matches structured hash?', ok2);
})();
