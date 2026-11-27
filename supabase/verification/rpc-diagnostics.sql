-- Read-only check for the RPC signatures required by the current startup loader.
with required_rpcs (rpc_name, argument_types, required_migration) as (
  values
    ('list_space_transactions', 'uuid, timestamptz, text, integer, text', '20261127010000'),
    ('list_space_assets', 'uuid, timestamptz, text, integer, boolean', '20261127010000'),
    ('list_space_liabilities', 'uuid, timestamptz, text, integer, boolean', '20261127010000'),
    ('list_space_balance_movements', 'uuid, timestamptz, uuid, integer', '20261127010000'),
    ('list_space_liquid_assets', 'uuid, timestamptz, text, integer', '20261127120000'),
    ('get_space_financial_summary_v2', 'uuid, timestamptz, timestamptz', '20261127120000')
)
select
  rpc_name,
  argument_types,
  required_migration,
  to_regprocedure('public.' || rpc_name || '(' || argument_types || ')') is not null as installed
from required_rpcs
order by required_migration, rpc_name;
