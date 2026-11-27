-- Qualify the formatter call because this RPC intentionally uses an empty search_path.
begin;

create or replace function public.get_space_financial_summary_comparison(
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
  prev_summary jsonb;
  period_income numeric;
  period_expense numeric;
  prev_income numeric;
  prev_expense numeric;
  prev_start timestamptz;
  prev_end timestamptz;
begin
  summary := public.get_space_financial_summary(p_space_id, p_month_start, p_month_end);
  prev_start := (p_month_start - interval '1 month')::timestamptz;
  prev_end := (p_month_end - interval '1 month')::timestamptz;
  prev_summary := public.get_space_financial_summary(p_space_id, prev_start, prev_end);

  period_income := coalesce((summary->>'month_income')::numeric, 0);
  period_expense := coalesce((summary->>'month_expense')::numeric, 0);
  prev_income := coalesce((prev_summary->>'month_income')::numeric, 0);
  prev_expense := coalesce((prev_summary->>'month_expense')::numeric, 0);

  return jsonb_build_object(
    'current', summary,
    'previous', prev_summary,
    'income_variance', period_income - prev_income,
    'expense_variance', period_expense - prev_expense,
    'net_variance', (period_income - period_expense) - (prev_income - prev_expense),
    'income_change_pct', round((period_income - prev_income) * 100.0 / nullif(prev_income, 0), 1),
    'expense_change_pct', round((period_expense - prev_expense) * 100.0 / nullif(prev_expense, 0), 1),
    'income_change_text', public.format_change_text(period_income, prev_income),
    'expense_change_text', public.format_change_text(period_expense, prev_expense),
    'savings_rate', (period_income - period_expense) / nullif(period_income, 0),
    'expense_ratio', period_expense / nullif(period_income, 0)
  );
end;
$$;

revoke all on function public.get_space_financial_summary_comparison(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_space_financial_summary_comparison(uuid, timestamptz, timestamptz) to authenticated;

commit;
