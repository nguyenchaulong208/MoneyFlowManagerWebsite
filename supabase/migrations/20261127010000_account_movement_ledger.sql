-- Durable, space-scoped movements and configurable account types.
-- Existing balances are retained as opening snapshots; linked transactions are backfilled as movements.

begin;

create table if not exists public.space_finance_types (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  account_kind text not null check (account_kind in ('asset', 'liability')),
  code text not null,
  label text not null check (length(trim(label)) between 1 and 60),
  is_liquid boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (space_id, account_kind, code)
);

create unique index if not exists space_finance_types_active_label_idx
  on public.space_finance_types (space_id, account_kind, lower(label)) where not is_archived;
create index if not exists space_finance_types_space_idx
  on public.space_finance_types (space_id, account_kind, is_archived, label);

alter table public.assets
  add column if not exists account_type_id uuid,
  add column if not exists is_archived boolean not null default false;
alter table public.debts
  add column if not exists account_type_id uuid,
  add column if not exists is_archived boolean not null default false;
alter table public.transactions
  add column if not exists linked_asset_id_2 text,
  add column if not exists linked_debt_id_2 text,
  add column if not exists balance_effect_2 text,
  add column if not exists balance_movement_type text,
  add column if not exists balance_movement_type_2 text;
create index if not exists transactions_space_linked_asset_2_idx
  on public.transactions (space_id, linked_asset_id_2) where linked_asset_id_2 is not null;
create index if not exists transactions_space_linked_debt_2_idx
  on public.transactions (space_id, linked_debt_id_2) where linked_debt_id_2 is not null;
create index if not exists assets_space_created_id_idx
  on public.assets (space_id, created_at desc, id desc);
create index if not exists debts_space_created_id_idx
  on public.debts (space_id, created_at desc, id desc);
create index if not exists assets_space_type_idx
  on public.assets (space_id, account_type_id) where not is_archived;
create index if not exists debts_space_type_idx
  on public.debts (space_id, account_type_id) where not is_archived;
create index if not exists assets_space_name_idx on public.assets (space_id, lower(name));
create index if not exists debts_space_name_idx on public.debts (space_id, lower(name));

create or replace function public.seed_space_finance_types(p_space_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.space_finance_types (space_id, account_kind, code, label, is_liquid)
  values
    (p_space_id, 'asset', 'cash', 'Tiền mặt & tiền gửi', true),
    (p_space_id, 'asset', 'investment', 'Đầu tư', false),
    (p_space_id, 'asset', 'property', 'Bất động sản', false),
    (p_space_id, 'asset', 'business', 'Kinh doanh', false),
    (p_space_id, 'asset', 'other', 'Tài sản khác', false),
    (p_space_id, 'liability', 'loan', 'Vay', false),
    (p_space_id, 'liability', 'credit-card', 'Thẻ tín dụng', false),
    (p_space_id, 'liability', 'installment', 'Trả góp', false),
    (p_space_id, 'liability', 'other', 'Khoản phải trả khác', false)
  on conflict (space_id, account_kind, code) do nothing;
$$;

create or replace function public.seed_space_finance_types_on_create()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.seed_space_finance_types(new.id);
  return new;
end;
$$;

drop trigger if exists seed_space_finance_types_on_create on public.spaces;
create trigger seed_space_finance_types_on_create after insert on public.spaces
for each row execute function public.seed_space_finance_types_on_create();

insert into public.space_finance_types (space_id, account_kind, code, label, is_liquid)
select spaces.id, defaults.account_kind, defaults.code, defaults.label, defaults.is_liquid
from public.spaces as spaces
cross join (values
  ('asset', 'cash', 'Tiền mặt & tiền gửi', true),
  ('asset', 'investment', 'Đầu tư', false),
  ('asset', 'property', 'Bất động sản', false),
  ('asset', 'business', 'Kinh doanh', false),
  ('asset', 'other', 'Tài sản khác', false),
  ('liability', 'loan', 'Vay', false),
  ('liability', 'credit-card', 'Thẻ tín dụng', false),
  ('liability', 'installment', 'Trả góp', false),
  ('liability', 'other', 'Khoản phải trả khác', false)
) as defaults(account_kind, code, label, is_liquid)
on conflict (space_id, account_kind, code) do nothing;

insert into public.space_finance_types (space_id, account_kind, code, label, is_liquid)
select distinct item.space_id, 'asset', 'legacy-' || md5(lower(trim(item.kind))),
  left(trim(item.kind), 60), false
from public.assets as item
where lower(trim(coalesce(item.kind, ''))) not in ('cash', 'investment', 'property', 'business', 'other')
  and length(trim(coalesce(item.kind, ''))) > 0
on conflict (space_id, account_kind, code) do nothing;

insert into public.space_finance_types (space_id, account_kind, code, label, is_liquid)
select distinct item.space_id, 'liability', 'legacy-' || md5(lower(trim(item.kind))),
  left(trim(item.kind), 60), false
from public.debts as item
where lower(trim(coalesce(item.kind, ''))) not in ('vay', 'thẻ tín dụng', 'trả góp', 'khác')
  and length(trim(coalesce(item.kind, ''))) > 0
on conflict (space_id, account_kind, code) do nothing;

update public.assets as item
set account_type_id = finance_type.id
from public.space_finance_types as finance_type
where finance_type.space_id = item.space_id
  and finance_type.account_kind = 'asset'
  and finance_type.code = case lower(trim(coalesce(item.kind, '')))
    when 'cash' then 'cash'
    when 'investment' then 'investment'
    when 'property' then 'property'
    when 'business' then 'business'
    when 'other' then 'other'
    when '' then 'other'
    else 'legacy-' || md5(lower(trim(item.kind)))
  end
  and item.account_type_id is null;

update public.debts as item
set account_type_id = finance_type.id
from public.space_finance_types as finance_type
where finance_type.space_id = item.space_id
  and finance_type.account_kind = 'liability'
  and finance_type.code = case lower(trim(coalesce(item.kind, '')))
    when 'vay' then 'loan'
    when 'thẻ tín dụng' then 'credit-card'
    when 'trả góp' then 'installment'
    when 'khác' then 'other'
    when '' then 'other'
    else 'legacy-' || md5(lower(trim(item.kind)))
  end
  and item.account_type_id is null;

do $$
begin
  if exists (select 1 from public.assets where account_type_id is null)
    or exists (select 1 from public.debts where account_type_id is null) then
    raise exception 'Could not map every legacy account to a finance type';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'assets_account_type_fk'
      and conrelid = 'public.assets'::regclass
  ) then
    alter table public.assets add constraint assets_account_type_fk
      foreign key (account_type_id) references public.space_finance_types (id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'debts_account_type_fk'
      and conrelid = 'public.debts'::regclass
  ) then
    alter table public.debts add constraint debts_account_type_fk
      foreign key (account_type_id) references public.space_finance_types (id) on delete restrict;
  end if;
end;
$$;

create table if not exists public.account_movements (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  account_kind text not null check (account_kind in ('asset', 'liability')),
  account_id text not null,
  account_name text not null,
  amount bigint not null,
  movement_type text not null check (movement_type in (
    'opening', 'adjustment', 'purchase', 'transfer', 'borrowing',
    'repayment', 'transaction', 'transaction_reversal', 'restore_adjustment'
  )),
  source_transaction_id text,
  transaction_leg smallint,
  transfer_id uuid,
  note text not null default '',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  idempotency_key text unique,
  check (amount <> 0 or movement_type = 'opening'),
  check (transaction_leg is null or transaction_leg in (1, 2))
);

create index if not exists account_movements_space_account_date_idx
  on public.account_movements (space_id, account_kind, account_id, occurred_at desc, id desc);
create index if not exists account_movements_space_type_date_idx
  on public.account_movements (space_id, movement_type, occurred_at desc);
create index if not exists account_movements_space_created_id_idx
  on public.account_movements (space_id, created_at desc, id desc);
create index if not exists account_movements_space_transaction_idx
  on public.account_movements (space_id, source_transaction_id, transaction_leg)
  where source_transaction_id is not null;

alter table public.space_finance_types enable row level security;
alter table public.account_movements enable row level security;
drop policy if exists "Members can view finance types" on public.space_finance_types;
create policy "Members can view finance types" on public.space_finance_types
  for select to authenticated using (public.is_space_member(space_id));
drop policy if exists "Members can view account movements" on public.account_movements;
create policy "Members can view account movements" on public.account_movements
  for select to authenticated using (public.is_space_member(space_id));
grant select on public.space_finance_types, public.account_movements to authenticated;
revoke insert, update, delete on public.space_finance_types, public.account_movements from public, anon, authenticated;

-- Backfill snapshots without replaying current balances. Legacy linked transaction
-- effects are already included in the balance columns by the prior migration.
insert into public.account_movements (
  space_id, account_kind, account_id, account_name, amount, movement_type, occurred_at, idempotency_key
)
select item.space_id, 'asset', item.id,
  item.name,
  item.value - coalesce((
    select sum(tx.amount * case tx.balance_effect when 'increase' then 1 when 'decrease' then -1 else 0 end)
    from public.transactions as tx
    where tx.space_id = item.space_id and tx.linked_asset_id = item.id
  ), 0),
  'opening:' || item.space_id || ':asset:' || item.id
from public.assets as item
on conflict (idempotency_key) do nothing;

insert into public.account_movements (
  space_id, account_kind, account_id, account_name, amount, movement_type, occurred_at, idempotency_key
)
select item.space_id, 'liability', item.id,
  item.name,
  item.amount - coalesce((
    select sum(tx.amount * case tx.balance_effect when 'increase' then 1 when 'decrease' then -1 else 0 end)
    from public.transactions as tx
    where tx.space_id = item.space_id and tx.linked_debt_id = item.id
  ), 0),
  'opening:' || item.space_id || ':liability:' || item.id
from public.debts as item
on conflict (idempotency_key) do nothing;

insert into public.account_movements (
  space_id, account_kind, account_id, account_name, amount, movement_type,
  source_transaction_id, transaction_leg, note, occurred_at, idempotency_key
)
select tx.space_id, 'asset', item.id, item.name,
  tx.amount * case tx.balance_effect when 'increase' then 1 when 'decrease' then -1 else 0 end,
  'transaction', tx.id, 1, coalesce(tx.note, ''), tx.date, 'transaction:' || tx.space_id || ':' || tx.id || ':1'
from public.transactions as tx
join public.assets as item on item.id = tx.linked_asset_id and item.space_id = tx.space_id
where tx.linked_asset_id is not null
on conflict (idempotency_key) do nothing;

insert into public.account_movements (
  space_id, account_kind, account_id, account_name, amount, movement_type,
  source_transaction_id, transaction_leg, note, occurred_at, idempotency_key
)
select tx.space_id, 'liability', item.id, item.name,
  tx.amount * case tx.balance_effect when 'increase' then 1 when 'decrease' then -1 else 0 end,
  'transaction', tx.id, 1, coalesce(tx.note, ''), tx.date, 'transaction:' || tx.space_id || ':' || tx.id || ':1'
from public.transactions as tx
join public.debts as item on item.id = tx.linked_debt_id and item.space_id = tx.space_id
where tx.linked_debt_id is not null
on conflict (idempotency_key) do nothing;

alter table public.transactions drop constraint if exists transactions_balance_link_check;
alter table public.transactions
  add constraint transactions_balance_link_check check (
    (balance_effect is null or balance_effect in ('increase', 'decrease'))
    and (balance_effect_2 is null or balance_effect_2 in ('increase', 'decrease'))
    and (
      num_nonnulls(linked_asset_id, linked_debt_id) = 0
      or (
        num_nonnulls(linked_asset_id, linked_debt_id) = 1
        and balance_effect is not null
        and balance_effect in ('increase', 'decrease')
      )
    )
    and (
      num_nonnulls(linked_asset_id_2, linked_debt_id_2) = 0
      or (
        num_nonnulls(linked_asset_id_2, linked_debt_id_2) = 1
        and balance_effect_2 is not null
        and balance_effect_2 in ('increase', 'decrease')
      )
    )
    and (balance_movement_type is null or balance_movement_type in ('transaction', 'purchase', 'transfer', 'borrowing', 'repayment'))
    and (balance_movement_type_2 is null or balance_movement_type_2 in ('transaction', 'purchase', 'transfer', 'borrowing', 'repayment'))
    and (
      (
        coalesce(balance_movement_type, 'transaction') not in ('purchase', 'transfer', 'repayment', 'borrowing')
        and coalesce(balance_movement_type_2, 'transaction') not in ('purchase', 'transfer', 'repayment', 'borrowing')
      )
      or (
        balance_movement_type in ('purchase', 'transfer')
        and balance_movement_type_2 = balance_movement_type
        and num_nonnulls(linked_asset_id, linked_asset_id_2) = 2
        and num_nonnulls(linked_debt_id, linked_debt_id_2) = 0
        and ((balance_effect = 'increase' and balance_effect_2 = 'decrease')
          or (balance_effect = 'decrease' and balance_effect_2 = 'increase'))
      )
      or (
        (balance_movement_type = 'repayment' or balance_movement_type_2 = 'repayment')
        and (linked_asset_id is null and linked_debt_id is null or balance_movement_type = 'repayment')
        and (linked_asset_id_2 is null and linked_debt_id_2 is null or balance_movement_type_2 = 'repayment')
        and num_nonnulls(linked_debt_id, linked_debt_id_2) = 1
        and num_nonnulls(linked_asset_id, linked_asset_id_2) <= 1
        and (linked_asset_id is null or balance_effect = 'decrease')
        and (linked_debt_id is null or balance_effect = 'decrease')
        and (linked_asset_id_2 is null or balance_effect_2 = 'decrease')
        and (linked_debt_id_2 is null or balance_effect_2 = 'decrease')
      )
      or (
        (balance_movement_type = 'borrowing' or balance_movement_type_2 = 'borrowing')
        and (linked_asset_id is null and linked_debt_id is null or balance_movement_type = 'borrowing')
        and (linked_asset_id_2 is null and linked_debt_id_2 is null or balance_movement_type_2 = 'borrowing')
        and num_nonnulls(linked_debt_id, linked_debt_id_2) = 1
        and num_nonnulls(linked_asset_id, linked_asset_id_2) <= 1
        and (linked_asset_id is null or balance_effect = 'increase')
        and (linked_debt_id is null or balance_effect = 'increase')
        and (linked_asset_id_2 is null or balance_effect_2 = 'increase')
        and (linked_debt_id_2 is null or balance_effect_2 = 'increase')
      )
    )
    and not (
      coalesce(case when linked_asset_id is not null then 'asset:' || linked_asset_id else 'liability:' || linked_debt_id end, '')
        = coalesce(case when linked_asset_id_2 is not null then 'asset:' || linked_asset_id_2 else 'liability:' || linked_debt_id_2 end, '')
      and num_nonnulls(linked_asset_id, linked_debt_id, linked_asset_id_2, linked_debt_id_2) > 0
    )
  );

drop function if exists public.list_space_transactions(uuid, timestamptz, text, integer, text);
create function public.list_space_transactions(
  p_space_id uuid, p_before_date timestamptz default null, p_before_id text default null,
  p_limit integer default 50, p_type text default null
)
returns table (
  id text, type text, amount bigint, category text, note text, date timestamptz,
  linked_asset_id text, linked_debt_id text, balance_effect text,
  linked_asset_id_2 text, linked_debt_id_2 text, balance_effect_2 text,
  balance_movement_type text, balance_movement_type_2 text,
  linked_asset_name text, linked_debt_name text, linked_asset_name_2 text, linked_debt_name_2 text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  if p_limit not between 1 and 101 then raise exception 'Page size must be between 1 and 101'; end if;
  if (p_before_date is null) <> (p_before_id is null) then raise exception 'Both cursor values are required'; end if;
  if p_type is not null and p_type not in ('income', 'expense') then raise exception 'Type must be income or expense'; end if;
  return query
  select tx.id, tx.type, tx.amount, tx.category, tx.note, tx.date,
    tx.linked_asset_id, tx.linked_debt_id, tx.balance_effect,
    tx.linked_asset_id_2, tx.linked_debt_id_2, tx.balance_effect_2,
    tx.balance_movement_type, tx.balance_movement_type_2,
    linked_asset.name, linked_debt.name, linked_asset_2.name, linked_debt_2.name
  from public.transactions as tx
  left join public.assets as linked_asset on linked_asset.id = tx.linked_asset_id and linked_asset.space_id = tx.space_id
  left join public.debts as linked_debt on linked_debt.id = tx.linked_debt_id and linked_debt.space_id = tx.space_id
  left join public.assets as linked_asset_2 on linked_asset_2.id = tx.linked_asset_id_2 and linked_asset_2.space_id = tx.space_id
  left join public.debts as linked_debt_2 on linked_debt_2.id = tx.linked_debt_id_2 and linked_debt_2.space_id = tx.space_id
  where tx.space_id = p_space_id and (p_type is null or tx.type = p_type)
    and (p_before_date is null or (tx.date, tx.id) < (p_before_date, p_before_id))
  order by tx.date desc, tx.id desc
  limit p_limit;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_linked_asset_2_fk'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions add constraint transactions_linked_asset_2_fk
      foreign key (linked_asset_id_2) references public.assets (id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_linked_debt_2_fk'
      and conrelid = 'public.transactions'::regclass
  ) then
    alter table public.transactions add constraint transactions_linked_debt_2_fk
      foreign key (linked_debt_id_2) references public.debts (id) on delete set null;
  end if;
end;
$$;

create or replace function public.validate_account_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_space_id uuid;
  actual_kind text;
  expected_kind text := case when tg_table_name = 'assets' then 'asset' else 'liability' end;
begin
  select space_id, account_kind into actual_space_id, actual_kind
  from public.space_finance_types where id = new.account_type_id;
  if not found or actual_space_id <> new.space_id or actual_kind <> expected_kind then
    raise exception 'Account type must belong to the same space and account kind';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_asset_account_type on public.assets;
create trigger validate_asset_account_type before insert or update of account_type_id, space_id on public.assets
for each row execute function public.validate_account_type();
drop trigger if exists validate_debt_account_type on public.debts;
create trigger validate_debt_account_type before insert or update of account_type_id, space_id on public.debts
for each row execute function public.validate_account_type();

create or replace function public.apply_account_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_exists boolean;
begin
  if new.movement_type = 'opening' then return new; end if;
  if current_setting('app.legacy_balance_write', true) = 'on' then return new; end if;
  if current_setting('app.import_movement_history', true) = 'on' then return new; end if;

  if new.account_kind = 'asset' then
    select exists(select 1 from public.assets where id = new.account_id and space_id = new.space_id)
      into target_exists;
    if not target_exists then
      if exists(select 1 from public.assets where id = new.account_id)
        or new.movement_type <> 'transaction_reversal' then
        raise exception 'Asset movement target is missing or belongs to another space';
      end if;
      return new;
    end if;
    perform set_config('app.apply_account_movement', 'on', true);
    update public.assets set value = value + new.amount
    where id = new.account_id and space_id = new.space_id;
    perform set_config('app.apply_account_movement', 'off', true);
  else
    select exists(select 1 from public.debts where id = new.account_id and space_id = new.space_id)
      into target_exists;
    if not target_exists then
      if exists(select 1 from public.debts where id = new.account_id)
        or new.movement_type <> 'transaction_reversal' then
        raise exception 'Liability movement target is missing or belongs to another space';
      end if;
      return new;
    end if;
    perform set_config('app.apply_account_movement', 'on', true);
    update public.debts set amount = amount + new.amount
    where id = new.account_id and space_id = new.space_id;
    perform set_config('app.apply_account_movement', 'off', true);
  end if;
  return new;
end;
$$;

drop trigger if exists apply_account_movement on public.account_movements;
create trigger apply_account_movement after insert on public.account_movements
for each row execute function public.apply_account_movement();

create or replace function public.prevent_direct_account_balance_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  balance_delta bigint;
begin
  if coalesce(current_setting('app.apply_account_movement', true), '') = 'on' then return new; end if;
  if tg_table_name = 'assets' then
    balance_delta := new.value - old.value;
  else
    balance_delta := new.amount - old.amount;
  end if;
  if balance_delta <> 0 then
    perform set_config('app.legacy_balance_write', 'on', true);
    insert into public.account_movements (
      space_id, account_kind, account_id, account_name, amount, movement_type, note
    ) values (
      new.space_id,
      case when tg_table_name = 'assets' then 'asset' else 'liability' end,
      new.id, new.name, balance_delta, 'adjustment', 'Balance edit via legacy client'
    );
    perform set_config('app.legacy_balance_write', 'off', true);
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_asset_balance_update on public.assets;
create trigger prevent_asset_balance_update before update of value on public.assets
for each row execute function public.prevent_direct_account_balance_update();
drop trigger if exists prevent_debt_balance_update on public.debts;
create trigger prevent_debt_balance_update before update of amount on public.debts
for each row execute function public.prevent_direct_account_balance_update();

create or replace function public.capture_asset_opening_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.import_movement_history', true) = 'on' then return new; end if;
  insert into public.account_movements (
    space_id, account_kind, account_id, account_name, amount, movement_type, occurred_at, idempotency_key
  ) values (new.space_id, 'asset', new.id, new.name, new.value, 'opening', new.created_at, 'opening:' || new.space_id || ':asset:' || new.id)
  on conflict (idempotency_key) do nothing;
  return new;
end;
$$;

create or replace function public.capture_liability_opening_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.import_movement_history', true) = 'on' then return new; end if;
  insert into public.account_movements (
    space_id, account_kind, account_id, account_name, amount, movement_type, occurred_at, idempotency_key
  ) values (new.space_id, 'liability', new.id, new.name, new.amount, 'opening', new.created_at, 'opening:' || new.space_id || ':liability:' || new.id)
  on conflict (idempotency_key) do nothing;
  return new;
end;
$$;

drop trigger if exists capture_asset_opening_movement on public.assets;
create trigger capture_asset_opening_movement after insert on public.assets
for each row execute function public.capture_asset_opening_movement();
drop trigger if exists capture_liability_opening_movement on public.debts;
create trigger capture_liability_opening_movement after insert on public.debts
for each row execute function public.capture_liability_opening_movement();

create or replace function public.append_transaction_account_movement(
  p_space_id uuid,
  p_account_kind text,
  p_account_id text,
  p_amount bigint,
  p_movement_type text,
  p_transaction_id text,
  p_leg smallint,
  p_note text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_label text;
begin
  if p_amount = 0 then return; end if;
  if p_account_kind = 'asset' then
    select name into account_label from public.assets
    where id = p_account_id and space_id = p_space_id;
  else
    select name into account_label from public.debts
    where id = p_account_id and space_id = p_space_id;
  end if;
  if account_label is null and p_movement_type = 'transaction' then
    raise exception 'Linked account must belong to the transaction space';
  end if;
  if account_label is null then
    select account_name into account_label from public.account_movements
    where space_id = p_space_id and account_kind = p_account_kind
      and account_id = p_account_id and source_transaction_id = p_transaction_id
      and transaction_leg = p_leg
    order by created_at desc, id desc limit 1;
  end if;

  insert into public.account_movements (
    space_id, account_kind, account_id, account_name, amount, movement_type,
    source_transaction_id, transaction_leg, note, occurred_at
  ) values (
    p_space_id, p_account_kind, p_account_id, coalesce(account_label, 'Deleted account'),
    p_amount, p_movement_type, p_transaction_id, p_leg, coalesce(p_note, ''), p_occurred_at
  );
end;
$$;

create or replace function public.apply_transaction_balance_effect()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  effect_changed boolean := false;
  old_kind_1 text;
  old_id_1 text;
  old_effect_1 text;
  old_kind_2 text;
  old_id_2 text;
  old_effect_2 text;
  old_movement_type_1 text;
  old_movement_type_2 text;
  new_kind_1 text;
  new_id_1 text;
  new_effect_1 text;
  new_kind_2 text;
  new_id_2 text;
  new_effect_2 text;
  new_movement_type_1 text;
  new_movement_type_2 text;
  account_delta bigint;
begin
  if current_setting('app.skip_transaction_movement', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    effect_changed := (old.amount, old.space_id, old.date, old.note,
      old.linked_asset_id, old.linked_debt_id, old.balance_effect,
      old.linked_asset_id_2, old.linked_debt_id_2, old.balance_effect_2,
      old.balance_movement_type, old.balance_movement_type_2)
      is distinct from
      (new.amount, new.space_id, new.date, new.note,
      new.linked_asset_id, new.linked_debt_id, new.balance_effect,
      new.linked_asset_id_2, new.linked_debt_id_2, new.balance_effect_2,
      new.balance_movement_type, new.balance_movement_type_2);
  else
    effect_changed := true;
  end if;

  if tg_op <> 'INSERT' and effect_changed then
    old_kind_1 := case when old.linked_asset_id is not null then 'asset' when old.linked_debt_id is not null then 'liability' end;
    old_id_1 := coalesce(old.linked_asset_id, old.linked_debt_id);
    old_effect_1 := old.balance_effect;
    old_movement_type_1 := old.balance_movement_type;
    old_kind_2 := case when old.linked_asset_id_2 is not null then 'asset' when old.linked_debt_id_2 is not null then 'liability' end;
    old_id_2 := coalesce(old.linked_asset_id_2, old.linked_debt_id_2);
    old_effect_2 := old.balance_effect_2;
    old_movement_type_2 := old.balance_movement_type_2;
    if old_id_1 is not null then
      account_delta := old.amount * case old_effect_1 when 'increase' then -1 when 'decrease' then 1 else 0 end;
      perform public.append_transaction_account_movement(old.space_id, old_kind_1, old_id_1, account_delta, 'transaction_reversal', old.id, 1, old.note, old.date);
    end if;
    if old_id_2 is not null then
      account_delta := old.amount * case old_effect_2 when 'increase' then -1 when 'decrease' then 1 else 0 end;
      perform public.append_transaction_account_movement(old.space_id, old_kind_2, old_id_2, account_delta, 'transaction_reversal', old.id, 2, old.note, old.date);
    end if;
  end if;

  if tg_op <> 'DELETE' and effect_changed then
    new_kind_1 := case when new.linked_asset_id is not null then 'asset' when new.linked_debt_id is not null then 'liability' end;
    new_id_1 := coalesce(new.linked_asset_id, new.linked_debt_id);
    new_effect_1 := new.balance_effect;
    new_movement_type_1 := coalesce(new.balance_movement_type, 'transaction');
    new_kind_2 := case when new.linked_asset_id_2 is not null then 'asset' when new.linked_debt_id_2 is not null then 'liability' end;
    new_id_2 := coalesce(new.linked_asset_id_2, new.linked_debt_id_2);
    new_effect_2 := new.balance_effect_2;
    new_movement_type_2 := coalesce(new.balance_movement_type_2, 'transaction');
    if new_id_1 is not null then
      account_delta := new.amount * case new_effect_1 when 'increase' then 1 when 'decrease' then -1 else 0 end;
      perform public.append_transaction_account_movement(new.space_id, new_kind_1, new_id_1, account_delta, new_movement_type_1, new.id, 1, new.note, new.date);
    end if;
    if new_id_2 is not null then
      account_delta := new.amount * case new_effect_2 when 'increase' then 1 when 'decrease' then -1 else 0 end;
      perform public.append_transaction_account_movement(new.space_id, new_kind_2, new_id_2, account_delta, new_movement_type_2, new.id, 2, new.note, new.date);
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists apply_transaction_balance_effect on public.transactions;
create trigger apply_transaction_balance_effect after insert or update or delete on public.transactions
for each row execute function public.apply_transaction_balance_effect();

create or replace function public.create_space_finance_type(
  p_space_id uuid, p_account_kind text, p_label text, p_is_liquid boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_type_id uuid;
  normalized_label text := trim(coalesce(p_label, ''));
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  if p_account_kind not in ('asset', 'liability') then raise exception 'Account kind must be asset or liability'; end if;
  if p_account_kind = 'liability' and p_is_liquid then raise exception 'Liabilities cannot be liquid assets'; end if;
  if length(normalized_label) not between 1 and 60 then raise exception 'Type label must contain 1 to 60 characters'; end if;
  new_type_id := gen_random_uuid();
  insert into public.space_finance_types (id, space_id, account_kind, code, label, is_liquid)
  values (new_type_id, p_space_id, p_account_kind, 'custom-' || new_type_id::text, normalized_label, p_is_liquid)
  returning id into new_type_id;
  return new_type_id;
end;
$$;

create or replace function public.archive_space_finance_type(p_space_id uuid, p_type_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  update public.space_finance_types set is_archived = true
  where id = p_type_id and space_id = p_space_id and not is_archived;
  if not found then raise exception 'Account type not found or already archived'; end if;
end;
$$;

create or replace function public.set_space_finance_type_liquidity(p_space_id uuid, p_type_id uuid, p_is_liquid boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  update public.space_finance_types set is_liquid = p_is_liquid
  where id = p_type_id and space_id = p_space_id and account_kind = 'asset' and not is_archived;
  if not found then raise exception 'Active asset type not found'; end if;
end;
$$;

create or replace function public.record_account_movement(
  p_space_id uuid,
  p_account_kind text,
  p_account_id text,
  p_amount bigint,
  p_direction text,
  p_note text default '',
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  movement_id uuid;
  account_label text;
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  if p_account_kind is null or p_account_kind not in ('asset', 'liability') then raise exception 'Account kind must be asset or liability'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Movement amount must be greater than zero'; end if;
  if p_direction is null or p_direction not in ('increase', 'decrease') then raise exception 'Direction must be increase or decrease'; end if;
  if p_account_kind = 'asset' then
    select name into account_label from public.assets
    where id = p_account_id and space_id = p_space_id and not is_archived;
  else
    select name into account_label from public.debts
    where id = p_account_id and space_id = p_space_id and not is_archived;
  end if;
  if account_label is null then raise exception 'Active account not found in this space'; end if;
  insert into public.account_movements (
    space_id, account_kind, account_id, account_name, amount, movement_type, note, occurred_at
  ) values (
    p_space_id, p_account_kind, p_account_id, account_label,
    p_amount * case p_direction when 'increase' then 1 else -1 end,
    'adjustment', coalesce(p_note, ''), p_occurred_at
  ) returning id into movement_id;
  return movement_id;
end;
$$;

create or replace function public.record_account_transfer(
  p_space_id uuid,
  p_movement_type text,
  p_source_kind text,
  p_source_id text,
  p_destination_kind text,
  p_destination_id text,
  p_amount bigint,
  p_note text default '',
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_name text;
  destination_name text;
  source_delta bigint;
  destination_delta bigint;
  transfer_key uuid := gen_random_uuid();
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Transfer amount must be greater than zero'; end if;
  if p_source_kind is null or p_source_kind not in ('asset', 'liability')
    or p_destination_kind is null or p_destination_kind not in ('asset', 'liability') then
    raise exception 'Source and destination kinds must be asset or liability';
  end if;
  if p_movement_type is null then raise exception 'Movement type is required'; end if;
  if p_source_id = p_destination_id and p_source_kind = p_destination_kind then
    raise exception 'Source and destination must be different accounts';
  end if;
  if p_movement_type in ('transfer', 'purchase') then
    if p_source_kind <> 'asset' or p_destination_kind <> 'asset' then
      raise exception 'Transfers and purchases must move between assets';
    end if;
    source_delta := -p_amount;
    destination_delta := p_amount;
  elsif p_movement_type = 'repayment' then
    if p_source_kind <> 'asset' or p_destination_kind <> 'liability' then
      raise exception 'Repayment must move from an asset to a liability';
    end if;
    source_delta := -p_amount;
    destination_delta := -p_amount;
  elsif p_movement_type = 'borrowing' then
    if p_source_kind <> 'liability' or p_destination_kind <> 'asset' then
      raise exception 'Borrowing must increase a liability and an asset';
    end if;
    source_delta := p_amount;
    destination_delta := p_amount;
  else
    raise exception 'Unsupported transfer type';
  end if;

  if p_source_kind = 'asset' then
    select name into source_name from public.assets where id = p_source_id and space_id = p_space_id and not is_archived;
  else
    select name into source_name from public.debts where id = p_source_id and space_id = p_space_id and not is_archived;
  end if;
  if p_destination_kind = 'asset' then
    select name into destination_name from public.assets where id = p_destination_id and space_id = p_space_id and not is_archived;
  else
    select name into destination_name from public.debts where id = p_destination_id and space_id = p_space_id and not is_archived;
  end if;
  if source_name is null or destination_name is null then raise exception 'Both accounts must be active in this space'; end if;

  insert into public.account_movements (
    space_id, account_kind, account_id, account_name, amount, movement_type, transfer_id, note, occurred_at
  ) values
    (p_space_id, p_source_kind, p_source_id, source_name, source_delta, p_movement_type, transfer_key, coalesce(p_note, ''), p_occurred_at),
    (p_space_id, p_destination_kind, p_destination_id, destination_name, destination_delta, p_movement_type, transfer_key, coalesce(p_note, ''), p_occurred_at);
  return transfer_key;
end;
$$;

drop function if exists public.list_space_assets(uuid, timestamptz, text, integer);
drop function if exists public.list_space_assets(uuid, timestamptz, text, integer, boolean);
create function public.list_space_assets(
  p_space_id uuid, p_before_created_at timestamptz default null, p_before_id text default null,
  p_limit integer default 50, p_include_archived boolean default false
)
returns table (
  id text, name text, kind text, value bigint, account_type_id uuid,
  account_type_label text, account_type_code text, is_liquid boolean, is_archived boolean, created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  if p_limit not between 1 and 101 then raise exception 'Page size must be between 1 and 101'; end if;
  if (p_before_created_at is null) <> (p_before_id is null) then raise exception 'Both cursor values are required'; end if;
  return query
  select item.id, item.name, item.kind, item.value, item.account_type_id,
    finance_type.label, finance_type.code, finance_type.is_liquid, item.is_archived, item.created_at
  from public.assets as item
  join public.space_finance_types as finance_type on finance_type.id = item.account_type_id and finance_type.space_id = item.space_id
  where item.space_id = p_space_id and (p_include_archived or not item.is_archived)
    and (p_before_created_at is null or (item.created_at, item.id) < (p_before_created_at, p_before_id))
  order by item.created_at desc, item.id desc
  limit p_limit;
end;
$$;

drop function if exists public.list_space_liabilities(uuid, timestamptz, text, integer);
drop function if exists public.list_space_liabilities(uuid, timestamptz, text, integer, boolean);
create function public.list_space_liabilities(
  p_space_id uuid, p_before_created_at timestamptz default null, p_before_id text default null,
  p_limit integer default 50, p_include_archived boolean default false
)
returns table (
  id text, name text, kind text, amount bigint, due_date date, account_type_id uuid,
  account_type_label text, is_archived boolean, created_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  if p_limit not between 1 and 101 then raise exception 'Page size must be between 1 and 101'; end if;
  if (p_before_created_at is null) <> (p_before_id is null) then raise exception 'Both cursor values are required'; end if;
  return query
  select item.id, item.name, item.kind, item.amount, item.due_date, item.account_type_id,
    finance_type.label, item.is_archived, item.created_at
  from public.debts as item
  join public.space_finance_types as finance_type on finance_type.id = item.account_type_id and finance_type.space_id = item.space_id
  where item.space_id = p_space_id and (p_include_archived or not item.is_archived)
    and (p_before_created_at is null or (item.created_at, item.id) < (p_before_created_at, p_before_id))
  order by item.created_at desc, item.id desc
  limit p_limit;
end;
$$;

create or replace function public.list_space_balance_movements(
  p_space_id uuid, p_before_created_at timestamptz default null, p_before_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid, account_kind text, account_id text, account_name text, amount bigint, movement_type text,
  source_transaction_id text, transaction_leg smallint, transfer_id uuid, note text,
  occurred_at timestamptz, created_at timestamptz, idempotency_key text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  if p_limit not between 1 and 101 then raise exception 'Page size must be between 1 and 101'; end if;
  if (p_before_created_at is null) <> (p_before_id is null) then raise exception 'Both cursor values are required'; end if;
  return query
  select item.id, item.account_kind, item.account_id, item.account_name, item.amount, item.movement_type,
    item.source_transaction_id, item.transaction_leg, item.transfer_id, item.note, item.occurred_at,
    item.created_at, item.idempotency_key
  from public.account_movements as item
  where item.space_id = p_space_id
    and (p_before_created_at is null or (item.created_at, item.id) < (p_before_created_at, p_before_id))
  order by item.created_at desc, item.id desc
  limit p_limit;
end;
$$;

create or replace function public.search_space_accounts(p_space_id uuid, p_query text, p_limit integer default 20)
returns table (account_kind text, id text, name text, account_type_label text, balance bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
  if length(trim(coalesce(p_query, ''))) < 2 then raise exception 'Search requires at least two characters'; end if;
  if p_limit not between 1 and 25 then raise exception 'Result limit must be between 1 and 25'; end if;
  return query
  select result.account_kind, result.id, result.name, result.account_type_label, result.balance
  from (
    select 'asset'::text as account_kind, item.id, item.name, finance_type.label as account_type_label, item.value as balance
    from public.assets as item
    join public.space_finance_types as finance_type on finance_type.id = item.account_type_id
    where item.space_id = p_space_id and not item.is_archived and lower(item.name) like lower(trim(p_query)) || '%'
    union all
    select 'liability'::text, item.id, item.name, finance_type.label, item.amount
    from public.debts as item
    join public.space_finance_types as finance_type on finance_type.id = item.account_type_id
    where item.space_id = p_space_id and not item.is_archived and lower(item.name) like lower(trim(p_query)) || '%'
  ) as result
  order by result.name, result.account_kind, result.id
  limit p_limit;
end;
$$;

create or replace function public.get_space_financial_summary(
  p_space_id uuid, p_month_start timestamptz, p_month_end timestamptz
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
  if auth.uid() is null or not public.is_space_member(p_space_id) then raise exception 'Space membership required'; end if;
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
  ) into summary
  from public.transactions where space_id = p_space_id;

  return summary || jsonb_build_object(
    'assets_value', coalesce((select sum(value) from public.assets where space_id = p_space_id and not is_archived), 0),
    'cash_value', coalesce((
      select sum(item.value) from public.assets as item
      join public.space_finance_types as finance_type on finance_type.id = item.account_type_id
      where item.space_id = p_space_id and not item.is_archived and finance_type.is_liquid
    ), 0),
    'liabilities_value', coalesce((select sum(amount) from public.debts where space_id = p_space_id and not is_archived), 0),
    'debts_value', coalesce((select sum(amount) from public.debts where space_id = p_space_id and not is_archived), 0),
    'liquid_assets_value', coalesce((
      select sum(item.value) from public.assets as item
      join public.space_finance_types as finance_type on finance_type.id = item.account_type_id
      where item.space_id = p_space_id and not item.is_archived and finance_type.is_liquid
    ), 0),
    'assets_by_type', coalesce((
      select jsonb_agg(jsonb_build_object('type', finance_type.label, 'amount', totals.amount) order by totals.amount desc, finance_type.label)
      from (
        select account_type_id, sum(value) as amount from public.assets
        where space_id = p_space_id and not is_archived group by account_type_id
      ) as totals
      join public.space_finance_types as finance_type on finance_type.id = totals.account_type_id
    ), '[]'::jsonb),
    'liabilities_by_type', coalesce((
      select jsonb_agg(jsonb_build_object('type', finance_type.label, 'amount', totals.amount) order by totals.amount desc, finance_type.label)
      from (
        select account_type_id, sum(amount) as amount from public.debts
        where space_id = p_space_id and not is_archived group by account_type_id
      ) as totals
      join public.space_finance_types as finance_type on finance_type.id = totals.account_type_id
    ), '[]'::jsonb),
    'net_worth', coalesce((select sum(value) from public.assets where space_id = p_space_id and not is_archived), 0)
      - coalesce((select sum(amount) from public.debts where space_id = p_space_id and not is_archived), 0),
    'income_expense_ratio', (
      select sum(amount) filter (where type = 'expense')::numeric
        / nullif(sum(amount) filter (where type = 'income'), 0)
      from public.transactions where space_id = p_space_id and date >= p_month_start and date < p_month_end
    ),
    'savings_rate', (
      select (sum(amount) filter (where type = 'income') - sum(amount) filter (where type = 'expense'))::numeric
        / nullif(sum(amount) filter (where type = 'income'), 0)
      from public.transactions where space_id = p_space_id and date >= p_month_start and date < p_month_end
    ),
    'monthly_debt_repayments', coalesce((
      select sum(-amount) from public.account_movements
      where space_id = p_space_id and account_kind = 'liability' and movement_type = 'repayment'
        and source_transaction_id is null and amount < 0 and occurred_at >= p_month_start and occurred_at < p_month_end
    ), 0) + coalesce((
      select sum(tx.amount) from public.transactions as tx
      where tx.space_id = p_space_id and tx.date >= p_month_start and tx.date < p_month_end
        and ((tx.linked_debt_id is not null and tx.balance_movement_type = 'repayment' and tx.balance_effect = 'decrease')
          or (tx.linked_debt_id_2 is not null and tx.balance_movement_type_2 = 'repayment' and tx.balance_effect_2 = 'decrease'))
    ), 0),
    'month_debt_repayments', coalesce((
      select sum(-amount) from public.account_movements
      where space_id = p_space_id and account_kind = 'liability' and movement_type = 'repayment'
        and source_transaction_id is null and amount < 0 and occurred_at >= p_month_start and occurred_at < p_month_end
    ), 0) + coalesce((
      select sum(tx.amount) from public.transactions as tx
      where tx.space_id = p_space_id and tx.date >= p_month_start and tx.date < p_month_end
        and ((tx.linked_debt_id is not null and tx.balance_movement_type = 'repayment' and tx.balance_effect = 'decrease')
          or (tx.linked_debt_id_2 is not null and tx.balance_movement_type_2 = 'repayment' and tx.balance_effect_2 = 'decrease'))
    ), 0),
    'monthly_borrowing', coalesce((
      select sum(amount) from public.account_movements
      where space_id = p_space_id and account_kind = 'liability' and movement_type = 'borrowing'
        and source_transaction_id is null and amount > 0 and occurred_at >= p_month_start and occurred_at < p_month_end
    ), 0) + coalesce((
      select sum(tx.amount) from public.transactions as tx
      where tx.space_id = p_space_id and tx.date >= p_month_start and tx.date < p_month_end
        and ((tx.linked_debt_id is not null and tx.balance_movement_type = 'borrowing' and tx.balance_effect = 'increase')
          or (tx.linked_debt_id_2 is not null and tx.balance_movement_type_2 = 'borrowing' and tx.balance_effect_2 = 'increase'))
    ), 0),
    'monthly_asset_purchases', coalesce((
      select sum(amount) from public.account_movements
      where space_id = p_space_id and account_kind = 'asset' and movement_type = 'purchase'
        and source_transaction_id is null and amount > 0 and occurred_at >= p_month_start and occurred_at < p_month_end
    ), 0) + coalesce((
      select sum(tx.amount) from public.transactions as tx
      where tx.space_id = p_space_id and tx.date >= p_month_start and tx.date < p_month_end
        and ((tx.linked_asset_id is not null and tx.balance_movement_type = 'purchase' and tx.balance_effect = 'increase')
          or (tx.linked_asset_id_2 is not null and tx.balance_movement_type_2 = 'purchase' and tx.balance_effect_2 = 'increase'))
    ), 0),
    'month_categories', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'amount', amount) order by amount desc, category)
      from (
        select category, sum(amount) as amount
        from public.transactions
        where space_id = p_space_id and type = 'expense' and date >= p_month_start and date < p_month_end
        group by category
      ) as category_totals
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.replace_financial_data(
  p_space_id uuid, p_transactions jsonb, p_assets jsonb, p_debts jsonb, p_movements jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  importing_history boolean := false;
begin
  if current_user_id is null then raise exception 'Authentication required'; end if;
  if not public.is_space_owner(p_space_id)
    or (select kind from public.spaces where id = p_space_id) <> 'personal' then
    raise exception 'Backup restore and clear are only available in your personal space';
  end if;
  if jsonb_typeof(p_transactions) is distinct from 'array'
    or jsonb_typeof(p_assets) is distinct from 'array'
    or jsonb_typeof(p_debts) is distinct from 'array'
    or jsonb_typeof(p_movements) is distinct from 'array' then
    raise exception 'Financial data must be provided as JSON arrays';
  end if;
  if exists (
    select 1 from public.assets as existing
    join jsonb_array_elements(p_assets) as entry(item) on existing.id = entry.item->>'id'
    where existing.space_id <> p_space_id
  ) or exists (
    select 1 from public.debts as existing
    join jsonb_array_elements(p_debts) as entry(item) on existing.id = entry.item->>'id'
    where existing.space_id <> p_space_id
  ) or exists (
    select 1 from public.transactions as existing
    join jsonb_array_elements(p_transactions) as entry(item) on existing.id = entry.item->>'id'
    where existing.space_id <> p_space_id
  ) then
    raise exception 'Backup identifiers cannot overwrite records from another space';
  end if;
  importing_history := jsonb_array_length(p_movements) > 0;

  delete from public.transactions where space_id = p_space_id;
  update public.assets set is_archived = true where space_id = p_space_id and not is_archived;
  update public.debts set is_archived = true where space_id = p_space_id and not is_archived;
  if importing_history then perform set_config('app.import_movement_history', 'on', true); end if;

  insert into public.assets (id, user_id, space_id, name, kind, value, account_type_id, is_archived)
  select item->>'id', current_user_id, p_space_id, item->>'name', item->>'kind',
    (item->>'value')::bigint - case when importing_history then 0 else coalesce((
      select sum(
        case when event->>'linked_asset_id' = item->>'id'
          then (event->>'amount')::bigint * case event->>'balance_effect' when 'increase' then 1 when 'decrease' then -1 else 0 end
          else 0 end
        + case when event->>'linked_asset_id_2' = item->>'id'
          then (event->>'amount')::bigint * case event->>'balance_effect_2' when 'increase' then 1 when 'decrease' then -1 else 0 end
          else 0 end)
      from jsonb_array_elements(p_transactions) as entry(event)
      where event->>'linked_asset_id' = item->>'id' or event->>'linked_asset_id_2' = item->>'id'
    ), 0) end,
    coalesce(
      (select finance_type.id from public.space_finance_types as finance_type
        where finance_type.id = nullif(item->>'account_type_id', '')::uuid
          and finance_type.space_id = p_space_id and finance_type.account_kind = 'asset'),
      (select finance_type.id from public.space_finance_types as finance_type
        where finance_type.space_id = p_space_id and finance_type.account_kind = 'asset'
          and finance_type.code = case lower(trim(coalesce(item->>'kind', '')))
            when 'cash' then 'cash' when 'investment' then 'investment'
            when 'property' then 'property' when 'business' then 'business'
            when 'other' then 'other' when '' then 'other'
            else 'legacy-' || md5(lower(trim(item->>'kind'))) end limit 1),
      (select finance_type.id from public.space_finance_types as finance_type
        where finance_type.space_id = p_space_id and finance_type.account_kind = 'asset' and finance_type.code = 'other' limit 1)
    ), coalesce((item->>'is_archived')::boolean, false)
  from jsonb_array_elements(p_assets) as entry(item)
  on conflict (id) do update set
    user_id = excluded.user_id, space_id = excluded.space_id, name = excluded.name,
    kind = excluded.kind, value = excluded.value, account_type_id = excluded.account_type_id,
    is_archived = excluded.is_archived;

  insert into public.debts (id, user_id, space_id, name, kind, amount, due_date, account_type_id, is_archived)
  select item->>'id', current_user_id, p_space_id, item->>'name', item->>'kind',
    (item->>'amount')::bigint - case when importing_history then 0 else coalesce((
      select sum(
        case when event->>'linked_debt_id' = item->>'id'
          then (event->>'amount')::bigint * case event->>'balance_effect' when 'increase' then 1 when 'decrease' then -1 else 0 end
          else 0 end
        + case when event->>'linked_debt_id_2' = item->>'id'
          then (event->>'amount')::bigint * case event->>'balance_effect_2' when 'increase' then 1 when 'decrease' then -1 else 0 end
          else 0 end)
      from jsonb_array_elements(p_transactions) as entry(event)
      where event->>'linked_debt_id' = item->>'id' or event->>'linked_debt_id_2' = item->>'id'
    ), 0) end,
    nullif(item->>'due_date', '')::date,
    coalesce(
      (select finance_type.id from public.space_finance_types as finance_type
        where finance_type.id = nullif(item->>'account_type_id', '')::uuid
          and finance_type.space_id = p_space_id and finance_type.account_kind = 'liability'),
      (select finance_type.id from public.space_finance_types as finance_type
        where finance_type.space_id = p_space_id and finance_type.account_kind = 'liability'
          and finance_type.code = case lower(trim(coalesce(item->>'kind', '')))
            when 'vay' then 'loan' when 'thẻ tín dụng' then 'credit-card'
            when 'trả góp' then 'installment' when 'khác' then 'other'
            when '' then 'other'
            else 'legacy-' || md5(lower(trim(item->>'kind'))) end limit 1),
      (select finance_type.id from public.space_finance_types as finance_type
        where finance_type.space_id = p_space_id and finance_type.account_kind = 'liability' and finance_type.code = 'other' limit 1)
    ), coalesce((item->>'is_archived')::boolean, false)
  from jsonb_array_elements(p_debts) as entry(item)
  on conflict (id) do update set
    user_id = excluded.user_id, space_id = excluded.space_id, name = excluded.name,
    kind = excluded.kind, amount = excluded.amount, due_date = excluded.due_date,
    account_type_id = excluded.account_type_id, is_archived = excluded.is_archived;

  if importing_history then perform set_config('app.skip_transaction_movement', 'on', true); end if;
  insert into public.transactions (
    id, user_id, space_id, type, amount, category, note, date,
    linked_asset_id, linked_debt_id, balance_effect,
    linked_asset_id_2, linked_debt_id_2, balance_effect_2,
    balance_movement_type, balance_movement_type_2
  )
  select item->>'id', current_user_id, p_space_id, item->>'type', (item->>'amount')::bigint,
    item->>'category', coalesce(item->>'note', ''), (item->>'date')::timestamptz,
    nullif(item->>'linked_asset_id', ''), nullif(item->>'linked_debt_id', ''),
    nullif(item->>'balance_effect', ''),
    nullif(item->>'linked_asset_id_2', ''), nullif(item->>'linked_debt_id_2', ''),
    nullif(item->>'balance_effect_2', ''),
    nullif(item->>'balance_movement_type', ''), nullif(item->>'balance_movement_type_2', '')
  from jsonb_array_elements(p_transactions) as entry(item);
  if importing_history then
    perform set_config('app.skip_transaction_movement', 'off', true);
    insert into public.account_movements (
      id, space_id, account_kind, account_id, account_name, amount, movement_type,
      source_transaction_id, transaction_leg, transfer_id, note, occurred_at, created_at, idempotency_key
    )
    select (item->>'id')::uuid, p_space_id, item->>'account_kind', item->>'account_id',
      item->>'account_name', (item->>'amount')::bigint, item->>'movement_type',
      nullif(item->>'source_transaction_id', ''), nullif(item->>'transaction_leg', '')::smallint,
      nullif(item->>'transfer_id', '')::uuid, coalesce(item->>'note', ''),
      (item->>'occurred_at')::timestamptz, (item->>'created_at')::timestamptz,
      nullif(item->>'idempotency_key', '')
    from jsonb_array_elements(p_movements) as entry(item)
    on conflict do nothing;
    perform set_config('app.import_movement_history', 'off', true);
  end if;
end;
$$;

create or replace function public.replace_financial_data(
  p_space_id uuid, p_transactions jsonb, p_assets jsonb, p_debts jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.replace_financial_data(p_space_id, p_transactions, p_assets, p_debts, '[]'::jsonb);
end;
$$;

revoke all on function public.seed_space_finance_types(uuid) from public, anon, authenticated;
revoke all on function public.seed_space_finance_types_on_create() from public, anon, authenticated;
revoke all on function public.validate_account_type() from public, anon, authenticated;
revoke all on function public.apply_account_movement() from public, anon, authenticated;
revoke all on function public.prevent_direct_account_balance_update() from public, anon, authenticated;
revoke all on function public.capture_asset_opening_movement() from public, anon, authenticated;
revoke all on function public.capture_liability_opening_movement() from public, anon, authenticated;
revoke all on function public.append_transaction_account_movement(uuid, text, text, bigint, text, text, smallint, text, timestamptz) from public, anon, authenticated;
revoke all on function public.apply_transaction_balance_effect() from public, anon, authenticated;
revoke all on function public.create_space_finance_type(uuid, text, text, boolean) from public, anon;
revoke all on function public.archive_space_finance_type(uuid, uuid) from public, anon;
revoke all on function public.set_space_finance_type_liquidity(uuid, uuid, boolean) from public, anon;
revoke all on function public.record_account_movement(uuid, text, text, bigint, text, text, timestamptz) from public, anon;
revoke all on function public.record_account_transfer(uuid, text, text, text, text, text, bigint, text, timestamptz) from public, anon;
revoke all on function public.list_space_assets(uuid, timestamptz, text, integer, boolean) from public, anon;
revoke all on function public.list_space_liabilities(uuid, timestamptz, text, integer, boolean) from public, anon;
revoke all on function public.list_space_balance_movements(uuid, timestamptz, uuid, integer) from public, anon;
revoke all on function public.search_space_accounts(uuid, text, integer) from public, anon;
revoke all on function public.get_space_financial_summary(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.list_space_transactions(uuid, timestamptz, text, integer, text) from public, anon;
revoke all on function public.replace_financial_data(uuid, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.replace_financial_data(uuid, jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.create_space_finance_type(uuid, text, text, boolean) to authenticated;
grant execute on function public.archive_space_finance_type(uuid, uuid) to authenticated;
grant execute on function public.set_space_finance_type_liquidity(uuid, uuid, boolean) to authenticated;
grant execute on function public.record_account_movement(uuid, text, text, bigint, text, text, timestamptz) to authenticated;
grant execute on function public.record_account_transfer(uuid, text, text, text, text, text, bigint, text, timestamptz) to authenticated;
grant execute on function public.list_space_assets(uuid, timestamptz, text, integer, boolean) to authenticated;
grant execute on function public.list_space_liabilities(uuid, timestamptz, text, integer, boolean) to authenticated;
grant execute on function public.list_space_balance_movements(uuid, timestamptz, uuid, integer) to authenticated;
grant execute on function public.search_space_accounts(uuid, text, integer) to authenticated;
grant execute on function public.get_space_financial_summary(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.list_space_transactions(uuid, timestamptz, text, integer, text) to authenticated;
grant execute on function public.replace_financial_data(uuid, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.replace_financial_data(uuid, jsonb, jsonb, jsonb, jsonb) to authenticated;

commit;
