begin;

create or replace function public.rename_transaction_category(
  p_space_id uuid, p_category_id uuid, p_type text, p_label text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_label text := trim(coalesce(p_label, ''));
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then
    raise exception 'Space membership required';
  end if;
  if length(normalized_label) not between 1 and 60 then
    raise exception 'Category label must contain 1 to 60 characters';
  end if;
  if p_type is null or p_type not in ('income', 'expense') then
    raise exception 'Category type must be income or expense';
  end if;
  update public.transaction_categories
  set type = p_type, label = normalized_label
  where id = p_category_id and space_id = p_space_id and not is_archived;
  if not found then raise exception 'Active category not found'; end if;
end;
$$;

create or replace function public.rename_space_finance_type(
  p_space_id uuid, p_type_id uuid, p_label text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_label text := trim(coalesce(p_label, ''));
begin
  if auth.uid() is null or not public.is_space_member(p_space_id) then
    raise exception 'Space membership required';
  end if;
  if length(normalized_label) not between 1 and 60 then
    raise exception 'Type label must contain 1 to 60 characters';
  end if;
  update public.space_finance_types
  set label = normalized_label
  where id = p_type_id and space_id = p_space_id and not is_archived;
  if not found then raise exception 'Active account type not found'; end if;
end;
$$;

create or replace function public.list_space_liquid_assets(
  p_space_id uuid, p_before_created_at timestamptz default null, p_before_id text default null,
  p_limit integer default 5
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
  if auth.uid() is null or not public.is_space_member(p_space_id) then
    raise exception 'Space membership required';
  end if;
  if p_limit not between 1 and 101 then raise exception 'Page size must be between 1 and 101'; end if;
  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'Both cursor values are required';
  end if;
  return query
  select item.id, item.name, item.kind, item.value, item.account_type_id,
    finance_type.label, finance_type.code, finance_type.is_liquid, item.is_archived, item.created_at
  from public.assets as item
  join public.space_finance_types as finance_type
    on finance_type.id = item.account_type_id and finance_type.space_id = item.space_id
  where item.space_id = p_space_id and not item.is_archived and finance_type.is_liquid
    and (p_before_created_at is null or (item.created_at, item.id) < (p_before_created_at, p_before_id))
  order by item.created_at desc, item.id desc
  limit p_limit;
end;
$$;

create or replace function public.get_space_financial_summary_v2(
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
  period_income numeric;
  period_expense numeric;
begin
  summary := public.get_space_financial_summary(p_space_id, p_month_start, p_month_end);
  period_income := coalesce((summary->>'month_income')::numeric, 0);
  period_expense := coalesce((summary->>'month_expense')::numeric, 0);
  return summary || jsonb_build_object(
    'month_net_cash_flow', period_income - period_expense,
    'income_expense_ratio', period_expense / nullif(period_income, 0),
    'savings_rate', (period_income - period_expense) / nullif(period_income, 0)
  );
end;
$$;

revoke all on function public.rename_transaction_category(uuid, uuid, text, text) from public, anon;
revoke all on function public.rename_space_finance_type(uuid, uuid, text) from public, anon;
revoke all on function public.list_space_liquid_assets(uuid, timestamptz, text, integer) from public, anon;
revoke all on function public.get_space_financial_summary_v2(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.rename_transaction_category(uuid, uuid, text, text) to authenticated;
grant execute on function public.rename_space_finance_type(uuid, uuid, text) to authenticated;
grant execute on function public.list_space_liquid_assets(uuid, timestamptz, text, integer) to authenticated;
grant execute on function public.get_space_financial_summary_v2(uuid, timestamptz, timestamptz) to authenticated;

commit;
