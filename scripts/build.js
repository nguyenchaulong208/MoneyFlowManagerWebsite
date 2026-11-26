const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_ANON_KEY in the build environment before deploying.');
}

let endpoint;
try {
  endpoint = new URL(supabaseUrl);
} catch {
  throw new Error('SUPABASE_URL must be a valid HTTPS URL.');
}
if (endpoint.protocol !== 'https:' || /your-|placeholder|example/i.test(supabaseUrl + supabaseAnonKey)) {
  throw new Error('Use your real Supabase project URL and public anon/publishable key in the build environment.');
}
if (supabaseAnonKey.startsWith('sb_secret_')) {
  throw new Error('A Supabase secret key cannot be included in a browser build; use the public anon/publishable key.');
}
const tokenPayload = supabaseAnonKey.split('.')[1];
if (tokenPayload) {
  let claims;
  try {
    claims = JSON.parse(Buffer.from(tokenPayload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('SUPABASE_ANON_KEY is not a valid public anon/publishable key.');
  }
  if (claims.role === 'service_role') throw new Error('A service-role key cannot be included in a browser build; use the public anon/publishable key.');
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js']) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
fs.cpSync(path.join(root, 'assets'), path.join(output, 'assets'), { recursive: true });
fs.writeFileSync(
  path.join(output, 'supabase-config.js'),
  `window.SUPABASE_CONFIG = ${JSON.stringify({ url: supabaseUrl, anonKey: supabaseAnonKey })};\n`,
  { encoding: 'utf8', mode: 0o600 },
);
