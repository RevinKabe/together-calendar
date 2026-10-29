import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRecoveryKey, importRecoveryKey, context, encrypt, decrypt, contentOf } from '../site/crypto.js';
const space = crypto.randomUUID(), epoch = crypto.randomUUID(), id = crypto.randomUUID();
const aad = context(space, epoch, id);
test('256-bit recovery keys import as non-extractable keys and roundtrip Unicode', async () => {
  const recovery = generateRecoveryKey();
  assert.match(recovery, /^together1_[A-Za-z0-9_-]{43}$/);
  const key = await importRecoveryKey(recovery);
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
  const value = { title: 'Private dinner 🍽️', notes: 'Only our people: äöü', event_date: '2026-10-29' };
  const sealed = await encrypt(key, value, aad);
  assert.ok(!JSON.stringify(sealed).includes(value.title));
  assert.deepEqual(await decrypt(key, sealed, aad), value);
  assert.deepEqual(await decrypt(await importRecoveryKey(recovery), sealed, aad), value);
});
test('wrong key, record, space, epoch, nonce and tampered ciphertext fail closed', async () => {
  const key = await importRecoveryKey(generateRecoveryKey()), sealed = await encrypt(key, { title: 'Private' }, aad);
  await assert.rejects(decrypt(await importRecoveryKey(generateRecoveryKey()), sealed, aad));
  for (const bad of [context(space, epoch, crypto.randomUUID()), context(crypto.randomUUID(), epoch, id), context(space, crypto.randomUUID(), id), context(space, epoch)]) await assert.rejects(decrypt(key, sealed, bad));
  await assert.rejects(decrypt(key, { ...sealed, ct: (sealed.ct[0] === 'A' ? 'B' : 'A') + sealed.ct.slice(1) }, aad));
  await assert.rejects(decrypt(key, { ...sealed, iv: (sealed.iv[0] === 'A' ? 'B' : 'A') + sealed.iv.slice(1) }, aad));
  await assert.rejects(decrypt(key, { ...sealed, v: 2 }, aad));
  await assert.rejects(decrypt(key, { ...sealed, title: 'plaintext' }, aad));
});
test('random IVs produce distinct ciphertext and padding conceals exact small lengths', async () => {
  const key = await importRecoveryKey(generateRecoveryKey());
  const first = await encrypt(key, { title: 'short' }, aad), second = await encrypt(key, { title: 'short' }, aad), third = await encrypt(key, { title: 'a slightly longer title' }, aad);
  assert.notEqual(first.iv, second.iv); assert.notEqual(first.ct, second.ct); assert.equal(first.ct.length, third.ct.length);
});
test('malformed recovery keys and invalid item content are rejected', async () => {
  for (const invalid of ['', 'password', 'together1_' + 'a'.repeat(42), 'together1_' + '!'.repeat(43)]) await assert.rejects(importRecoveryKey(invalid));
  assert.throws(() => contentOf('task', { title: ' ' }));
  assert.throws(() => contentOf('event', { title: 'Valid', event_date: 'invalid' }));
  assert.throws(() => contentOf('event', { title: 'Valid', event_date: '2026-10-29', start_time: '28:00' }));
  assert.throws(() => context(space, 'bad', id));
});
