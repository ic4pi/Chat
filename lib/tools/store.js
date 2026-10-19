// Tiny JSON-collection store for the / tools (CRM, outreach, brand kits...).
// KV when connected; process memory otherwise (lost on cold start — tools say so).
import { kvGet, kvSet, KV_ENABLED } from '../kv.js';

const mem = new Map();
export const storeIsDurable = KV_ENABLED;

export async function readCol(name, fallback) {
  if (!KV_ENABLED) return mem.has(name) ? structuredClone(mem.get(name)) : fallback;
  try {
    const raw = await kvGet(`uncensored-chat:tools:${name}`);
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export async function writeCol(name, value) {
  if (!KV_ENABLED) { mem.set(name, structuredClone(value)); return; }
  await kvSet(`uncensored-chat:tools:${name}`, value);
}

export const newId = (prefix = '') => prefix + Math.random().toString(36).slice(2, 8);
