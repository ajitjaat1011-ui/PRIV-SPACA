const { createClient } = require('@libsql/client');
const TURSO = 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODMwMDIwNDUsImlkIjoiMDE5ZjIzMzMtZWYwMS03MDZjLTliMjgtMzAxN2JkNGRiMzg0Iiwia2lkIjoienVDWHBCUlUtOU1paW1aOW45NlhYRUJyRzdUU0U3Y1JJWG4zbE5rQUxzWSIsInJpZCI6ImZhZWI5ODQ1LWFmY2YtNDBkNy05MTQ3LTQxYmQ0ZTNjOThhOCJ9.QC4XCoH8yfu0br39fhLbuCZcQQP4O2k0-QLnenGrCj8otlasu30W3kkHLWMXPBvYkupbrVxGpBfH1TLroVwmDA';
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
