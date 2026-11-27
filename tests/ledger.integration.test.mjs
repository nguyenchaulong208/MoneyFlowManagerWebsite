import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(root, 'supabase', 'migrations');
const movementSql = fs.readFileSync(path.join(migrationDir, '20261127010000_account_movement_ledger.sql'), 'utf8');
const reportingSql = fs.readFileSync(path.join(migrationDir, '20261127000000_financial_ledger_reporting.sql'), 'utf8');
const dashboardSql = fs.readFileSync(path.join(migrationDir, '20261127120000_finance_dashboard_and_labels.sql'), 'utf8');
const movementFixSql = fs.readFileSync(path.join(migrationDir, '20261127130000_account_movement_leg_cast_fix.sql'), 'utf8');
const rpcDiagnosticsSql = fs.readFileSync(
  path.join(root, 'supabase', 'verification', 'rpc-diagnostics.sql'),
  'utf8',
);

const SPACE_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const CASH_TYPE_ID = '00000000-0000-4000-8000-000000000011';
const INVESTMENT_TYPE_ID = '00000000-0000-4000-8000-000000000012';
const LOAN_TYPE_ID = '00000000-0000-4000-8000-000000000013';

function extractFunction(source, name) {
  const definition = source.match(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`,
    'i',
  ));
  assert.ok(definition, `could not find public.${name} in its migration`);
  return definition[0];
}

function extractTable(source, name) {
  const definition = source.match(new RegExp(
    `create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${name}\\s*\\([\\s\\S]*?\\n\\);`,
    'i',
  ));
  assert.ok(definition, `could not find public.${name} in its migration`);
  return definition[0];
}

async function createLedgerDatabase() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create function auth.uid() returns uuid language sql stable
      as $$ select '${USER_ID}'::uuid $$;
    create function public.is_space_member(p_space_id uuid) returns boolean
      language sql stable as $$ select p_space_id is not null $$;

    create table public.spaces (
      id uuid primary key,
      kind text not null default 'personal'
    );
    insert into public.spaces (id) values ('${SPACE_ID}');
  `);
  await db.exec(extractTable(movementSql, 'space_finance_types'));
  await db.exec(extractTable(movementSql, 'account_movements'));
  await db.exec(`
    create table public.assets (
      id text primary key,
      space_id uuid not null,
      name text not null,
      kind text not null,
      value bigint not null,
      account_type_id uuid not null,
      is_archived boolean not null default false,
      created_at timestamptz not null default now()
    );
    create table public.debts (
      id text primary key,
      space_id uuid not null,
      name text not null,
      kind text not null,
      amount bigint not null,
      account_type_id uuid not null,
      is_archived boolean not null default false,
      created_at timestamptz not null default now()
    );
    create table public.transactions (
      id text primary key,
      space_id uuid not null,
      type text not null,
      amount bigint not null,
      category text not null default '',
      note text not null default '',
      date timestamptz not null,
      linked_asset_id text,
      linked_debt_id text,
      balance_effect text,
      linked_asset_id_2 text,
      linked_debt_id_2 text,
      balance_effect_2 text,
      balance_movement_type text,
      balance_movement_type_2 text
    );
    insert into public.space_finance_types (id, space_id, account_kind, code, label, is_liquid)
    values
      ('${CASH_TYPE_ID}', '${SPACE_ID}', 'asset', 'cash', 'Cash', true),
      ('${INVESTMENT_TYPE_ID}', '${SPACE_ID}', 'asset', 'investment', 'Investments', false),
      ('${LOAN_TYPE_ID}', '${SPACE_ID}', 'liability', 'loan', 'Loans', false);
  `);

  for (const [source, name] of [
    [movementSql, 'apply_account_movement'],
    [movementSql, 'capture_asset_opening_movement'],
    [movementSql, 'capture_liability_opening_movement'],
    [movementSql, 'append_transaction_account_movement'],
    [movementSql, 'apply_transaction_balance_effect'],
    [movementSql, 'record_account_transfer'],
    [movementSql, 'record_account_movement'],
    [reportingSql, 'list_space_transactions'],
    [movementSql, 'get_space_financial_summary'],
    [dashboardSql, 'get_space_financial_summary_v2'],
  ]) {
    await db.exec(extractFunction(source, name));
  }

  await db.exec(movementFixSql);
  await db.exec(`
    create trigger apply_account_movement after insert on public.account_movements
      for each row execute function public.apply_account_movement();
    create trigger capture_asset_opening_movement after insert on public.assets
      for each row execute function public.capture_asset_opening_movement();
    create trigger capture_liability_opening_movement after insert on public.debts
      for each row execute function public.capture_liability_opening_movement();
    create trigger apply_transaction_balance_effect after insert or update or delete on public.transactions
      for each row execute function public.apply_transaction_balance_effect();
  `);
  return db;
}

async function insertAsset(db, id, name, value, typeId = CASH_TYPE_ID) {
  await db.query(
    `insert into public.assets (id, space_id, name, kind, value, account_type_id)
     values ($1, $2, $3, 'cash', $4, $5)`,
    [id, SPACE_ID, name, value, typeId],
  );
}

async function insertDebt(db, id, name, amount) {
  await db.query(
    `insert into public.debts (id, space_id, name, kind, amount, account_type_id)
     values ($1, $2, $3, 'loan', $4, $5)`,
    [id, SPACE_ID, name, amount, LOAN_TYPE_ID],
  );
}

async function insertTransaction(db, {
  id, amount, type = 'expense', linkedAssetId = null, balanceEffect = null,
  linkedAssetId2 = null, balanceEffect2 = null, linkedDebtId = null,
  linkedDebtId2 = null, movementType = null, movementType2 = null,
}) {
  await db.query(
    `insert into public.transactions (
       id, space_id, type, amount, category, note, date,
       linked_asset_id, linked_debt_id, balance_effect,
       linked_asset_id_2, linked_debt_id_2, balance_effect_2,
       balance_movement_type, balance_movement_type_2
     ) values ($1, $2, $3, $4, 'Test', '', now(), $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id, SPACE_ID, type, amount, linkedAssetId, linkedDebtId, balanceEffect,
      linkedAssetId2, linkedDebtId2, balanceEffect2, movementType, movementType2,
    ],
  );
}

async function accountBalance(db, table, column, id) {
  const { rows } = await db.query(`select ${column} from public.${table} where id = $1`, [id]);
  return Number(rows[0][column]);
}

async function financialSummary(db) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const { rows } = await db.query(
    `select public.get_space_financial_summary_v2($1, $2, $3) as summary`,
    [SPACE_ID, start.toISOString(), end.toISOString()],
  );
  return rows[0].summary;
}

test('real ledger triggers reverse linked transaction edits and deletes; unlinked rows do nothing', async () => {
  const db = await createLedgerDatabase();
  try {
    await insertAsset(db, 'cash-1', 'Cash', 1000);
    const { rows: permissions } = await db.query(
      `select has_function_privilege(
         'authenticated',
         'public.append_transaction_account_movement(uuid,text,text,bigint,text,text,integer,text,timestamptz)',
         'execute'
       ) as can_execute`,
    );
    assert.equal(permissions[0].can_execute, false);
    await insertTransaction(db, { id: 'unlinked', amount: 40 });
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 1000);
    let { rows } = await db.query(
      `select count(*)::int as count from public.account_movements where source_transaction_id = 'unlinked'`,
    );
    assert.equal(rows[0].count, 0);

    await db.query(
      `insert into public.transactions (
         id, space_id, type, amount, category, date, linked_asset_id, balance_effect
       ) values ('linked', $1, 'expense', 100, 'Test', now(), 'cash-1', 'decrease')`,
      [SPACE_ID],
    );
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 900);

    await db.query(`update public.transactions set amount = 150 where id = 'linked'`);
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 850);
    await db.query(`delete from public.transactions where id = 'linked'`);
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 1000);

    ({ rows } = await db.query(
      `select coalesce(sum(amount), 0)::bigint as balance
       from public.account_movements where account_kind = 'asset' and account_id = 'cash-1'`,
    ));
    assert.equal(Number(rows[0].balance), 1000);
    ({ rows } = await db.query(
      `select count(*)::int as count from public.account_movements where source_transaction_id = 'linked'`,
    ));
    assert.equal(rows[0].count, 4);
  } finally {
    await db.close();
  }
});

test('paired purchase and transfer legs preserve total assets and count purchases once', async () => {
  const db = await createLedgerDatabase();
  try {
    await insertAsset(db, 'cash-1', 'Cash', 1000);
    await insertAsset(db, 'fund-1', 'Fund', 500, INVESTMENT_TYPE_ID);
    await insertTransaction(db, {
      id: 'purchase-1',
      amount: 100,
      linkedAssetId: 'cash-1',
      balanceEffect: 'decrease',
      linkedAssetId2: 'fund-1',
      balanceEffect2: 'increase',
      movementType: 'purchase',
      movementType2: 'purchase',
    });

    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 900);
    assert.equal(await accountBalance(db, 'assets', 'value', 'fund-1'), 600);
    let summary = await financialSummary(db);
    assert.equal(Number(summary.assets_value), 1500);
    assert.equal(Number(summary.monthly_asset_purchases), 100);
    let { rows } = await db.query(
      `select count(*)::int as count from public.account_movements
       where source_transaction_id = 'purchase-1' and movement_type = 'purchase'`,
    );
    assert.equal(rows[0].count, 2);

    await db.query(`update public.transactions set amount = 125 where id = 'purchase-1'`);
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 875);
    assert.equal(await accountBalance(db, 'assets', 'value', 'fund-1'), 625);
    summary = await financialSummary(db);
    assert.equal(Number(summary.assets_value), 1500);
    assert.equal(Number(summary.monthly_asset_purchases), 125);

    await db.query(`delete from public.transactions where id = 'purchase-1'`);
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 1000);
    assert.equal(await accountBalance(db, 'assets', 'value', 'fund-1'), 500);
    summary = await financialSummary(db);
    assert.equal(Number(summary.assets_value), 1500);
    assert.equal(Number(summary.monthly_asset_purchases), 0);

    await db.query(
      `select public.record_account_transfer($1, 'transfer', 'asset', 'cash-1',
       'asset', 'fund-1', 200, 'Rebalance', now())`,
      [SPACE_ID],
    );
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 800);
    assert.equal(await accountBalance(db, 'assets', 'value', 'fund-1'), 700);
    summary = await financialSummary(db);
    assert.equal(Number(summary.assets_value), 1500);
    assert.equal(Number(summary.monthly_asset_purchases), 0);
  } finally {
    await db.close();
  }
});

test('repayment and borrowing update both sides once, including linked transaction summaries', async () => {
  const db = await createLedgerDatabase();
  try {
    await insertAsset(db, 'cash-1', 'Cash', 1000);
    await insertDebt(db, 'loan-1', 'Loan', 500);

    await db.query(
      `select public.record_account_transfer($1, 'repayment', 'asset', 'cash-1',
       'liability', 'loan-1', 100, 'Repayment', now())`,
      [SPACE_ID],
    );
    await db.query(
      `select public.record_account_transfer($1, 'borrowing', 'liability', 'loan-1',
       'asset', 'cash-1', 50, 'Borrowing', now())`,
      [SPACE_ID],
    );
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 950);
    assert.equal(await accountBalance(db, 'debts', 'amount', 'loan-1'), 450);

    await insertTransaction(db, {
      id: 'repayment-transaction',
      amount: 80,
      linkedAssetId: 'cash-1',
      balanceEffect: 'decrease',
      linkedDebtId2: 'loan-1',
      balanceEffect2: 'decrease',
      movementType: 'repayment',
      movementType2: 'repayment',
    });
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 870);
    assert.equal(await accountBalance(db, 'debts', 'amount', 'loan-1'), 370);
    let summary = await financialSummary(db);
    assert.equal(Number(summary.monthly_debt_repayments), 180);
    assert.equal(Number(summary.monthly_borrowing), 50);
    assert.equal(Number(summary.net_worth), 500);

    await db.query(`delete from public.transactions where id = 'repayment-transaction'`);
    assert.equal(await accountBalance(db, 'assets', 'value', 'cash-1'), 950);
    assert.equal(await accountBalance(db, 'debts', 'amount', 'loan-1'), 450);
    summary = await financialSummary(db);
    assert.equal(Number(summary.monthly_debt_repayments), 100);
  } finally {
    await db.close();
  }
});

test('keyset transaction pages neither skip nor repeat rows sharing the same timestamp', async () => {
  const db = await createLedgerDatabase();
  try {
    const timestamp = '2026-06-15T12:00:00.000Z';
    const ids = Array.from({ length: 137 }, (_, index) => `tx-${String(index).padStart(4, '0')}`);
    for (const id of ids) {
      await db.query(
        `insert into public.transactions (id, space_id, type, amount, category, date)
         values ($1, $2, 'expense', 1, 'Test', $3)`,
        [id, SPACE_ID, timestamp],
      );
    }

    const collected = [];
    let beforeDate = null;
    let beforeId = null;
    while (true) {
      const { rows } = await db.query(
        `select * from public.list_space_transactions($1, $2, $3, 17, null)`,
        [SPACE_ID, beforeDate, beforeId],
      );
      collected.push(...rows.map((row) => row.id));
      if (rows.length < 17) break;
      beforeDate = rows[rows.length - 1].date;
      beforeId = rows[rows.length - 1].id;
    }

    assert.equal(collected.length, ids.length);
    assert.equal(new Set(collected).size, ids.length);
    assert.deepEqual(collected, [...ids].sort().reverse());
  } finally {
    await db.close();
  }
});

test('summary handles an empty period and income-only data without client-side history', async () => {
  const db = await createLedgerDatabase();
  try {
    let summary = await financialSummary(db);
    assert.equal(Number(summary.transaction_count), 0);
    assert.equal(Number(summary.month_income), 0);
    assert.equal(Number(summary.month_expense), 0);
    assert.deepEqual(summary.month_categories, []);

    await insertTransaction(db, { id: 'income-only', type: 'income', amount: 250 });
    summary = await financialSummary(db);
    assert.equal(Number(summary.transaction_count), 1);
    assert.equal(Number(summary.month_income), 250);
    assert.equal(Number(summary.month_expense), 0);
    assert.equal(Number(summary.month_net_cash_flow), 250);
    assert.equal(Number(summary.income_expense_ratio), 0);
  } finally {
    await db.close();
  }
});

test('RPC diagnostic query recognizes an exact installed signature', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create function public.list_space_liquid_assets(uuid, timestamptz, text, integer)
      returns integer language sql immutable as $$ select 1 $$;
    `);
    const { rows } = await db.query(rpcDiagnosticsSql);
    assert.equal(rows.length, 6);
    assert.deepEqual(
      rows.map(({ rpc_name, installed }) => [rpc_name, installed]),
      [
        ['list_space_assets', false],
        ['list_space_balance_movements', false],
        ['list_space_liabilities', false],
        ['list_space_transactions', false],
        ['get_space_financial_summary_v2', false],
        ['list_space_liquid_assets', true],
      ],
    );
  } finally {
    await db.close();
  }
});
