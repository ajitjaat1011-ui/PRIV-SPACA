// Reset the owner's password to a known value, then test login
const { createClient } = require('@libsql/client');
const crypto = require('crypto');

const TURSO = 'libsql://priv-spaca-test-ajitjaat1011-ui.aws-ap-south-1.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODMwMDIwNDUsImlkIjoiMDE5ZjIzMzMtZWYwMS03MDZjLTliMjgtMzAxN2JkNGRiMzg0Iiwia2lkIjoienVDWHBCUlUtOU1paW1aOW45NlhYRUJyRzdUU0U3Y1JJWG4zbE5rQUxzWSIsInJpZCI6ImZhZWI5ODQ1LWFmY2YtNDBkNy05MTQ3LTQxYmQ0ZTNjOThhOCJ9.QC4XCoH8yfu0br39fhLbuCZcQQP4O2k0-QLnenGrCj8otlasu30W3kkHLWMXPBvYkupbrVxGpBfH1TLroVwmDA';

// Match the password-hashing scheme used in api/cf-worker.js
// Look at signup endpoint to figure out the scheme
(async () => {
  const c = createClient({ url: TURSO, authToken: TURSO_TOKEN });
  const rs = await c.execute("SELECT id, username_lower, email_lower, data_json FROM ps_users WHERE username_lower = 'arvind_1011'");
  if (rs.rows.length === 0) { console.log('Owner not found'); process.exit(1); }
  const u = JSON.parse(String(rs.rows[0].data_json));
  console.log('Owner found:', u.username, '| id:', u.id);
  // Look for the password field
  console.log('Has passwordHash:', !!u.passwordHash);
  console.log('Has passhash:', !!u.passhash);
  console.log('Has passHash:', !!u.passHash);
  console.log('Has password:', !!u.password);
  // Print keys for debugging (omit sensitive)
  const keys = Object.keys(u).filter(k => !k.toLowerCase().includes('pass') && !k.toLowerCase().includes('token'));
  console.log('User keys:', keys);
  // Check PIN
  console.log('Has pinHash:', !!u.pinHash);
  console.log('Has pinhash:', !!u.pinhash);
  console.log('Has pin:', !!u.pin);
})();
