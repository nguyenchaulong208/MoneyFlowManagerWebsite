const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20261127000000_financial_ledger_reporting.sql');
const app = read('app.js');
const html = read('index.html');

test('ledger migration is additive and preserves legacy transaction identity and labels', () => {
  assert.match(migration, /add column if not exists linked_asset_id text/i);
  assert.match(migration, /add column if not exists linked_debt_id text/i);
  assert.match(migration, /add column if not exists balance_effect text/i);
  assert.match(migration, /create index if not exists transactions_space_date_id_idx/i);
  assert.match(migration, /create table if not exists public\.transaction_categories/i);
  assert.doesNotMatch(migration, /drop table|alter column id|update public\.transactions\s+set\s+category/i);
});

test('linked balance changes are space-scoped and reversed only when the effect changes or is deleted', () => {
  assert.match(migration, /foreign key \(linked_asset_id\)[\s\S]*?on delete set null/i);
  assert.match(migration, /foreign key \(linked_debt_id\)[\s\S]*?on delete set null/i);
  assert.match(migration, /effect_changed :=[\s\S]*?is distinct from/i);
  assert.match(migration, /after insert or update or delete on public\.transactions/i);
  assert.match(migration, /where id = new\.linked_asset_id and space_id = new\.space_id/i);
  assert.match(migration, /where id = new\.linked_debt_id and space_id = new\.space_id/i);
  assert.match(migration, /set value = value \+ new\.amount \* new_sign/i);
  assert.match(migration, /set value = value - old\.amount \* old_sign/i);
});

test('transaction RPC uses a space-scoped composite keyset cursor and server-side aggregates', () => {
  assert.match(migration, /public\.is_space_member\(p_space_id\)/);
  assert.match(migration, /\(tx\.date, tx\.id\) < \(p_before_date, p_before_id\)/i);
  assert.match(migration, /order by tx\.date desc, tx\.id desc/i);
  assert.match(migration, /create index if not exists transactions_space_type_date_id_idx/i);
  assert.match(migration, /public\.get_space_financial_summary/i);
  assert.match(migration, /month_categories/i);
  assert.match(app, /rpc\('list_space_transactions'/);
  assert.match(app, /rpc\('get_space_financial_summary'/);
  assert.match(app, /data\.transactions\.push\(\.\.\.page\.transactions\)/);
  assert.match(html, /id="loadMoreTransactions"/);
});

test('categories archive instead of delete and recorded transaction labels remain snapshots', () => {
  assert.match(migration, /is_archived boolean not null default false/i);
  assert.match(migration, /revoke delete on public\.transaction_categories from public, anon, authenticated/i);
  assert.match(migration, /set is_archived = true/i);
  assert.match(app, /rpc\('archive_transaction_category'/);
  assert.match(app, /category:item\.category/);
  assert.match(html, /Danh mục đã dùng chỉ có thể lưu trữ/);
});

test('restore subtracts linked effects before replaying them', () => {
  assert.match(migration, /value'\)::bigint - coalesce\([\s\S]*?linked_asset_id/i);
  assert.match(migration, /amount'\)::bigint - coalesce\([\s\S]*?linked_debt_id/i);
  assert.match(migration, /linked_asset_id, linked_debt_id, balance_effect/i);
  assert.match(app, /transactions:await fetchAllTransactions\(activeSpace\.id\)/);
});
