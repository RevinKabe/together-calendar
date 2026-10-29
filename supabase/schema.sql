-- Fresh-project schema: run once as administrator. All calendar content is ciphertext.
-- This schema never accepts decryption keys or login passwords.
begin;
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
create function private.valid_ciphertext(value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(value) = 'object' and value - 'v' - 'iv' - 'ct' = '{}'::jsonb
    and value->'v' = '1'::jsonb and jsonb_typeof(value->'iv') = 'string' and jsonb_typeof(value->'ct') = 'string'
    and value->>'iv' ~ '^[A-Za-z0-9_-]{16}$' and length(value->>'ct') between 22 and 16000
    and value->>'ct' ~ '^[A-Za-z0-9_-]+$', false);
$$;
create function private.has_mfa() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null and coalesce(auth.jwt()->>'aal' = 'aal2', false);
$$;
create function private.require_mfa() returns void
language plpgsql stable set search_path = '' as $$
begin if not private.has_mfa() then raise exception 'Sign in and verify your authenticator code first'; end if; end;
$$;
create table public.workspaces (
  id uuid primary key,
  encrypted_name jsonb not null check (private.valid_ciphertext(encrypted_name)),
  key_epoch uuid not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(id, key_epoch)
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 80),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_by_user on public.workspace_members(user_id);
create table public.encrypted_records (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key_epoch uuid not null,
  ciphertext jsonb not null check (private.valid_ciphertext(ciphertext)),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp()
);
create index records_by_workspace on public.encrypted_records(workspace_id, id);
create table private.workspace_invites (
  token_hash text primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days'
);
create index workspace_invites_by_workspace on private.workspace_invites(workspace_id);
create function private.is_member(target_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_mfa() and exists(select 1 from public.workspace_members where workspace_id = target_workspace and user_id = auth.uid());
$$;
create function private.is_owner(target_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_mfa() and exists(select 1 from public.workspaces where id = target_workspace and owner_id = auth.uid());
$$;
create function private.current_epoch(target_workspace uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select key_epoch from public.workspaces where id = target_workspace and private.is_member(id);
$$;
create function private.lock_record_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare current_key uuid;
begin
  -- Serializes record writes with rotation. Concurrent conflicts may require a retry.
  select key_epoch into current_key from public.workspaces where id = coalesce(new.workspace_id,old.workspace_id) for key share;
  if tg_op = 'DELETE' then return old; end if;
  if current_key is null or new.key_epoch <> current_key then raise exception 'Space key changed; unlock with the current key and retry'; end if;
  if tg_op = 'UPDATE' then new.updated_at = clock_timestamp(); end if;
  return new;
end;
$$;
create trigger encrypted_records_write before insert or update or delete on public.encrypted_records for each row execute function private.lock_record_write();
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.encrypted_records enable row level security;
alter table private.workspace_invites enable row level security;
create policy workspace_read on public.workspaces for select to authenticated using (private.is_member(id));
create policy member_read on public.workspace_members for select to authenticated using (private.is_member(workspace_id));
create policy record_read on public.encrypted_records for select to authenticated using (private.is_member(workspace_id));
create policy record_insert on public.encrypted_records for insert to authenticated with check (private.is_member(workspace_id) and created_by = (select auth.uid()) and key_epoch = private.current_epoch(workspace_id));
create policy record_update on public.encrypted_records for update to authenticated using (private.is_member(workspace_id)) with check (private.is_member(workspace_id) and key_epoch = private.current_epoch(workspace_id));
create policy record_delete on public.encrypted_records for delete to authenticated using (private.is_member(workspace_id));
revoke all on public.workspaces, public.workspace_members, public.encrypted_records from public, anon, authenticated;
revoke all on private.workspace_invites from public, anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.encrypted_records to authenticated;
grant insert(id, workspace_id, key_epoch, ciphertext, created_by) on public.encrypted_records to authenticated;
grant update(ciphertext) on public.encrypted_records to authenticated;
grant delete on public.encrypted_records to authenticated;
create function public.create_workspace(space_id uuid, initial_epoch uuid, space_name jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare member_name text;
begin
  perform private.require_mfa();
  select left(coalesce(nullif(btrim(raw_user_meta_data->>'display_name'), ''), 'Member'), 80) into member_name from auth.users where id = auth.uid();
  insert into public.workspaces(id, encrypted_name, key_epoch, owner_id) values (space_id, space_name, initial_epoch, auth.uid());
  insert into public.workspace_members(workspace_id, user_id, display_name) values (space_id, auth.uid(), member_name);
  return space_id;
end;
$$;
create function public.create_workspace_invite(target_workspace uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare token text;
begin
  if not private.is_owner(target_workspace) then raise exception 'Only the verified space owner can invite people'; end if;
  token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into private.workspace_invites(token_hash, workspace_id) values (encode(sha256(convert_to(token, 'UTF8')), 'hex'), target_workspace);
  return token;
end;
$$;
create function public.join_workspace(invite_token text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare space_id uuid; member_name text;
begin
  perform private.require_mfa();
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
  if not private.is_owner(target_workspace) then raise exception 'Only the verified space owner can revoke invitations'; end if;
  delete from private.workspace_invites where workspace_id = target_workspace;
end;
$$;
create function public.rotate_workspace_key(target_workspace uuid, expected_epoch uuid, next_epoch uuid, space_name jsonb, replacements jsonb, removed_user uuid default null) returns void
language plpgsql security definer set search_path = '' as $$
declare actual_epoch uuid; total bigint; matched bigint; item jsonb;
begin
  if not private.is_owner(target_workspace) then raise exception 'Only the verified space owner can rotate keys'; end if;
  select key_epoch into actual_epoch from public.workspaces where id = target_workspace for update;
  if actual_epoch <> expected_epoch or next_epoch = expected_epoch then raise exception 'Space key changed; refresh and retry'; end if;
  if removed_user = auth.uid() then raise exception 'The owner cannot be removed'; end if;
  if removed_user is not null and not exists(select 1 from public.workspace_members where workspace_id=target_workspace and user_id=removed_user) then raise exception 'Member no longer exists'; end if;
  if jsonb_typeof(replacements) <> 'array' or replacements is null then raise exception 'Invalid rotation data'; end if;
  perform id from public.encrypted_records where workspace_id = target_workspace for update;
  select count(*) into total from public.encrypted_records where workspace_id = target_workspace;
  select count(distinct r.id) into matched from public.encrypted_records r join jsonb_array_elements(replacements) i
    on r.id = (i->>'id')::uuid and r.updated_at = (i->>'expected_updated_at')::timestamptz where r.workspace_id=target_workspace;
  if total <> jsonb_array_length(replacements) or matched <> total then raise exception 'Records changed on another device; refresh and retry'; end if;
  update public.workspaces set key_epoch=next_epoch, encrypted_name=space_name where id=target_workspace;
  for item in select value from jsonb_array_elements(replacements) loop
    update public.encrypted_records set key_epoch=next_epoch, ciphertext=item->'ciphertext' where id=(item->>'id')::uuid and workspace_id=target_workspace;
  end loop;
  delete from private.workspace_invites where workspace_id=target_workspace;
  if removed_user is not null then delete from public.workspace_members where workspace_id=target_workspace and user_id=removed_user; end if;
end;
$$;
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.valid_ciphertext(jsonb), private.has_mfa(), private.is_member(uuid), private.is_owner(uuid), private.current_epoch(uuid) to authenticated;
revoke all on function public.create_workspace(uuid,uuid,jsonb), public.create_workspace_invite(uuid), public.join_workspace(text), public.revoke_workspace_invites(uuid), public.rotate_workspace_key(uuid,uuid,uuid,jsonb,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.create_workspace(uuid,uuid,jsonb), public.create_workspace_invite(uuid), public.join_workspace(text), public.revoke_workspace_invites(uuid), public.rotate_workspace_key(uuid,uuid,uuid,jsonb,jsonb,uuid) to authenticated;
commit;
