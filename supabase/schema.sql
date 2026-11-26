-- Dòng Tiền personal finance schema for Supabase.
-- Safe to run again: tables, indexes, policies and the import function are repeatable.

create table if not exists public.transactions (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  amount bigint not null check (amount > 0),
  category text not null,
  note text not null default '',
  date timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.assets (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null,
  value bigint not null check (value >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.debts (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null,
  amount bigint not null check (amount >= 0),
  due_date date,
  created_at timestamptz not null default now()
);

create index if not exists transactions_user_date_idx
  on public.transactions (user_id, date desc);
create index if not exists assets_user_created_idx
  on public.assets (user_id, created_at desc);
create index if not exists debts_user_created_idx
  on public.debts (user_id, created_at desc);

alter table public.transactions enable row level security;
alter table public.assets enable row level security;
alter table public.debts enable row level security;

drop policy if exists "Users manage their own transactions" on public.transactions;
create policy "Users manage their own transactions"
  on public.transactions for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own assets" on public.assets;
create policy "Users manage their own assets"
  on public.assets for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own debts" on public.debts;
create policy "Users manage their own debts"
  on public.debts for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.assets to authenticated;
grant select, insert, update, delete on public.debts to authenticated;

-- Backup restore is performed in one transaction so a failed import cannot
-- leave only some of the user's previous rows replaced.
create or replace function public.replace_financial_data(
  p_transactions jsonb,
  p_assets jsonb,
  p_debts jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;
  if jsonb_typeof(p_transactions) is distinct from 'array'
    or jsonb_typeof(p_assets) is distinct from 'array'
    or jsonb_typeof(p_debts) is distinct from 'array' then
    raise exception 'Financial data must be provided as JSON arrays';
  end if;

  delete from public.transactions where user_id = current_user_id;
  delete from public.assets where user_id = current_user_id;
  delete from public.debts where user_id = current_user_id;

  insert into public.transactions (id, user_id, type, amount, category, note, date)
  select item->>'id', current_user_id, item->>'type', (item->>'amount')::bigint,
    item->>'category', coalesce(item->>'note', ''), (item->>'date')::timestamptz
  from jsonb_array_elements(p_transactions) as entry(item);

  insert into public.assets (id, user_id, name, kind, value)
  select item->>'id', current_user_id, item->>'name', item->>'kind', (item->>'value')::bigint
  from jsonb_array_elements(p_assets) as entry(item);

  insert into public.debts (id, user_id, name, kind, amount, due_date)
  select item->>'id', current_user_id, item->>'name', item->>'kind', (item->>'amount')::bigint,
    nullif(item->>'due_date', '')::date
  from jsonb_array_elements(p_debts) as entry(item);
end;
$$;

revoke all on function public.replace_financial_data(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.replace_financial_data(jsonb, jsonb, jsonb) to authenticated;
