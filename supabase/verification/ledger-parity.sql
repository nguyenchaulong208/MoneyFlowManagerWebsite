-- Run after all ledger migrations on a staging copy. Both result sets should be empty.

with account_balances as (
  select space_id, 'asset'::text as account_kind, id as account_id, value as stored_balance
  from public.assets
  union all
  select space_id, 'liability'::text, id, amount
  from public.debts
),
movement_balances as (
  select space_id, account_kind, account_id, sum(amount) as ledger_balance
  from public.account_movements
  group by space_id, account_kind, account_id
)
select accounts.space_id, accounts.account_kind, accounts.account_id,
  accounts.stored_balance, coalesce(movements.ledger_balance, 0) as ledger_balance
from account_balances as accounts
left join movement_balances as movements
  using (space_id, account_kind, account_id)
where accounts.stored_balance is distinct from coalesce(movements.ledger_balance, 0)
order by accounts.space_id, accounts.account_kind, accounts.account_id;

with linked_legs as (
  select tx.space_id, tx.id as transaction_id, 1::smallint as transaction_leg
  from public.transactions as tx
  where tx.linked_asset_id is not null or tx.linked_debt_id is not null
  union all
  select tx.space_id, tx.id, 2::smallint
  from public.transactions as tx
  where tx.linked_asset_id_2 is not null or tx.linked_debt_id_2 is not null
)
select linked_legs.space_id, linked_legs.transaction_id, linked_legs.transaction_leg
from linked_legs
where not exists (
  select 1
  from public.account_movements as movements
  where movements.space_id = linked_legs.space_id
    and movements.source_transaction_id = linked_legs.transaction_id
    and movements.transaction_leg = linked_legs.transaction_leg
)
order by linked_legs.space_id, linked_legs.transaction_id, linked_legs.transaction_leg;
