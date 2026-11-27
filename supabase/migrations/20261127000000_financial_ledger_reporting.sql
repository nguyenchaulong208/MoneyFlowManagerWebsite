-- Add account-linked transaction effects, space categories, and server-side reports.
-- This migration is additive: existing transaction ids and category labels are preserved.

begin;

alter table public.transactions
  add column if not exists linked_asset_id text,
  add column if not exists linked_debt_id text,
  add column if not exists balance_effect text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_linked_asset_fk'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions add constraint transactions_linked_asset_fk
      foreign key (linked_asset_id) references public.assets (id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_linked_debt_fk'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions add constraint transactions_linked_debt_fk
      foreign key (linked_debt_id) references public.debts (id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_balance_link_check'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions add constraint transactions_balance_link_check check (
      (balance_effect is null or balance_effect in ('increase', 'decrease'))
      and (
        num_nonnulls(linked_asset_id, linked_debt_id) = 0
        or (
          num_nonnulls(linked_asset_id, linked_debt_id) = 1
          and balance_effect in ('increase', 'decrease')
        )
      )
    );
  end if;
end;
$$;

create index if not exists transactions_space_date_id_idx
  on public.transactions (space_id, date desc, id desc);
create index if not exists transactions_space_type_date_id_idx
  on public.transactions (space_id, type, date desc, id desc);
create index if not exists transactions_space_asset_idx
  on public.transactions (space_id, linked_asset_id) where linked_asset_id is not null;
create index if not exists transactions_space_debt_idx
  on public.transactions (space_id, linked_debt_id) where linked_debt_id is not null;

create table if not exists public.transaction_categories (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  label text not null check (length(trim(label)) between 1 and 60),
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists transaction_categories_active_label_idx
  on public.transaction_categories (space_id, type, lower(label)) where not is_archived;
create index if not exists transaction_categories_space_idx
  on public.transaction_categories (space_id, type, is_archived, label);

alter table public.transaction_categories enable row level security;
drop policy if exists "Members can view space categories" on public.transaction_categories;
create policy "Members can view space categories" on public.transaction_categories
  for select to authenticated using (public.is_space_member(space_id));
drop policy if exists "Members can add space categories" on public.transaction_categories;
create policy "Members can add space categories" on public.transaction_categories
  for insert to authenticated with check (public.is_space_member(space_id));
drop policy if exists "Members can update space categories" on public.transaction_categories;
create policy "Members can update space categories" on public.transaction_categories
  for update to authenticated using (public.is_space_member(space_id))
  with check (public.is_space_member(space_id));
grant select, insert, update on public.transaction_categories to authenticated;
revoke delete on public.transaction_categories from public, anon, authenticated;

create or replace function public.seed_transaction_categories(p_space_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.transaction_categories (space_id, type, label)
  values
    (p_space_id, 'expense', 'Ăn uống'),
    (p_space_id, 'expense', 'Di chuyển'),
    (p_space_id, 'expense', 'Nhà ở'),
    (p_space_id, 'expense', 'Mua sắm'),
    (p_space_id, 'expense', 'Khác'),
    (p_space_id, 'income', 'Lương'),
    (p_space_id, 'income', 'Kinh doanh'),
    (p_space_id, 'income', 'Khác')
  on conflict do nothing;
$$;

create or replace function public.seed_space_transaction_categories()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.seed_transaction_categories(new.id);
  return new;
end;
$$;

drop trigger if exists seed_space_transaction_categories on public.spaces;
create trigger seed_space_transaction_categories after insert on public.spaces
for each row execute function public.seed_space_transaction_categories();

insert into public.transaction_categories (space_id, type, label)
select spaces.id, defaults.type, defaults.label
from public.spaces as spaces
cross join (values
  ('expense', 'Ăn uống'),
  ('expense', 'Di chuyển'),
  ('expense', 'Nhà ở'),
  ('expense', 'Mua sắm'),
  ('expense', 'Khác'),
  ('income', 'Lương'),
  ('income', 'Kinh doanh'),
  ('income', 'Khác')
) as defaults(type, label)
on conflict do nothing;

create or replace function public.create_transaction_category(
  p_space_id uuid,
  p_type text,
  p_label text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_category_id uuid;
  normalized_label text := trim(coalesce(p_label, ''));
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then
    raise exception 'Space membership required';
  end if;
  if p_type not in ('income', 'expense') then raise exception 'Type must be income or expense'; end if;
  if length(normalized_label) not between 1 and 60 then
    raise exception 'Category label must contain 1 to 60 characters';
  end if;

  insert into public.transaction_categories (space_id, type, label)
  values (p_space_id, p_type, normalized_label)
  returning id into new_category_id;
  return new_category_id;
end;
$$;

create or replace function public.archive_transaction_category(p_space_id uuid, p_category_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then
    raise exception 'Space membership required';
  end if;
  update public.transaction_categories
  set is_archived = true
  where id = p_category_id and space_id = p_space_id and not is_archived;
  if not found then raise exception 'Category not found or already archived'; end if;
end;
$$;

create or replace function public.apply_transaction_balance_effect()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_sign integer;
  new_sign integer;
  effect_changed boolean := false;
begin
  if current_setting('app.replace_financial_data', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    effect_changed := true;
  elsif tg_op = 'UPDATE' then
    effect_changed := (old.amount, old.space_id, old.linked_asset_id, old.linked_debt_id, old.balance_effect)
      is distinct from
      (new.amount, new.space_id, new.linked_asset_id, new.linked_debt_id, new.balance_effect);
  end if;

  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and effect_changed) then
    old_sign := case old.balance_effect when 'increase' then 1 when 'decrease' then -1 else 0 end;
    if old.linked_asset_id is not null and old_sign <> 0 then
      update public.assets set value = value - old.amount * old_sign
      where id = old.linked_asset_id and space_id = old.space_id;
    elsif old.linked_debt_id is not null and old_sign <> 0 then
      update public.debts set amount = amount - old.amount * old_sign
      where id = old.linked_debt_id and space_id = old.space_id;
    end if;
  end if;

  if tg_op <> 'DELETE' and effect_changed then
    new_sign := case new.balance_effect when 'increase' then 1 when 'decrease' then -1 else 0 end;
    if new.linked_asset_id is not null and new_sign <> 0 then
      update public.assets set value = value + new.amount * new_sign
      where id = new.linked_asset_id and space_id = new.space_id;
      if not found then raise exception 'Linked asset must belong to the transaction space'; end if;
    elsif new.linked_debt_id is not null and new_sign <> 0 then
      update public.debts set amount = amount + new.amount * new_sign
      where id = new.linked_debt_id and space_id = new.space_id;
      if not found then raise exception 'Linked debt must belong to the transaction space'; end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists apply_transaction_balance_effect on public.transactions;
create trigger apply_transaction_balance_effect
after insert or update or delete on public.transactions
for each row execute function public.apply_transaction_balance_effect();

-- PostgreSQL cannot replace a function when its OUT/RETURNS TABLE row type changes.
-- No migration function depends on this RPC; clients call it through PostgREST.
drop function if exists public.list_space_transactions(uuid, timestamptz, text, integer, text);

create function public.list_space_transactions(
  p_space_id uuid,
  p_before_date timestamptz default null,
  p_before_id text default null,
  p_limit integer default 50,
  p_type text default null
)
returns table (
  id text,
  type text,
  amount bigint,
  category text,
  note text,
  date timestamptz,
  linked_asset_id text,
  linked_debt_id text,
  balance_effect text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then
    raise exception 'Space membership required';
  end if;
  if p_limit not between 1 and 101 then raise exception 'Page size must be between 1 and 101'; end if;
  if (p_before_date is null) <> (p_before_id is null) then
    raise exception 'Both cursor values must be provided together';
  end if;
  if p_type is not null and p_type not in ('income', 'expense') then
    raise exception 'Type must be income or expense';
  end if;

  return query
  select tx.id, tx.type, tx.amount, tx.category,
    tx.note, tx.date, tx.linked_asset_id,
    tx.linked_debt_id, tx.balance_effect
  from public.transactions as tx
  where tx.space_id = p_space_id
    and (p_type is null or tx.type = p_type)
    and (
      p_before_date is null
      or (tx.date, tx.id) < (p_before_date, p_before_id)
    )
  order by tx.date desc, tx.id desc
  limit p_limit;
end;
$$;

create or replace function public.get_space_financial_summary(
  p_space_id uuid,
  p_month_start timestamptz,
  p_month_end timestamptz
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  summary jsonb;
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then
    raise exception 'Space membership required';
  end if;
  if p_month_start is null or p_month_end is null or p_month_end <= p_month_start
    or p_month_end - p_month_start > interval '32 days' then
    raise exception 'Invalid reporting period';
  end if;

  select jsonb_build_object(
    'transaction_count', count(*),
    'income_count', count(*) filter (where type = 'income'),
    'expense_count', count(*) filter (where type = 'expense'),
    'total_income', coalesce(sum(amount) filter (where type = 'income'), 0),
    'total_expense', coalesce(sum(amount) filter (where type = 'expense'), 0),
    'month_income', coalesce(sum(amount) filter (where type = 'income' and date >= p_month_start and date < p_month_end), 0),
    'month_expense', coalesce(sum(amount) filter (where type = 'expense' and date >= p_month_start and date < p_month_end), 0)
  )
  into summary
  from public.transactions
  where space_id = p_space_id;

  return summary || jsonb_build_object(
    'assets_value', coalesce((select sum(value) from public.assets where space_id = p_space_id), 0),
    'cash_value', coalesce((select sum(value) from public.assets where space_id = p_space_id and kind = 'cash'), 0),
    'debts_value', coalesce((select sum(amount) from public.debts where space_id = p_space_id), 0),
    'month_categories', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'amount', amount) order by amount desc, category)
      from (
        select category, sum(amount) as amount
        from public.transactions
        where space_id = p_space_id and type = 'expense'
          and date >= p_month_start and date < p_month_end
        group by category
      ) as category_totals
    ), '[]'::jsonb)
  );
end;
$$;

-- Backup/restore accepts account balances as displayed (after linked effects).
-- Subtract their effects before inserting linked transactions to avoid replaying them twice.
create or replace function public.replace_financial_data(
  p_space_id uuid,
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
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not public.is_space_owner(p_space_id)
    or (select kind from public.spaces where id = p_space_id) <> 'personal' then
    raise exception 'Backup restore and clear are only available in your personal space';
  end if;
  if jsonb_typeof(p_transactions) is distinct from 'array'
    or jsonb_typeof(p_assets) is distinct from 'array'
    or jsonb_typeof(p_debts) is distinct from 'array' then
    raise exception 'Financial data must be provided as JSON arrays';
  end if;

  perform set_config('app.replace_financial_data', 'on', true);
  delete from public.transactions where space_id = p_space_id;
  delete from public.assets where space_id = p_space_id;
  delete from public.debts where space_id = p_space_id;
  perform set_config('app.replace_financial_data', 'off', true);

  insert into public.assets (id, user_id, space_id, name, kind, value)
  select item->>'id', current_user_id, p_space_id, item->>'name', item->>'kind',
    (item->>'value')::bigint - coalesce((
      select sum((event->>'amount')::bigint
        * case event->>'balance_effect' when 'increase' then 1 when 'decrease' then -1 else 0 end)
      from jsonb_array_elements(p_transactions) as entry(event)
      where event->>'linked_asset_id' = item->>'id'
    ), 0)
  from jsonb_array_elements(p_assets) as entry(item);

  insert into public.debts (id, user_id, space_id, name, kind, amount, due_date)
  select item->>'id', current_user_id, p_space_id, item->>'name', item->>'kind',
    (item->>'amount')::bigint - coalesce((
      select sum((event->>'amount')::bigint
        * case event->>'balance_effect' when 'increase' then 1 when 'decrease' then -1 else 0 end)
      from jsonb_array_elements(p_transactions) as entry(event)
      where event->>'linked_debt_id' = item->>'id'
    ), 0),
    nullif(item->>'due_date', '')::date
  from jsonb_array_elements(p_debts) as entry(item);

  insert into public.transactions (
    id, user_id, space_id, type, amount, category, note, date,
    linked_asset_id, linked_debt_id, balance_effect
  )
  select item->>'id', current_user_id, p_space_id, item->>'type', (item->>'amount')::bigint,
    item->>'category', coalesce(item->>'note', ''), (item->>'date')::timestamptz,
    nullif(item->>'linked_asset_id', ''), nullif(item->>'linked_debt_id', ''),
    nullif(item->>'balance_effect', '')
  from jsonb_array_elements(p_transactions) as entry(item);
end;
$$;

revoke all on function public.seed_transaction_categories(uuid) from public, anon, authenticated;
revoke all on function public.seed_space_transaction_categories() from public, anon, authenticated;
revoke all on function public.create_transaction_category(uuid, text, text) from public, anon;
revoke all on function public.archive_transaction_category(uuid, uuid) from public, anon;
revoke all on function public.list_space_transactions(uuid, timestamptz, text, integer, text) from public, anon;
revoke all on function public.get_space_financial_summary(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.create_transaction_category(uuid, text, text) to authenticated;
grant execute on function public.archive_transaction_category(uuid, uuid) to authenticated;
grant execute on function public.list_space_transactions(uuid, timestamptz, text, integer, text) to authenticated;
grant execute on function public.get_space_financial_summary(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.replace_financial_data(uuid, jsonb, jsonb, jsonb) to authenticated;

commit;
