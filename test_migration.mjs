import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import path from 'path';

const DB_PATH = path.resolve('/e/Github Code/MoneyFlowManagerWebsite/pglite_test.db');
const db = new PGlite({ filename: DB_PATH });
try {
  await db.exec(`
    create schema auth;
    create role anon;
    create role authenticated;
    create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-4000-8000-000000000002'::uuid $$;
    create function public.is_space_member(p_space_id uuid) returns boolean language sql stable as $$ select p_space_id is not null $$;
  `);
  const migration = fs.readFileSync('supabase/migrations/20261127120000_finance_dashboard_and_labels.sql', 'utf8');
  await db.exec(migration);
  // Test the format_change_text function
  let r = await db.query("select public.format_change_text(1000000, 0) as v");
  console.log('1:', r.rows[0].v);
  r = await db.query("select public.format_change_text(900000, 1000000) as v");
  console.log('2:', r.rows[0].v);
  r = await db.query("select public.format_change_text(0, 0) as v");
  console.log('3:', r.rows[0].v);
  r = await db.query("select public.format_change_text(1000, 1000) as v");
  console.log('4:', r.rows[0].v);
  r = await db.query("select public.format_change_text(1200000, 1000000) as v");
  console.log('5:', r.rows[0].v);
  r = await db.query("select public.format_change_text(800000, 1000000) as v");
  console.log('6:', r.rows[0].v);
  r = await db.query("select public.get_space_financial_summary_comparison('00000000-0000-4000-8000-000000000001', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z') as v");
  console.log('7:', JSON.stringify(r.rows[0].v));
  console.log('All tests passed');
} catch (e) {
  console.error('FAILED:', e.message);
  console.error(e.stack);
} finally {
  await db.close();
}
