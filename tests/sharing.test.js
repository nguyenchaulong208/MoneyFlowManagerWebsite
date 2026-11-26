const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const schema = read('supabase/schema.sql');
const app = read('app.js');
const inviteFunction = read('supabase/functions/send-invite/index.ts');
const supabaseConfig = read('supabase/config.toml');

test('all financial tables require membership in the exact space', () => {
  for (const table of ['transactions', 'assets', 'debts']) {
    assert.match(schema, new RegExp(`create policy "Members can view space ${table}"[\\s\\S]*?using \\(public\\.is_space_member\\(space_id\\)\\)`));
    assert.match(schema, new RegExp(`create policy "Members can add space ${table}"[\\s\\S]*?with check \\(user_id = \\(select auth\\.uid\\(\\)\\) and public\\.is_space_member\\(space_id\\)\\)`));
    assert.match(schema, new RegExp(`create policy "Members can edit space ${table}"[\\s\\S]*?using \\(public\\.is_space_member\\(space_id\\)\\)`));
    assert.match(schema, new RegExp(`create policy "Members can remove space ${table}"[\\s\\S]*?using \\(public\\.is_space_member\\(space_id\\)\\)`));
  }
  assert.match(schema, /drop policy if exists "Users manage their own transactions"/);
  assert.match(schema, /drop policy if exists "Users manage their own assets"/);
  assert.match(schema, /drop policy if exists "Users manage their own debts"/);
});

test('invitations are hashed, expiring, single-use, verified, and role-guarded', () => {
  assert.match(schema, /encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/);
  assert.match(schema, /extensions\.digest\(convert_to\(invite_token, 'UTF8'\), 'sha256'\)/);
  assert.match(schema, /expires_at timestamptz not null default \(now\(\) \+ interval '7 days'\)/);
  assert.match(schema, /select \* into invitation[\s\S]*?for update/);
  assert.match(schema, /invitation\.accepted_at is not null or invitation\.revoked_at is not null/);
  assert.match(schema, /email_verified/);
  assert.match(schema, /invitation\.invited_email <> current_email/);
  assert.match(schema, /Only a space owner or admin can invite members/);
  assert.match(schema, /Only the space owner can delete a family space/);
  assert.match(schema, /revoke_space_invite\(uuid, text\) from public, anon/);
  assert.match(schema, /grant execute on function public\.revoke_space_invite\(uuid, text\) to authenticated/);
  assert.match(schema, /Backup restore and clear are only available in your personal space/);
});

test('client requires authentication and scopes reads and writes to the selected space', () => {
  assert.match(app, /#appContent'\)\.hidden = !activeUser \|\| !activeSpace \|\| authLoading/);
  assert.match(app, /signInWithPassword/);
  assert.match(app, /signUp\(/);
  assert.match(app, /signInWithOAuth\(\{\s*provider: 'google'/);
  assert.match(app, /\.eq\('space_id', spaceId\)/);
  assert.match(app, /space_id:activeSpace\.id/);
  assert.match(app, /replaceCloudData[\s\S]*?activeSpace\.kind !== 'personal'/);
  assert.doesNotMatch(app, /localStorage\.setItem\(STORAGE_KEY/);
});

test('email invitation endpoint authenticates the caller and never uses a service-role key', () => {
  assert.match(supabaseConfig, /\[functions\.send-invite\]\s+verify_jwt = true/);
  assert.match(inviteFunction, /supabase\.auth\.getUser\(\)/);
  assert.match(inviteFunction, /create_space_invite/);
  assert.match(inviteFunction, /revoke_space_invite/);
  assert.match(inviteFunction, /api\.resend\.com\/emails/);
  assert.doesNotMatch(inviteFunction, /SERVICE_ROLE|service_role|sb_secret_/i);
});
