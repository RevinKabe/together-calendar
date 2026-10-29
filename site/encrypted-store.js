import { context, encrypt, decrypt, contentOf } from './crypto.js';
export function checked(response) { if (response.error) throw response.error; return response.data; }
export async function unlockName(workspace, key) {
  const data = await decrypt(key, workspace.encrypted_name, context(workspace.id, workspace.key_epoch));
  if (data.kind !== 'workspace' || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) throw new Error('Invalid encrypted space.');
  return data.name;
}
export async function decodeRecord(workspace, row, key) {
  if (row.workspace_id !== workspace.id || row.key_epoch !== workspace.key_epoch) throw new Error('Encryption keys changed. Lock and unlock this space with its current key.');
  const content = await decrypt(key, row.ciphertext, context(row.workspace_id, row.key_epoch, row.id));
  return { ...contentOf(content.kind, content), id: row.id, workspace_id: row.workspace_id, created_at: row.created_at, updated_at: row.updated_at };
}
export async function loadEncryptedRecords(client, workspace) {
  // Page through all ciphertext; do not silently lose records at Supabase's row limit.
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const batch = checked(await client.from('encrypted_records').select('*').eq('workspace_id', workspace.id).order('id').range(offset, offset + 499));
    rows.push(...batch);
    if (batch.length < 500) return rows;
  }
}
export async function createEncryptedWorkspace(client, name, key) {
  const id = crypto.randomUUID(), epoch = crypto.randomUUID();
  const encryptedName = await encrypt(key, { kind: 'workspace', name }, context(id, epoch));
  checked(await client.rpc('create_workspace', { space_id: id, initial_epoch: epoch, space_name: encryptedName }));
  return { id, key_epoch: epoch };
}
export async function writeEncryptedRecord(client, workspace, key, userId, kind, previous, values) {
  const id = previous?.id || crypto.randomUUID();
  const content = contentOf(kind, { ...previous, ...values });
  const ciphertext = await encrypt(key, content, context(workspace.id, workspace.key_epoch, id));
  const query = previous
    ? client.from('encrypted_records').update({ ciphertext }).eq('workspace_id', workspace.id).eq('id', id).eq('key_epoch', workspace.key_epoch).eq('updated_at', previous.updated_at)
    : client.from('encrypted_records').insert({ id, workspace_id: workspace.id, key_epoch: workspace.key_epoch, created_by: userId, ciphertext });
  const response = await query.select('id').maybeSingle();
  checked(response);
  if (!response.data) throw new Error('This item changed on another device. Refresh before editing it again.');
}
export async function rotateEncryptedWorkspace(client, workspace, oldKey, newKey, removeUser = null) {
  const oldRows = await loadEncryptedRecords(client, workspace);
  const epoch = crypto.randomUUID();
  const name = await unlockName(workspace, oldKey);
  const encryptedName = await encrypt(newKey, { kind: 'workspace', name }, context(workspace.id, epoch));
  const replacements = await Promise.all(oldRows.map(async row => {
    const content = await decodeRecord(workspace, row, oldKey);
    return { id: row.id, expected_updated_at: row.updated_at, ciphertext: await encrypt(newKey, contentOf(content.kind, content), context(workspace.id, epoch, row.id)) };
  }));
  checked(await client.rpc('rotate_workspace_key', { target_workspace: workspace.id, expected_epoch: workspace.key_epoch, next_epoch: epoch, space_name: encryptedName, replacements, removed_user: removeUser }));
  return { ...workspace, key_epoch: epoch, encrypted_name: encryptedName, name };
}
