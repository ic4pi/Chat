/**
 * Per-person prepaid billing for the self-hosted Modal Wan video generator.
 *
 * Not a general auth system — this is for a small, known group of people
 * (friends/team), each holding a manually-issued access key. No signup, no
 * passwords, no Stripe. The owner tops people up by hand via ?op=credit.
 *
 * Config (Vercel env var VIDEO_ACCESS_KEYS, JSON array):
 *   [
 *     { "key": "owner-<random>",  "name": "me",   "markupPct": 0  },
 *     { "key": "alex-<random>",   "name": "Alex", "markupPct": 20 },
 *     { "key": "sam-<random>",    "name": "Sam",  "markupPct": 50 }
 *   ]
 * markupPct can be any non-negative number (0 = at cost, 100 = 2x, etc).
 *
 * If VIDEO_ACCESS_KEYS is unset, billing is disabled entirely and Modal video
 * generation stays open/unmetered (today's behavior for the site's owner).
 *
 * Balances are prepaid USD, stored as integer cents in Vercel KV (lib/kv.js)
 * so there's no float drift. No locking: two simultaneous requests from the
 * same key can race on the read-modify-write. Fine for a handful of friends;
 * not fine at real scale.
 */

import { kvGet, kvSet, KV_ENABLED } from './kv.js';

const BALANCE_PREFIX = 'vb:balance:'; // cents, integer
const USAGE_PREFIX = 'vb:usage:'; // capped JSON array of recent generations

// Modal's published on-demand L4 rate. This is an estimate used only to split
// cost between people fairly with markup - it is NOT pulled live from Modal
// billing. Check https://modal.com/pricing and override MODAL_L4_RATE_PER_HOUR
// in Vercel if their rate changes.
const DEFAULT_L4_RATE_PER_HOUR = 0.80;

function ratePerSecond() {
  const perHour = Number(process.env.MODAL_L4_RATE_PER_HOUR) || DEFAULT_L4_RATE_PER_HOUR;
  return perHour / 3600;
}

export function billingEnabled() {
  return !!process.env.VIDEO_ACCESS_KEYS;
}

export function getAccessKeys() {
  const raw = process.env.VIDEO_ACCESS_KEYS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.key === 'string' && p.key.trim())
      .map((p) => ({
        key: p.key.trim(),
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : p.key.trim(),
        markupPct: Number.isFinite(Number(p.markupPct)) ? Number(p.markupPct) : 0,
      }));
  } catch {
    return [];
  }
}

export function findPerson(accessKey) {
  if (!accessKey) return null;
  return getAccessKeys().find((p) => p.key === accessKey) || null;
}

export async function getBalanceCents(key) {
  if (!KV_ENABLED) return 0;
  const v = await kvGet(BALANCE_PREFIX + key);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function setBalanceCents(key, cents) {
  if (!KV_ENABLED) throw new Error('KV is not configured - cannot store balances');
  await kvSet(BALANCE_PREFIX + key, Math.round(cents));
}

/** Admin top-up. usd may be negative to correct a mistake. */
export async function addCreditUsd(key, usd) {
  const current = await getBalanceCents(key);
  const next = current + Math.round(Number(usd) * 100);
  await setBalanceCents(key, next);
  return next / 100;
}

async function logUsage(key, entry) {
  if (!KV_ENABLED) return;
  let list = [];
  try {
    const raw = await kvGet(USAGE_PREFIX + key);
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string') list = JSON.parse(raw);
  } catch {
    list = [];
  }
  list.unshift({ ...entry, at: new Date().toISOString() });
  if (list.length > 30) list = list.slice(0, 30);
  await kvSet(USAGE_PREFIX + key, list);
}

/**
 * Call BEFORE hitting Modal. Rejects if the person has no credit at all -
 * cost isn't known until after generation, so this only blocks the obvious
 * "already empty" case, not exact overspend.
 */
export async function assertHasCredit(person) {
  const cents = await getBalanceCents(person.key);
  if (cents <= 0) {
    const err = new Error(
      `Out of credit (balance $${(cents / 100).toFixed(2)}). Ask the admin to top up your access key.`
    );
    err.status = 402;
    throw err;
  }
  return cents;
}

/**
 * Call AFTER a successful Modal generation. Computes real cost from GPU
 * elapsed seconds, applies the person's markup, deducts it, and logs it.
 */
export async function chargeForGeneration(person, { elapsedSeconds, prompt }) {
  const actualCostUsd = (Number(elapsedSeconds) || 0) * ratePerSecond();
  const chargedUsd = actualCostUsd * (1 + (person.markupPct || 0) / 100);
  const chargedCents = Math.round(chargedUsd * 100);

  const before = await getBalanceCents(person.key);
  const after = before - chargedCents;
  await setBalanceCents(person.key, after);
  await logUsage(person.key, {
    prompt: String(prompt || '').slice(0, 200),
    elapsedSeconds,
    actualCostUsd: Number(actualCostUsd.toFixed(4)),
    chargedUsd: Number(chargedUsd.toFixed(4)),
    balanceAfterUsd: Number((after / 100).toFixed(2)),
  });

  return {
    actualCostUsd: Number(actualCostUsd.toFixed(4)),
    chargedUsd: Number(chargedUsd.toFixed(4)),
    balanceUsd: Number((after / 100).toFixed(2)),
  };
}

export async function listAllBalances() {
  const people = getAccessKeys();
  const out = [];
  for (const p of people) {
    const cents = await getBalanceCents(p.key);
    out.push({ name: p.name, key: p.key, markupPct: p.markupPct, balanceUsd: Number((cents / 100).toFixed(2)) });
  }
  return out;
}
