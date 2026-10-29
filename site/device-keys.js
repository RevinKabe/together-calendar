// Opt-in browser storage only. Never persist the recovery-key string or plaintext.
// Non-extractable keys can still be used by same-origin code; this is not a hardware vault.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isDeviceKey(key) {
  return typeof CryptoKey !== 'undefined' && key instanceof CryptoKey && key.type === 'secret' &&
    key.extractable === false && key.algorithm.name === 'AES-GCM' && key.algorithm.length === 256 &&
    [...key.usages].sort().join(',') === 'decrypt,encrypt';
}
export function createDeviceKeyStore(scope, factory = globalThis.indexedDB) {
  if (typeof scope !== 'string' || !scope) throw new Error('Missing device-key scope.');
  const failure = () => new Error('This browser could not access saved keys. Use your recovery key; check browser storage settings before trying to remember it again.');
  function validate(userId, workspaceId, epoch) {
    if (!uuid.test(userId) || !uuid.test(workspaceId) || (epoch !== undefined && !uuid.test(epoch))) throw new Error('Invalid device-key identity.');
  }
  // Serialize this tab's operations so a later Forget cannot be overtaken by Save.
  let queue = Promise.resolve();
  function transaction(operation) {
    const work = queue.then(() => new Promise((resolve, reject) => {
      let request, db, activeTransaction, finished = false, output = null;
      const finish = (error) => {
        if (finished) return;
        finished = true; clearTimeout(timeout);
        if (error && activeTransaction) { try { activeTransaction.abort(); } catch { /* Already finished. */ } }
        db?.close();
        if (error) reject(failure()); else resolve(output);
      };
      const timeout = setTimeout(() => finish(true), 5000);
      try { request = factory.open('together-device-keys-v1', 1); } catch { finish(true); return; }
      request.onupgradeneeded = () => request.result.createObjectStore('keys', { keyPath: ['scope', 'userId', 'workspaceId'] });
      request.onerror = request.onblocked = () => finish(true);
      request.onsuccess = () => {
        db = request.result;
        if (finished) { db.close(); return; }
        db.onversionchange = () => db.close();
        try {
          const tx = activeTransaction = db.transaction('keys', 'readwrite');
          tx.oncomplete = () => finish(false);
          tx.onerror = tx.onabort = () => finish(true);
          operation(tx.objectStore('keys'), value => { output = value; });
        } catch { finish(true); }
      };
    }));
    queue = work.catch(() => {});
    return work;
  }
  return {
    async save(userId, workspaceId, epoch, key) {
      validate(userId, workspaceId, epoch);
      if (!isDeviceKey(key)) throw new Error('Only a non-extractable calendar key can be remembered.');
      await transaction(store => store.put({ scope, userId, workspaceId, epoch, key, v: 1 }));
    },
    async read(userId, workspaceId, epoch) {
      validate(userId, workspaceId, epoch);
      return transaction((store, result) => {
        const identity = [scope, userId, workspaceId], request = store.get(identity);
        request.onsuccess = () => {
          const row = request.result;
          if (!row) return;
          if (row.v !== 1 || row.epoch !== epoch || !isDeviceKey(row.key)) { store.delete(identity); return; }
          result(row.key);
        };
      });
    },
    async forget(userId, workspaceId, expectedEpoch) {
      validate(userId, workspaceId, expectedEpoch);
      await transaction(store => {
        const identity = [scope, userId, workspaceId], request = store.get(identity);
        request.onsuccess = () => {
          if (request.result && (expectedEpoch === undefined || request.result.epoch === expectedEpoch)) store.delete(identity);
        };
      });
    },
    async forgetAll() {
      await transaction(store => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) return;
          if (cursor.value.scope === scope) cursor.delete();
          cursor.continue();
        };
      });
    },
    async prune(userId, spaces) {
      if (!uuid.test(userId)) throw new Error('Invalid device-key identity.');
      const allowed = new Map(spaces.map(space => [space.id, space.key_epoch]));
      await transaction(store => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) return;
          const row = cursor.value;
          if (row.scope === scope && row.userId === userId && allowed.get(row.workspaceId) !== row.epoch) cursor.delete();
          cursor.continue();
        };
      });
    }
  };
}
