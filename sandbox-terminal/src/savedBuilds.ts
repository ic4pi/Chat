/**
 * Saved (favorited) builds from Compare — the version you liked, kept so a
 * re-run never loses it and you can load it back to keep developing.
 *
 * IndexedDB, not localStorage: a build is a whole set of files, and
 * localStorage's ~5MB is already shared with every code space session.
 * Lives in this browser only.
 */

export interface SavedBuild {
  id: string;
  title: string;
  provider: string;
  model: string;
  /** What the coder was asked — re-run it later on another model. */
  prompt: string;
  files: Record<string, string>;
  createdAt: number;
}

const DB_NAME = 'workspace-builds';
const STORE = 'builds';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

export async function listBuilds(): Promise<SavedBuild[]> {
  const all = await run<SavedBuild[]>('readonly', (s) => s.getAll() as IDBRequest<SavedBuild[]>);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveBuild(build: Omit<SavedBuild, 'id' | 'createdAt'>): Promise<SavedBuild> {
  const full: SavedBuild = { ...build, id: `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() };
  await run('readwrite', (s) => s.put(full));
  return full;
}

export async function deleteBuild(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
