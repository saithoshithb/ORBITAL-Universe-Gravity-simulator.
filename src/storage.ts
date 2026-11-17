// Saved setups in IndexedDB: one object store keyed by save name. Local to this browser profile.
import type { Save } from './sim';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('orbital', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('saves', { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('saves', mode);
      const req = op(tx.objectStore('saves'));
      // resolve on transaction completion, not request success, so a write is durable before we report it
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
    });
  } finally {
    db.close();
  }
}

export const listSaves = () => run('readonly', (s) => s.getAllKeys() as IDBRequest<string[]>);
export const getSave = (name: string) => run('readonly', (s) => s.get(name) as IDBRequest<Save | undefined>);
export const putSave = (save: Save) => run('readwrite', (s) => s.put(save));
export const deleteSave = (name: string) => run('readwrite', (s) => s.delete(name));
