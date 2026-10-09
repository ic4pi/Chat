// Model health: providers rename and retire models constantly (OpenRouter's
// free list especially), and a hardcoded default that disappears breaks every
// chat still pointed at it. Everything here works from the live catalogs:
//
//   - currentDefaults(): the default chat model and coder model per provider,
//     picked fresh — never a coder for chat, never a hardcoded slug.
//   - fetchWithModelFallback(): one request; if the provider says the model
//     is gone, one retry on the best current replacement, reported back so
//     the app can update the saved choice.
//   - refreshAllCatalogs(): the cron re-check that keeps the cache current.

import { PROVIDERS } from './providers.js';
import { getCatalog } from './model-catalog.js';
import { kvGet, kvSet, KV_ENABLED } from './kv.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const KV_PREFIX = 'model-health:catalog:v1:';
const memo = new Map(); // providerId → { at, models }

// Good general chat models first. Only a tie-breaker: anything not listed still
// qualifies by category, so a new model the list has never heard of is used
// rather than nothing.
const CHAT_PREFERENCE = [
  /venice-uncensored/i, /nemotron-3-super/i, /gemma-4-31b/i, /deepseek[^/]*(?:chat|v3)/i, /llama-3\.3-70b/i,
  /gpt-oss-120b/i, /kimi/i, /glm/i, /mistral-large/i, /nemotron/i, /gemma/i, /llama/i,
];
const CODER_PREFERENCE = [/qwen[^/]*coder/i, /devstral/i, /codestral/i, /deepseek-coder/i, /coder/i, /code/i];

const isCoder = (m) => (m.categories || []).includes('coder');
const isGeneral = (m) => (m.categories || []).includes('general');

/** Only id / free / categories — enough to choose, small enough to cache. */
function slim(models) {
  return (models || []).map((m) => ({ id: m.id, free: !!m.free, categories: m.categories || [] }));
}

/** Free-only on OpenRouter (the site key's free tier); every model elsewhere. */
function usable(providerId, models, { freeOnly } = {}) {
  const wantFree = freeOnly ?? providerId === 'openrouter';
  return wantFree ? models.filter((m) => m.free) : models;
}

/**
 * Best model of a kind from a catalog, or null.
 * 'chat' never returns a coder model; 'coder' prefers a coder and falls back
 * to the chat pick when the provider has none.
 */
export function pickDefault(models, kind, opts = {}) {
  const pool = usable(opts.providerId || 'openrouter', models, opts);
  const candidates = kind === 'coder'
    ? pool.filter(isCoder)
    : pool.filter((m) => !isCoder(m) && isGeneral(m));
  for (const re of kind === 'coder' ? CODER_PREFERENCE : CHAT_PREFERENCE) {
    const hit = candidates.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  if (candidates[0]) return candidates[0].id;
  if (kind === 'coder') return pickDefault(models, 'chat', opts);
  return pool.find((m) => !isCoder(m))?.id || null;
}

async function readCached(providerId) {
  const hit = memo.get(providerId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.models;
  if (KV_ENABLED) {
    try {
      const raw = await kvGet(KV_PREFIX + providerId);
      const stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (stored?.models?.length && Date.now() - stored.at < CACHE_TTL_MS) {
        memo.set(providerId, stored);
        return stored.models;
      }
    } catch { /* fall through to a live fetch */ }
  }
  return null;
}

/** The live catalog for one provider, cached for a few hours. */
export async function liveModels(providerId, { refresh = false } = {}) {
  if (!refresh) {
    const cached = await readCached(providerId);
    if (cached) return cached;
  }
  const catalog = await getCatalog(providerId);
  const models = slim(catalog.models);
  // A fallback list is the curated guess, not the provider's truth — don't
  // cache it, or one outage pins stale names for hours.
  if (catalog.source !== 'fallback' && models.length) {
    const entry = { at: Date.now(), models };
    memo.set(providerId, entry);
    if (KV_ENABLED) await kvSet(KV_PREFIX + providerId, entry).catch(() => {});
  }
  return models;
}

/** { [providerId]: { chat, coder } } from the live catalogs. */
export async function currentDefaults() {
  const out = {};
  await Promise.all(Object.keys(PROVIDERS).map(async (id) => {
    try {
      const models = await liveModels(id);
      out[id] = { chat: pickDefault(models, 'chat', { providerId: id }), coder: pickDefault(models, 'coder', { providerId: id }) };
    } catch {
      out[id] = { chat: null, coder: null };
    }
  }));
  return out;
}

/** The cron: re-fetch every provider's catalog now and report what changed. */
export async function refreshAllCatalogs() {
  const report = {};
  await Promise.all(Object.keys(PROVIDERS).map(async (id) => {
    try {
      const models = await liveModels(id, { refresh: true });
      report[id] = {
        models: models.length,
        chat: pickDefault(models, 'chat', { providerId: id }),
        coder: pickDefault(models, 'coder', { providerId: id }),
      };
    } catch (err) {
      report[id] = { error: err.message };
    }
  }));
  return { refreshedAt: new Date().toISOString(), providers: report };
}

const GONE_RE = /not a valid model|invalid model|unknown model|model_not_found|no endpoints found|unavailable for free|model[^.]{0,60}(?:not found|does not exist|doesn't exist|unavailable|deprecated|retired|discontinued|no longer)/i;

/** True when the provider is saying this model no longer exists (not rate limits, not auth). */
export function isModelGoneError(status, text) {
  return [400, 404, 410, 422].includes(status) && GONE_RE.test(String(text || ''));
}

/**
 * What to use instead of a retired model: the same vendor's current model of
 * the same kind if there is one, else the provider's default for that kind.
 * A free model is only ever replaced with a free one.
 */
export async function replacementFor(providerId, model, kind) {
  const models = await liveModels(providerId, { refresh: true });
  const wasFree = /:free$/i.test(model) || models.find((m) => m.id === model)?.free;
  const opts = { providerId, freeOnly: !!wasFree || providerId === 'openrouter' };
  const k = kind || (/coder|code/i.test(model) ? 'coder' : 'chat');
  const vendor = model.includes('/') ? model.split('/')[0] : '';
  const pool = usable(providerId, models, opts).filter((m) => m.id !== model);
  if (vendor) {
    const same = pool.filter((m) => m.id.startsWith(`${vendor}/`) && (k === 'coder' ? isCoder(m) : !isCoder(m)));
    const pick = pickDefault(same, k, { ...opts, freeOnly: false });
    if (pick) return pick;
  }
  return pickDefault(pool, k, { ...opts, freeOnly: false });
}

/**
 * One upstream request with a single retry on a replacement when the model is
 * gone. `doFetch(modelId)` makes the request; `canUse(modelId)` (optional)
 * keeps the replacement inside the caller's paid gate.
 * Returns { res, model, replaced } — `res` is always readable, `replaced` is
 * { from, to } when the replacement answered.
 */
export async function fetchWithModelFallback({ providerId, model, kind, doFetch, canUse = () => true }) {
  const res = await doFetch(model);
  if (res.ok) return { res, model, replaced: null };
  const text = await res.text();
  const again = () => new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  if (!isModelGoneError(res.status, text)) return { res: again(), model, replaced: null };
  let next = null;
  try { next = await replacementFor(providerId, model, kind); } catch { /* keep the original error */ }
  if (!next || next === model || !canUse(next)) return { res: again(), model, replaced: null };
  console.warn(`model-health: ${providerId}/${model} is gone — retrying on ${next}`);
  const res2 = await doFetch(next);
  return { res: res2, model: next, replaced: res2.ok ? { from: model, to: next } : null };
}
