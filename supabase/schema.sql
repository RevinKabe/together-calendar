-- Run once in a fresh Supabase project's SQL editor (as the project administrator).
-- Each space is private. Only members can access its events and tasks.
begin;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 80),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_by_user on public.workspace_members(user_id);
create table public.events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  event_date date not null,
  start_time time,
  category text not null default 'sage' check (category in ('sage','lavender','peach')),
  notes text not null default '' check (length(notes) <= 2000),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_by_workspace_date on public.events(workspace_id, event_date);
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  due_date date,
  category text not null default 'sage' check (category in ('sage','lavender','peach')),
  notes text not null default '' check (length(notes) <= 2000),
  assigned_to text not null default '' check (length(assigned_to) <= 80),
  completed boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_by_workspace on public.tasks(workspace_id);
create table private.workspace_invites (
  token_hash text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days'
);
create index workspace_invites_by_workspace on private.workspace_invites(workspace_id);

create function private.is_member(target_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspace_members where workspace_id = target_workspace and user_id = auth.uid());
$$;
create function private.is_owner(target_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspaces where id = target_workspace and owner_id = auth.uid());
$$;
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger events_updated_at before update on public.events for each row execute function private.touch_updated_at();
create trigger tasks_updated_at before update on public.tasks for each row execute function private.touch_updated_at();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.events enable row level security;
alter table public.tasks enable row level security;
alter table private.workspace_invites enable row level security;
create policy workspace_read on public.workspaces for select to authenticated using (private.is_member(id));
create policy member_read on public.workspace_members for select to authenticated using (private.is_member(workspace_id));
create policy event_read on public.events for select to authenticated using (private.is_member(workspace_id));
create policy event_insert on public.events for insert to authenticated with check (private.is_member(workspace_id) and created_by = (select auth.uid()));
create policy event_update on public.events for update to authenticated using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy event_delete on public.events for delete to authenticated using (private.is_member(workspace_id));
create policy task_read on public.tasks for select to authenticated using (private.is_member(workspace_id));
create policy task_insert on public.tasks for insert to authenticated with check (private.is_member(workspace_id) and created_by = (select auth.uid()));
create policy task_update on public.tasks for update to authenticated using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy task_delete on public.tasks for delete to authenticated using (private.is_member(workspace_id));

-- Remove broad defaults before granting narrowly scoped access.
revoke all on public.workspaces, public.workspace_members, public.events, public.tasks from public, anon, authenticated;
revoke all on private.workspace_invites from public, anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.events, public.tasks to authenticated;
grant insert (workspace_id, title, event_date, start_time, category, notes, created_by) on public.events to authenticated;
grant update (title, event_date, start_time, category, notes) on public.events to authenticated;
grant insert (workspace_id, title, due_date, category, notes, assigned_to, completed, created_by) on public.tasks to authenticated;
grant update (title, due_date, category, notes, assigned_to, completed) on public.tasks to authenticated;
grant delete on public.events, public.tasks to authenticated;

create function public.create_workspace(workspace_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare space_id uuid; member_name text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if length(btrim(workspace_name)) not between 1 and 80 then raise exception 'Choose a name of 1–80 characters'; end if;
  select left(coalesce(nullif(btrim(raw_user_meta_data->>'display_name'), ''), 'Member'), 80) into member_name from auth.users where id = auth.uid();
  insert into public.workspaces(name, owner_id) values (btrim(workspace_name), auth.uid()) returning id into space_id;
  insert into public.workspace_members(workspace_id, user_id, display_name) values (space_id, auth.uid(), member_name);
  return space_id;
end;
$$;
create function public.create_workspace_invite(target_workspace uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare token text;
begin
  if not private.is_owner(target_workspace) then raise exception 'Only the space owner can invite people'; end if;
  token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into private.workspace_invites(token_hash, workspace_id) values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), target_workspace);
  return token;
end;
$$;
create function public.join_workspace(invite_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare space_id uuid; member_name text;
begin
  if auth.uid() is null then raise exception 'Sign in to accept this invitation'; end if;
  if invite_token !~ '^[a-f0-9]{64}$' then raise exception 'This invite is invalid or has expired'; end if;
  select workspace_id into space_id from private.workspace_invites
    where token_hash = encode(sha256(convert_to(invite_token, 'UTF8')), 'hex') and expires_at > now() for update;
  if space_id is null then raise exception 'This invite is invalid or has expired'; end if;
  select left(coalesce(nullif(btrim(raw_user_meta_data->>'display_name'), ''), 'Member'), 80) into member_name from auth.users where id = auth.uid();
  insert into public.workspace_members(workspace_id, user_id, display_name) values (space_id, auth.uid(), member_name) on conflict do nothing;
  return space_id;
end;
$$;
create function public.revoke_workspace_invites(target_workspace uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_owner(target_workspace) then raise exception 'Only the space owner can revoke invitations'; end if;
  delete from private.workspace_invites where workspace_id = target_workspace;
end;
$$;
create function public.remove_workspace_member(target_workspace uuid, target_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_owner(target_workspace) then raise exception 'Only the space owner can remove members'; end if;
  if target_user = auth.uid() then raise exception 'The owner cannot be removed'; end if;
  -- Invalidate old links so the removed member cannot use one to immediately rejoin.
  delete from private.workspace_invites where workspace_id = target_workspace;
  delete from public.workspace_members where workspace_id = target_workspace and user_id = target_user;
end;
$$;

revoke all on function private.is_member(uuid), private.is_owner(uuid), private.touch_updated_at() from public, anon, authenticated;
grant execute on function private.is_member(uuid), private.is_owner(uuid) to authenticated;
revoke all on function public.create_workspace(text), public.create_workspace_invite(uuid), public.join_workspace(text), public.revoke_workspace_invites(uuid), public.remove_workspace_member(uuid,uuid) from public, anon, authenticated;
grant execute on function public.create_workspace(text), public.create_workspace_invite(uuid), public.join_workspace(text), public.revoke_workspace_invites(uuid), public.remove_workspace_member(uuid,uuid) to authenticated;
commit;
