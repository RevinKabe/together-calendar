// Content encryption uses the browser's native Web Crypto implementation.
// Recovery keys are random 256-bit secrets, independent from login passwords.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function unbase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid encrypted data.');
  const bytes = Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (base64(bytes) !== text) throw new Error('Invalid encrypted data.');
  return bytes;
}
export function generateRecoveryKey() { return 'together1_' + base64(crypto.getRandomValues(new Uint8Array(32))); }
export async function importRecoveryKey(text) {
  const clean = text.trim();
  if (!/^together1_[A-Za-z0-9_-]{43}$/.test(clean)) throw new Error('Use the full recovery key saved in your password manager.');
  const bytes = unbase64(clean.slice(10));
  if (bytes.length !== 32) throw new Error('Invalid recovery key.');
  try { return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  finally { bytes.fill(0); }
}
export function context(workspaceId, epoch, recordId = 'name') {
  if (!uuid.test(workspaceId) || !uuid.test(epoch) || (recordId !== 'name' && !uuid.test(recordId))) throw new Error('Invalid encryption context.');
  return encoder.encode(JSON.stringify(['together', 1, workspaceId, epoch, recordId]));
}
export function validEnvelope(envelope) {
  return envelope && Object.keys(envelope).sort().join(',') === 'ct,iv,v' && envelope.v === 1 &&
    typeof envelope.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(envelope.iv) &&
    typeof envelope.ct === 'string' && /^[A-Za-z0-9_-]{22,16000}$/.test(envelope.ct);
}
export async function encrypt(key, value, aad) {
  const encoded = encoder.encode(JSON.stringify(value));
  if (encoded.length > 10000) throw new Error('This item is too large to encrypt.');
  // Fixed-size blocks conceal exact text lengths; total block count remains metadata.
  const padded = crypto.getRandomValues(new Uint8Array(Math.ceil((encoded.length + 4) / 512) * 512));
  new DataView(padded.buffer).setUint32(0, encoded.length);
  padded.set(encoded, 4);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, padded);
    return { v: 1, iv: base64(iv), ct: base64(new Uint8Array(ciphertext)) };
  } finally { encoded.fill(0); padded.fill(0); }
}
export async function decrypt(key, envelope, aad) {
  if (!validEnvelope(envelope)) throw new Error('Unsupported or damaged encrypted data.');
  let bytes;
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(envelope.iv), additionalData: aad, tagLength: 128 }, key, unbase64(envelope.ct)));
    if (bytes.length < 512 || bytes.length % 512 !== 0) throw new Error('Invalid padding');
    const size = new DataView(bytes.buffer).getUint32(0);
    if (size > bytes.length - 4 || size > 10000) throw new Error('Invalid length');
    return JSON.parse(decoder.decode(bytes.subarray(4, size + 4)));
  } catch { throw new Error('Cannot unlock this data. Check the key; the data may have changed or been damaged.'); }
  finally { bytes?.fill(0); }
}
export function contentOf(kind, item) {
  const common = { kind, title: String(item.title || '').trim(), notes: String(item.notes || ''), category: item.category || 'sage' };
  if (!['event', 'task'].includes(kind) || !common.title || common.title.length > 160 || common.notes.length > 2000 || !['sage', 'lavender', 'peach'].includes(common.category)) throw new Error('Invalid calendar item.');
  const validDate = value => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)));
  if (kind === 'event') {
    if (!item.event_date || !validDate(item.event_date) || (item.start_time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(item.start_time))) throw new Error('Invalid event date or time.');
    return { ...common, event_date: item.event_date, start_time: item.start_time || null };
  }
  if (!validDate(item.due_date ?? null) || String(item.assigned_to || '').length > 80) throw new Error('Invalid task details.');
  return { ...common, due_date: item.due_date || null, assigned_to: String(item.assigned_to || ''), completed: Boolean(item.completed) };
}
