const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20261127000000_financial_ledger_reporting.sql');
const movementMigration = read('supabase/migrations/20261127010000_account_movement_ledger.sql');
const completionMigration = read('supabase/migrations/20261127120000_finance_dashboard_and_labels.sql');
const parityCheck = read('supabase/verification/ledger-parity.sql');
const app = read('app.js');
const html = read('index.html');
const readme = read('README.md');

function splitTopLevelSqlList(sql) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote && sql[index + 1] === quote) index += 1;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(sql.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(sql.slice(start).trim());
  return parts;
}

function assertOpeningBackfillShape(table, accountKind) {
  const statement = movementMigration.match(new RegExp(
    `insert\\s+into\\s+public\\.account_movements\\s*\\(([^)]*)\\)\\s*select\\s+([^;]*?)\\s+from\\s+public\\.${table}\\s+as\\s+item\\s+on\\s+conflict\\s*\\(idempotency_key\\)\\s+do\\s+nothing`,
    'i'
  ));
  assert.ok(statement, `missing ${table} opening movement backfill`);
  const columns = splitTopLevelSqlList(statement[1]);
  const expressions = splitTopLevelSqlList(statement[2]);
  assert.equal(expressions.length, columns.length, `${table} backfill select/target column count`);
  assert.deepEqual(columns, [
    'space_id', 'account_kind', 'account_id', 'account_name',
    'amount', 'movement_type', 'occurred_at', 'idempotency_key'
  ]);
  assert.equal(expressions[1], `'${accountKind}'`);
  assert.equal(expressions[5], "'opening'");
  assert.equal(expressions[6], 'item.created_at');
}

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
  assert.match(app, /rpc\('get_space_financial_summary_v2'/);
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

test('durable movements are space-scoped, append-only, and reverse transaction effects', () => {
  assert.match(movementMigration, /create table if not exists public\.account_movements/i);
  assert.match(movementMigration, /enable row level security/i);
  assert.match(movementMigration, /Members can view account movements/i);
  assert.match(movementMigration, /revoke insert, update, delete on public\.space_finance_types, public\.account_movements/i);
  assert.match(movementMigration, /movement_type in \([\s\S]*?'opening'[\s\S]*?'transaction_reversal'/i);
  assert.match(movementMigration, /transaction_reversal', old\.id, 1/i);
  assert.match(movementMigration, /transaction_reversal', old\.id, 2/i);
  assert.match(movementMigration, /apply_account_movement/i);
});

test('opening movement backfills provide every target column in order', () => {
  assertOpeningBackfillShape('assets', 'asset');
  assertOpeningBackfillShape('debts', 'liability');
  assert.ok(/^begin;\s*$/im.test(movementMigration));
  assert.ok(/^commit;\s*$/im.test(movementMigration));
});

test('two-leg transfers, purchases, repayments, and borrowing preserve balance semantics', () => {
  assert.match(movementMigration, /source_delta := -p_amount;\s+destination_delta := p_amount/i);
  assert.match(movementMigration, /source_delta := -p_amount;\s+destination_delta := -p_amount/i);
  assert.match(movementMigration, /source_delta := p_amount;\s+destination_delta := p_amount/i);
  assert.match(movementMigration, /balance_movement_type in \('purchase', 'transfer'\)[\s\S]*?balance_effect = 'increase'[\s\S]*?balance_effect_2 = 'decrease'/i);
  assert.match(movementMigration, /monthly_debt_repayments/i);
  assert.match(movementMigration, /source_transaction_id is null/i);
  assert.match(movementMigration, /linked_debt_id_2 is not null[\s\S]*?balance_movement_type_2 = 'repayment'/i);
});

test('finance types and liquid assets drive server-side balances and reports', () => {
  assert.match(movementMigration, /create table if not exists public\.space_finance_types/i);
  assert.match(movementMigration, /is_liquid boolean not null default false/i);
  assert.match(movementMigration, /create or replace function public\.create_space_finance_type/i);
  assert.match(movementMigration, /set_space_finance_type_liquidity/i);
  assert.match(movementMigration, /'liquid_assets_value'/i);
  assert.match(movementMigration, /'assets_by_type'/i);
  assert.match(movementMigration, /'liabilities_by_type'/i);
  assert.match(movementMigration, /'income_expense_ratio'/i);
  assert.match(movementMigration, /'savings_rate'/i);
  assert.match(app, /rpc\('create_space_finance_type'/);
  assert.match(app, /rpc\('set_space_finance_type_liquidity'/);
  assert.match(html, /id="financeTypeManager"/);
});

test('account and movement history reads are bounded and keyset-paginated', () => {
  assert.match(movementMigration, /public\.list_space_assets/i);
  assert.match(movementMigration, /public\.list_space_liabilities/i);
  assert.match(movementMigration, /public\.list_space_balance_movements/i);
  assert.match(movementMigration, /\(item\.created_at, item\.id\) < \(p_before_created_at, p_before_id\)/i);
  assert.match(movementMigration, /limit p_limit/i);
  assert.match(movementMigration, /search requires at least two characters/i);
  assert.match(movementMigration, /p_limit not between 1 and 25/i);
  assert.doesNotMatch(app, /from\('assets'\)\.select/);
  assert.doesNotMatch(app, /from\('debts'\)\.select/);
  assert.match(app, /fetchAllAccounts\(activeSpace\.id, 'asset', true\)/);
  assert.match(app, /fetchAllMovements\(activeSpace\.id\)/);
  assert.match(html, /id="loadMoreAssets"/);
  assert.match(html, /id="loadMoreDebts"/);
  assert.match(html, /id="loadMoreMovements"/);
});

test('restore preserves archived accounts and imported movement history without replaying it', () => {
  assert.match(movementMigration, /p_movements jsonb/i);
  assert.match(movementMigration, /app\.import_movement_history/i);
  assert.match(movementMigration, /app\.skip_transaction_movement/i);
  assert.match(movementMigration, /on conflict do nothing/i);
  assert.match(movementMigration, /p_include_archived boolean default false/i);
  assert.match(app, /p_movements: replacement\.movements \|\| \[\]/);
  assert.match(app, /dong-tien-backup-v2/);
  assert.match(readme, /bản sao lưu v2 bao gồm/i);
});

test('overview shows server totals and paginates configurable liquid assets in a bounded list', () => {
  assert.match(html, /id="availableValue"/);
  assert.match(html, /id="overviewAssetTotal"/);
  assert.match(html, /id="overviewLiquidTotal"/);
  assert.match(html, /id="toggleLiquidAssets"/);
  assert.match(app, /rpc\('list_space_liquid_assets'/);
  assert.match(app, /fetchTransactionPage\(spaceId, null, 'all', 4\)/);
  assert.match(app, /data\.summary\.liquid_assets_value/);
  assert.match(completionMigration, /public\.is_space_member\(p_space_id\)/);
  assert.match(completionMigration, /finance_type\.is_liquid/);
  assert.match(completionMigration, /\(item\.created_at, item\.id\) < \(p_before_created_at, p_before_id\)/i);
  assert.match(completionMigration, /where item\.space_id = p_space_id/i);
  assert.match(read('styles.css'), /\.liquid-assets-list\.expanded\s*\{\s*overflow-y:\s*auto/s);
  assert.match(read('styles.css'), /\.liquid-assets-list\s*\{\s*max-height:\s*240px/s);
});

test('report cards label current balances, reporting period, and formula semantics', () => {
  assert.match(html, /id="analysisPeriodDescription"/);
  assert.match(app, /TỔNG TÀI SẢN/);
  assert.match(app, /TÀI SẢN THANH KHOẢN/);
  assert.match(app, /DÒNG TIỀN RÒNG/);
  assert.match(completionMigration, /'month_net_cash_flow', period_income - period_expense/);
  assert.match(app, /Chi tiêu trong kỳ ÷ thu nhập trong kỳ/);
  assert.match(app, /Dòng tiền ròng trong kỳ ÷ thu nhập trong kỳ/);
  assert.match(completionMigration, /period_expense \/ nullif\(period_income, 0\)/);
  assert.match(completionMigration, /\(period_income - period_expense\) \/ nullif\(period_income, 0\)/);
});

test('category and finance type labels can be renamed without rewriting transaction history', () => {
  assert.match(completionMigration, /create or replace function public\.rename_transaction_category/i);
  assert.match(completionMigration, /set type = p_type, label = normalized_label/i);
  assert.match(completionMigration, /create or replace function public\.rename_space_finance_type/i);
  assert.match(app, /rpc\('rename_transaction_category'/);
  assert.match(app, /rpc\('rename_space_finance_type'/);
  assert.match(app, /p_type: type, p_label: label/);
  assert.match(app, /category:item\.category/);
  assert.match(app, /data-save-category/);
  assert.match(app, /data-save-finance-type/);
  const categorySubmit = app.slice(app.indexOf("$('#categoryForm').addEventListener"), app.indexOf("$('#financeTypeForm').addEventListener"));
  assert.doesNotMatch(categorySubmit, /financeTypeForm/);
  assert.equal((app.match(/\$\('#financeTypeForm'\)\.addEventListener\('submit'/g) || []).length, 1);
});

test('migration parity check detects balance drift and missing linked transaction legs', () => {
  assert.match(parityCheck, /sum\(amount\) as ledger_balance/i);
  assert.match(parityCheck, /stored_balance is distinct from/i);
  assert.match(parityCheck, /transaction_leg = linked_legs\.transaction_leg/i);
  assert.match(completionMigration, /get_space_financial_summary_v2/i);
  assert.match(readme, /ledger-parity\.sql/i);
});
