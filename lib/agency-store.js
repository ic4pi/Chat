// Storage adapters for the agency modules. Everything in lib/client.js and
// friends talks to this tiny interface, so tests run on the in-memory store and
// production runs on the same Vercel KV the rest of the app already uses.
//
//   get(key) -> object | null
//   set(key, object)
//   acquire(name, ttlSec, now?) -> boolean   (true = this caller holds the slot)
//
// acquire() is a time-bucketed lock built on an atomic counter: the first
// caller to increment a bucket's counter wins, and the bucket ages out on its
// own. There is deliberately no release — a crashed run can never wedge a
// client, it just waits for the next bucket.

import { kvGet, kvSet, kvIncr, kvExpire, KV_ENABLED } from './kv.js';

function parse(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createKvStore(prefix = 'uncensored-chat:agency') {
  return {
    enabled: KV_ENABLED,
    async get(key) {
      return parse(await kvGet(`${prefix}:${key}`));
    },
    async set(key, value) {
      await kvSet(`${prefix}:${key}`, value);
    },
    async acquire(name, ttlSec, now = Date.now()) {
      const bucket = Math.floor(now / (ttlSec * 1000));
      const key = `${prefix}:lock:${name}:${bucket}`;
      const n = await kvIncr(key);
      if (n === 1) {
        await kvExpire(key, ttlSec * 2);
        return true;
      }
      return false;
    },
  };
}

export function createMemoryStore() {
  const data = new Map();
  const locks = new Map();
  return {
    enabled: true,
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : null;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async acquire(name, ttlSec, now = Date.now()) {
      const key = `${name}:${Math.floor(now / (ttlSec * 1000))}`;
      if (locks.has(key)) return false;
      locks.set(key, true);
      return true;
    },
    _data: data,
  };
}
