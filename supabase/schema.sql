-- Dòng Tiền finance spaces and household sharing for Supabase.
-- Safe to re-run. Existing per-user records are migrated into private spaces.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('personal', 'family')),
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists spaces_one_personal_per_owner_idx
  on public.spaces (owner_id) where kind = 'personal';
create index if not exists spaces_owner_idx on public.spaces (owner_id);

create table if not exists public.space_members (
  space_id uuid not null references public.spaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  member_email text,
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);
alter table public.space_members add column if not exists member_email text;
create index if not exists space_members_user_idx on public.space_members (user_id, space_id);

create or replace function public.add_space_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.space_members (space_id, user_id, role, member_email)
  select new.id, new.owner_id, 'owner', users.email
  from auth.users as users where users.id = new.owner_id
  on conflict (space_id, user_id) do update set role = 'owner', member_email = excluded.member_email;
  return new;
end;
$$;

drop trigger if exists add_space_owner on public.spaces;
create trigger add_space_owner after insert on public.spaces
for each row execute function public.add_space_owner();

-- Existing accounts receive a private space without changing ownership or data.
insert into public.spaces (name, kind, owner_id)
select 'Cá nhân', 'personal', users.id
from auth.users as users
on conflict do nothing;

update public.space_members as members
set member_email = users.email
from auth.users as users
where members.user_id = users.id and members.member_email is null;

insert into public.space_members (space_id, user_id, role, member_email)
select spaces.id, spaces.owner_id, 'owner', users.email
from public.spaces as spaces
join auth.users as users on users.id = spaces.owner_id
where spaces.kind = 'personal'
on conflict (space_id, user_id) do update set role = 'owner', member_email = excluded.member_email;

create or replace function public.create_personal_space_for_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.spaces (name, kind, owner_id)
  values ('Cá nhân', 'personal', new.id)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists create_personal_space_for_user on auth.users;
create trigger create_personal_space_for_user after insert on auth.users
for each row execute function public.create_personal_space_for_user();

create table if not exists public.transactions (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  type text not null check (type in ('income', 'expense')),
  amount bigint not null check (amount > 0),
  category text not null,
  note text not null default '',
  date timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.transactions add column if not exists space_id uuid references public.spaces (id) on delete cascade;
update public.transactions as item
set space_id = spaces.id
from public.spaces as spaces
where item.space_id is null and spaces.owner_id = item.user_id and spaces.kind = 'personal';
alter table public.transactions alter column space_id set not null;
create index if not exists transactions_space_date_idx on public.transactions (space_id, date desc);

create table if not exists public.assets (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  name text not null,
  kind text not null,
  value bigint not null check (value >= 0),
  created_at timestamptz not null default now()
);
alter table public.assets add column if not exists space_id uuid references public.spaces (id) on delete cascade;
update public.assets as item
set space_id = spaces.id
from public.spaces as spaces
where item.space_id is null and spaces.owner_id = item.user_id and spaces.kind = 'personal';
alter table public.assets alter column space_id set not null;
create index if not exists assets_space_created_idx on public.assets (space_id, created_at desc);

create table if not exists public.debts (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  name text not null,
  kind text not null,
  amount bigint not null check (amount >= 0),
  due_date date,
  created_at timestamptz not null default now()
);
alter table public.debts add column if not exists space_id uuid references public.spaces (id) on delete cascade;
update public.debts as item
set space_id = spaces.id
from public.spaces as spaces
where item.space_id is null and spaces.owner_id = item.user_id and spaces.kind = 'personal';
alter table public.debts alter column space_id set not null;
create index if not exists debts_space_created_idx on public.debts (space_id, created_at desc);

create table if not exists public.space_invites (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  invited_email text,
  token_hash bytea not null unique,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  revoked_at timestamptz,
  check (invited_email is null or invited_email = lower(invited_email))
);
create index if not exists space_invites_space_created_idx on public.space_invites (space_id, created_at desc);

create or replace function public.is_space_member(p_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.space_members
    where space_id = p_space_id and user_id = (select auth.uid())
  );
$$;

create or replace function public.can_manage_space_members(p_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.space_members
    where space_id = p_space_id
      and user_id = (select auth.uid())
      and role in ('owner', 'admin')
  );
$$;

create or replace function public.is_space_owner(p_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.spaces
    where id = p_space_id and owner_id = (select auth.uid())
  );
$$;

alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.space_invites enable row level security;
alter table public.transactions enable row level security;
alter table public.assets enable row level security;
alter table public.debts enable row level security;

drop policy if exists "Users manage their own transactions" on public.transactions;
drop policy if exists "Users manage their own assets" on public.assets;
drop policy if exists "Users manage their own debts" on public.debts;
drop policy if exists "Members can view their spaces" on public.spaces;
create policy "Members can view their spaces" on public.spaces
  for select to authenticated using (public.is_space_member(id));
drop policy if exists "Members can view household membership" on public.space_members;
create policy "Members can view household membership" on public.space_members
  for select to authenticated using (public.is_space_member(space_id));
drop policy if exists "Managers can view invitations" on public.space_invites;
create policy "Managers can view invitations" on public.space_invites
  for select to authenticated using (public.can_manage_space_members(space_id));

drop policy if exists "Members can view space transactions" on public.transactions;
create policy "Members can view space transactions" on public.transactions
  for select to authenticated using (public.is_space_member(space_id));
drop policy if exists "Members can add space transactions" on public.transactions;
create policy "Members can add space transactions" on public.transactions
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_space_member(space_id));
drop policy if exists "Members can edit space transactions" on public.transactions;
create policy "Members can edit space transactions" on public.transactions
  for update to authenticated using (public.is_space_member(space_id))
  with check (public.is_space_member(space_id));
drop policy if exists "Members can remove space transactions" on public.transactions;
create policy "Members can remove space transactions" on public.transactions
  for delete to authenticated using (public.is_space_member(space_id));

drop policy if exists "Members can view space assets" on public.assets;
create policy "Members can view space assets" on public.assets
  for select to authenticated using (public.is_space_member(space_id));
drop policy if exists "Members can add space assets" on public.assets;
create policy "Members can add space assets" on public.assets
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_space_member(space_id));
drop policy if exists "Members can edit space assets" on public.assets;
create policy "Members can edit space assets" on public.assets
  for update to authenticated using (public.is_space_member(space_id))
  with check (public.is_space_member(space_id));
drop policy if exists "Members can remove space assets" on public.assets;
create policy "Members can remove space assets" on public.assets
  for delete to authenticated using (public.is_space_member(space_id));

drop policy if exists "Members can view space debts" on public.debts;
create policy "Members can view space debts" on public.debts
  for select to authenticated using (public.is_space_member(space_id));
drop policy if exists "Members can add space debts" on public.debts;
create policy "Members can add space debts" on public.debts
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_space_member(space_id));
drop policy if exists "Members can edit space debts" on public.debts;
create policy "Members can edit space debts" on public.debts
  for update to authenticated using (public.is_space_member(space_id))
  with check (public.is_space_member(space_id));
drop policy if exists "Members can remove space debts" on public.debts;
create policy "Members can remove space debts" on public.debts
  for delete to authenticated using (public.is_space_member(space_id));

grant select on public.spaces, public.space_members, public.space_invites to authenticated;
grant select, insert, update, delete on public.transactions, public.assets, public.debts to authenticated;

create or replace function public.create_family_space(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_space_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'Space name must contain 1 to 80 characters';
  end if;
  insert into public.spaces (name, kind, owner_id)
  values (trim(p_name), 'family', auth.uid())
  returning id into new_space_id;
  return new_space_id;
end;
$$;

create or replace function public.create_space_invite(p_space_id uuid, p_email text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  invite_token text;
  normalized_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.can_manage_space_members(p_space_id) then raise exception 'Only a space owner or admin can invite members'; end if;
  if normalized_email is not null and normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'A valid email address is required';
  end if;
  if (select kind from public.spaces where id = p_space_id) <> 'family' then
    raise exception 'Invitations are only available for family spaces';
  end if;
  if (select count(*) from public.space_invites
      where space_id = p_space_id and accepted_at is null and revoked_at is null and expires_at > now()) >= 50 then
    raise exception 'Too many active invitations; revoke an invitation before creating another';
  end if;

  invite_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.space_invites (space_id, invited_email, token_hash, created_by)
  values (p_space_id, normalized_email, extensions.digest(convert_to(invite_token, 'UTF8'), 'sha256'), auth.uid());
  return invite_token;
end;
$$;

drop function if exists public.revoke_space_invite(text);
create or replace function public.revoke_space_invite(p_invite_id uuid default null, p_token text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.space_invites
  set revoked_at = now()
  where (id = p_invite_id or (p_token is not null and token_hash = extensions.digest(convert_to(p_token, 'UTF8'), 'sha256')))
    and accepted_at is null and revoked_at is null
    and public.can_manage_space_members(space_id);
  if not found then raise exception 'Invitation not found or already used'; end if;
end;
$$;

create or replace function public.accept_space_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation public.space_invites%rowtype;
  current_email text := lower(coalesce(auth.jwt()->>'email', ''));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if coalesce(auth.jwt()->>'email_verified', 'false') <> 'true' then
    raise exception 'Verify your email address before accepting a family invitation';
  end if;
  if length(coalesce(p_token, '')) <> 64 then raise exception 'Invalid invitation token'; end if;
  select * into invitation from public.space_invites
  where token_hash = extensions.digest(convert_to(p_token, 'UTF8'), 'sha256')
  for update;
  if not found or invitation.accepted_at is not null or invitation.revoked_at is not null
    or invitation.expires_at <= now() then
    raise exception 'Invitation is invalid, expired, or already used';
  end if;
  if invitation.invited_email is not null and invitation.invited_email <> current_email then
    raise exception 'This invitation was sent to a different email address';
  end if;
  insert into public.space_members (space_id, user_id, role, member_email)
  values (invitation.space_id, auth.uid(), 'member', current_email)
  on conflict (space_id, user_id) do nothing;
  update public.space_invites set accepted_at = now() where id = invitation.id;
  return invitation.space_id;
end;
$$;

create or replace function public.remove_space_member(p_space_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_role text;
begin
  if not public.can_manage_space_members(p_space_id) then raise exception 'Only a space owner or admin can manage members'; end if;
  select role into target_role from public.space_members
  where space_id = p_space_id and user_id = p_user_id;
  if target_role is null then raise exception 'Member not found'; end if;
  if target_role in ('owner', 'admin') then raise exception 'Only the owner can change owner or admin membership'; end if;
  delete from public.space_members where space_id = p_space_id and user_id = p_user_id;
end;
$$;

create or replace function public.set_space_member_role(p_space_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_space_owner(p_space_id) then raise exception 'Only the space owner can assign admin roles'; end if;
  if p_role not in ('admin', 'member') then raise exception 'Role must be admin or member'; end if;
  update public.space_members set role = p_role
  where space_id = p_space_id and user_id = p_user_id and role <> 'owner';
  if not found then raise exception 'Member not found or cannot be changed'; end if;
end;
$$;

create or replace function public.delete_family_space(p_space_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_space_owner(p_space_id) then raise exception 'Only the space owner can delete a family space'; end if;
  delete from public.spaces where id = p_space_id and kind = 'family';
  if not found then raise exception 'Family space not found'; end if;
end;
$$;

-- Restore/clear replaces only the caller's private space, never a shared ledger.
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

  delete from public.transactions where space_id = p_space_id;
  delete from public.assets where space_id = p_space_id;
  delete from public.debts where space_id = p_space_id;

  insert into public.transactions (id, user_id, space_id, type, amount, category, note, date)
  select item->>'id', current_user_id, p_space_id, item->>'type', (item->>'amount')::bigint,
    item->>'category', coalesce(item->>'note', ''), (item->>'date')::timestamptz
  from jsonb_array_elements(p_transactions) as entry(item);

  insert into public.assets (id, user_id, space_id, name, kind, value)
  select item->>'id', current_user_id, p_space_id, item->>'name', item->>'kind', (item->>'value')::bigint
  from jsonb_array_elements(p_assets) as entry(item);

  insert into public.debts (id, user_id, space_id, name, kind, amount, due_date)
  select item->>'id', current_user_id, p_space_id, item->>'name', item->>'kind', (item->>'amount')::bigint,
    nullif(item->>'due_date', '')::date
  from jsonb_array_elements(p_debts) as entry(item);
end;
$$;

revoke all on function public.is_space_member(uuid) from public, anon;
revoke all on function public.can_manage_space_members(uuid) from public, anon;
revoke all on function public.is_space_owner(uuid) from public, anon;
revoke all on function public.create_family_space(text) from public, anon;
revoke all on function public.create_space_invite(uuid, text) from public, anon;
revoke all on function public.revoke_space_invite(uuid, text) from public, anon;
revoke all on function public.accept_space_invite(text) from public, anon;
revoke all on function public.remove_space_member(uuid, uuid) from public, anon;
revoke all on function public.set_space_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.delete_family_space(uuid) from public, anon;
revoke all on function public.replace_financial_data(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.is_space_member(uuid) to authenticated;
grant execute on function public.can_manage_space_members(uuid) to authenticated;
grant execute on function public.is_space_owner(uuid) to authenticated;
grant execute on function public.create_family_space(text) to authenticated;
grant execute on function public.create_space_invite(uuid, text) to authenticated;
grant execute on function public.revoke_space_invite(uuid, text) to authenticated;
grant execute on function public.accept_space_invite(text) to authenticated;
grant execute on function public.remove_space_member(uuid, uuid) to authenticated;
grant execute on function public.set_space_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.delete_family_space(uuid) to authenticated;
grant execute on function public.replace_financial_data(uuid, jsonb, jsonb, jsonb) to authenticated;
