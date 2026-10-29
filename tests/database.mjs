// PGlite executes the real PostgreSQL schema and RLS policies locally.
// Bootstrap its pinned package using scripts/test-database.ps1 first.
import { PGlite } from '../.tools/package/dist/index.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db = new PGlite();
let checks = 0;
const alice = '00000000-0000-0000-0000-000000000001';
const bob = '00000000-0000-0000-0000-000000000002';
const outsider = '00000000-0000-0000-0000-000000000003';
async function as(id) { await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false);`); }
async function admin() { await db.exec('reset role'); }
async function scalar(sql, params = []) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
async function denied(sql, params = []) { await assert.rejects(db.query(sql, params)); checks++; }
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }
try {
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    insert into auth.users values ('${alice}', '{"display_name":"Alice"}'), ('${bob}', '{"display_name":"Bob"}'), ('${outsider}', '{"display_name":"Outsider"}');`);
  await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  await db.exec('set role anon');
  await denied('select * from public.events');
  await denied("select public.create_workspace('Anonymous space')");
  await denied("select public.join_workspace(repeat('a',64))");
  await as(alice);
  const space = await scalar("select public.create_workspace('Our everyday')");
  equal(await scalar('select count(*)::int from public.workspace_members'), 1);
  const event = await scalar("insert into public.events(workspace_id,title,event_date) values ($1,'Dinner','2026-10-29') returning id", [space]);
  const task = await scalar("insert into public.tasks(workspace_id,title) values ($1,'Shopping') returning id", [space]);
  const token = await scalar('select public.create_workspace_invite($1)', [space]);
  equal(token.length, 64);
  await denied('select * from private.workspace_invites');
  await denied('update public.workspaces set owner_id=$1 where id=$2', [bob, space]);
  await as(outsider);
  const otherSpace = await scalar("select public.create_workspace('Separate space')");
  equal(await scalar('select count(*)::int from public.events'), 0);
  equal(await scalar('select count(*)::int from public.tasks'), 0);
  equal(await scalar('select count(*)::int from public.workspaces where id=$1', [space]), 0);
  equal((await db.query('update public.tasks set completed=true where id=$1 returning id', [task])).rows.length, 0);
  equal((await db.query('delete from public.events where id=$1 returning id', [event])).rows.length, 0);
  await denied("insert into public.events(workspace_id,title,event_date) values ($1,'Intrusion','2026-10-30')", [space]);
  await denied('select public.create_workspace_invite($1)', [space]);
  await denied('select public.revoke_workspace_invites($1)', [space]);
  await denied('select public.remove_workspace_member($1,$2)', [space, alice]);
  await denied("insert into public.workspace_members(workspace_id,user_id,display_name) values ($1,$2,'Intruder')", [space, outsider]);
  await denied("select public.join_workspace(repeat('0',64))");
  await as(bob);
  equal(await scalar('select public.join_workspace($1)', [token]), space);
  equal(await scalar('select public.join_workspace($1)', [token]), space); // joining twice is safe
  equal(await scalar('select count(*)::int from public.events'), 1);
  equal(await scalar('select count(*)::int from public.workspace_members'), 2);
  await db.query('update public.tasks set completed=true where id=$1', [task]);
  equal(await scalar('select completed from public.tasks where id=$1', [task]), true);
  await db.query("update public.events set title='Shared dinner' where id=$1", [event]);
  await denied('update public.events set workspace_id=$1 where id=$2', [otherSpace, event]);
  await denied('update public.tasks set created_by=$1 where id=$2', [alice, task]);
  await denied("insert into public.tasks(workspace_id,title,created_by) values ($1,'Spoof',$2)", [space, alice]);
  await denied('select public.create_workspace_invite($1)', [space]);
  await as(alice);
  equal(await scalar('select title from public.events where id=$1', [event]), 'Shared dinner');
  await denied('select public.remove_workspace_member($1,$2)', [space, alice]);
  await db.query('select public.remove_workspace_member($1,$2)', [space, bob]);
  await as(bob);
  equal(await scalar('select count(*)::int from public.tasks'), 0);
  equal(await scalar('select count(*)::int from public.events'), 0);
  await denied('select public.join_workspace($1)', [token]);
  await as(alice);
  const expiringToken = await scalar('select public.create_workspace_invite($1)', [space]);
  await admin(); await db.exec("update private.workspace_invites set expires_at=now()-interval '1 second'");
  await as(bob); await denied('select public.join_workspace($1)', [expiringToken]);
  await as(alice);
  const revokedToken = await scalar('select public.create_workspace_invite($1)', [space]);
  await db.query('select public.revoke_workspace_invites($1)', [space]);
  await as(bob); await denied('select public.join_workspace($1)', [revokedToken]);
  console.log(`PASS: ${checks} PostgreSQL access, invitation, isolation and shared-edit checks.`);
} finally { await db.close(); }
