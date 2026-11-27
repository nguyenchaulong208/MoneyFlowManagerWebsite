-- The transaction trigger passes integer literals for its two movement legs.
-- Keep the existing smallint helper and resolve those calls through an explicit cast.
begin;

create or replace function public.append_transaction_account_movement(
  p_space_id uuid,
  p_account_kind text,
  p_account_id text,
  p_amount bigint,
  p_movement_type text,
  p_transaction_id text,
  p_leg integer,
  p_note text,
  p_occurred_at timestamptz
)
returns void
language sql
security definer
set search_path = ''
as $$
  select public.append_transaction_account_movement(
    p_space_id, p_account_kind, p_account_id, p_amount, p_movement_type,
    p_transaction_id, p_leg::smallint, p_note, p_occurred_at
  );
$$;

revoke all on function public.append_transaction_account_movement(
  uuid, text, text, bigint, text, text, integer, text, timestamptz
) from public, anon, authenticated;

commit;
