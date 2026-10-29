// Read-only checks using the intentionally public client key; never an admin credential.
import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const scope = { window: {} };
vm.runInNewContext(await fs.readFile(new URL('../site/config.js', import.meta.url), 'utf8'), scope);
const { supabaseUrl, supabasePublishableKey } = scope.window.TOGETHER_CONFIG;
assert.match(supabasePublishableKey, /^sb_publishable_/);
const headers = { apikey: supabasePublishableKey };
for (const table of ['workspaces', 'workspace_members', 'encrypted_records']) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*&limit=1`, { headers });
  assert.equal(response.status, 401, `${table}: anonymous access must be denied`);
  const body = await response.json();
  assert.equal(body.code, '42501');
  console.log(`PASS: anonymous access to ${table} denied`);
}
const privateResponse = await fetch(`${supabaseUrl}/rest/v1/workspace_invites?select=*&limit=1`, { headers: { ...headers, 'Accept-Profile': 'private' } });
assert.equal(privateResponse.status, 406);
assert.equal((await privateResponse.json()).code, 'PGRST106');
console.log('PASS: private invitation schema is not exposed');
const settingsResponse = await fetch(`${supabaseUrl}/auth/v1/settings`, { headers });
assert.equal(settingsResponse.status, 200);
const settings = await settingsResponse.json();
assert.equal(settings.mailer_autoconfirm, false);
assert.equal(settings.external.anonymous_users, false);
assert.equal(settings.external.email, true);
console.log('PASS: email confirmation required; anonymous login disabled');
