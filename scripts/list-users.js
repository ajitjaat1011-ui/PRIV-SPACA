const { createClient } = require('@libsql/client');

(async () => {
  const c = createClient({
    url: 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io',
    authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODMwMDIwNDUsImlkIjoiMDE5ZjIzMzMtZWYwMS03MDZjLTliMjgtMzAxN2JkNGRiMzg0Iiwia2lkIjoienVDWHBCUlUtOU1paW1aOW45NlhYRUJyRzdUU0U3Y1JJWG4zbE5rQUxzWSIsInJpZCI6ImZhZWI5ODQ1LWFmY2YtNDBkNy05MTQ3LTQxYmQ0ZTNjOThhOCJ9.QC4XCoH8yfu0br39fhLbuCZcQQP4O2k0-QLnenGrCj8otlasu30W3kkHLWMXPBvYkupbrVxGpBfH1TLroVwmDA'
  });
  const rs = await c.execute('SELECT id, username_lower, email_lower, created_at, data_json FROM ps_users ORDER BY created_at DESC');
  console.log('Total users:', rs.rows.length);
  console.log('');

  const testPattern = /^(tester_|test\d?_|agent_|prev_|cl\d?_|up\d?_|dbg_|final_|debug_|cloud_|upload_|signin_)/i;
  const testEmailPattern = /@test\.local$/i;
  const arvindPattern = /^arvindjaat1011$/i;
  const adminPattern = /@gmail\.com$/i;

  const tests = [];
  const reals = [];
  const admins = [];
  for (const r of rs.rows) {
    const email = String(r.email_lower || '');
    const username = String(r.username_lower || '');
    const createdAt = new Date(Number(r.created_at || 0)).toISOString();
    const isTestByName = testPattern.test(username);
    const isTestByEmail = testEmailPattern.test(email);
    const isAdmin = arvindPattern.test(username) || adminPattern.test(email);
    if (isAdmin) admins.push({ username, email, createdAt });
    else if (isTestByName || isTestByEmail) tests.push({ username, email, createdAt });
    else reals.push({ username, email, createdAt });
  }

  console.log('=== ADMIN (1) ===');
  for (const u of admins) console.log('  ' + u.username.padEnd(30) + '  ' + u.email.padEnd(35) + '  ' + u.createdAt);
  console.log();
  console.log('=== TEST users (' + tests.length + ') ===');
  for (const u of tests) console.log('  ' + u.username.padEnd(30) + '  ' + u.email.padEnd(35) + '  ' + u.createdAt);
  console.log();
  console.log('=== REAL users (' + reals.length + ') ===');
  for (const u of reals) console.log('  ' + u.username.padEnd(30) + '  ' + u.email.padEnd(35) + '  ' + u.createdAt);
})();
