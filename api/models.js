/**
 * GET /api/models?provider=venice|openrouter|cerebras|groq|nvidia
 * Optional header: X-Provider-Key (BYOK for listing)
 *
 * Each provider returns THAT provider’s full catalog from its own API.
 * NVIDIA uses NVCF account functions when a key is present (not a guessed list).
 */

import {
  PROVIDERS,
  FALLBACK_MODELS,
  resolveProvider,
} from '../lib/providers.js';
import { resolveNvidiaModels, filterNvidiaChatModels } from '../lib/nvidia-models.js';
import { enrichModels } from '../lib/model-meta.js';
import { handleUnlockPaid, isUnlockPaidRequest } from '../lib/unlock-paid-handler.js';

/** Exact Venice models the app exposes — nothing else. */
const VENICE_ONLY = FALLBACK_MODELS.venice || [];
const VENICE_ONLY_IDS = new Set(VENICE_ONLY.map((m) => m.id));

function normalizeVenice(data) {
  const list = Array.isArray(data?.data) ? data.data : [];
  const liveById = new Map();
  for (const m of list) {
    if (!m?.id || m?.type !== 'text' || m?.model_spec?.offline === true) continue;
    if (!VENICE_ONLY_IDS.has(m.id)) continue;
    const spec = m.model_spec || {};
    liveById.set(m.id, {
      id: m.id,
      name: spec.name || m.id,
      description: spec.description || '',
      contextTokens: spec.availableContextTokens || null,
      uncensored: true,
    });
  }

  // Preserve the user’s order; keep curated names even if catalog labels differ.
  return enrichModels(
    'venice',
    VENICE_ONLY.map((curated) => {
      const live = liveById.get(curated.id);
      return {
        id: curated.id,
        name: curated.name,
        description: live?.description || curated.description || '',
        contextTokens: live?.contextTokens ?? null,
        uncensored: true,
      };
    }),
  );
}

function normalizeOpenAIStyle(data, providerId = 'openrouter') {
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return enrichModels(
    providerId,
    list
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        description: m.description || '',
        contextTokens: m.context_length || m.context_window || m.limits?.max_context_length || null,
        uncensored: /uncensored|dolphin|hermes|heretic|abliterated/i.test(m.id || ''),
        free: /:free$/i.test(m.id || '') || m.pricing?.prompt === '0' || m.pricing?.prompt === 0,
        pricing: m.pricing,
      }))
      .filter((m) => m.id),
  );
}

/** Groq models list includes whisper / TTS — keep text chat systems. */
function filterGroqChat(models) {
  return models.filter((m) => {
    const id = m.id || '';
    if (/whisper|tts|orpheus|prompt-guard|safeguard/i.test(id)) return false;
    return true;
  });
}

function sortOpenRouter(models) {
  return models.slice().sort((a, b) => {
    if (!!a.free !== !!b.free) return a.free ? -1 : 1;
    if (!!a.uncensored !== !!b.uncensored) return a.uncensored ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

async function fetchCatalog(url, { apiKey, extraHeaders } = {}) {
  const headers = {
    Accept: 'application/json',
    ...(extraHeaders || {}),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const upstream = await fetch(url, { headers });
  const rawText = await upstream.text();
  let data;
  try { data = JSON.parse(rawText); } catch { data = { error: rawText }; }
  return { ok: upstream.ok, status: upstream.status, data };
}

export default async function handler(req, res) {
  // /api/unlock-paid is rewritten here so Hobby stays under the 12-function cap.
  if (isUnlockPaidRequest(req)) {
    return handleUnlockPaid(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key, X-Paid-Password');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const providerId = (req.query?.provider || 'venice').toString();
  if (!PROVIDERS[providerId]) {
    return res.status(400).json({
      error: `Unknown provider: ${providerId}`,
      providers: Object.keys(PROVIDERS),
    });
  }

  const clientKey = req.headers['x-provider-key'];
  const { provider, apiKey, keySource } = resolveProvider(providerId, clientKey, { requireKey: false });
  const curated = enrichModels(providerId, FALLBACK_MODELS[providerId] || []);

  // NVIDIA: NVCF-authorized ∩ integrate.api chat IDs — never invent endpoints/IDs.
  if (providerId === 'nvidia') {
    try {
      const resolved = await resolveNvidiaModels({ apiKey: apiKey || undefined });
      const models = enrichModels(
        'nvidia',
        resolved.models.length ? resolved.models : filterNvidiaChatModels(curated),
      );
      res.setHeader(
        'Cache-Control',
        keySource === 'client' || String(resolved.source || '').startsWith('nvcf')
          ? 'no-store'
          : 's-maxage=300, stale-while-revalidate=600',
      );
      return res.status(200).json({
        provider: provider.label,
        models,
        source: resolved.models.length ? resolved.source : 'fallback',
        keySource,
        chatUrl: resolved.chatUrl || provider.url,
        note: resolved.note,
        warning: resolved.warning,
      });
    } catch (err) {
      return res.status(200).json({
        provider: provider.label,
        models: enrichModels('nvidia', filterNvidiaChatModels(curated)),
        source: 'fallback',
        keySource,
        chatUrl: provider.url,
        warning: err.message || 'NVIDIA catalog failed',
      });
    }
  }

  const catalogUrl = provider.modelsUrl || provider.publicModelsUrl || null;

  if (!catalogUrl) {
    return res.status(200).json({
      provider: provider.label,
      models: curated,
      source: 'fallback',
      keySource,
      note: apiKey
        ? undefined
        : `Add ${provider.apiKeyEnv} or paste your key (BYOK) for the live ${provider.label} list.`,
    });
  }

  try {
    const { ok, status, data } = await fetchCatalog(catalogUrl, {
      apiKey: apiKey || undefined,
      extraHeaders: provider.extraHeaders(),
    });

    if (!ok) {
      if (apiKey && provider.publicModelsUrl) {
        const pub = await fetchCatalog(provider.publicModelsUrl, {
          extraHeaders: provider.extraHeaders(),
        });
        if (pub.ok) {
          let models = normalizeOpenAIStyle(pub.data, providerId);
          models = models.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
          return res.status(200).json({
            provider: provider.label,
            models: models.length ? models : curated,
            source: 'public',
            keySource,
          });
        }
      }
      return res.status(200).json({
        provider: provider.label,
        models: curated,
        source: 'fallback',
        keySource,
        warning: data?.error?.message || data?.error || data?.detail || `Upstream HTTP ${status}`,
      });
    }

    let models;
    if (providerId === 'venice') {
      models = normalizeVenice(data);
    } else if (providerId === 'openrouter') {
      models = sortOpenRouter(normalizeOpenAIStyle(data, 'openrouter'));
    } else if (providerId === 'groq') {
      models = filterGroqChat(normalizeOpenAIStyle(data, 'groq'))
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    } else {
      models = normalizeOpenAIStyle(data, providerId)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    }

    res.setHeader('Cache-Control', keySource === 'client' ? 'no-store' : 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      provider: provider.label,
      models: models.length ? models : curated,
      source: apiKey ? 'live' : 'public',
      keySource,
    });
  } catch (err) {
    return res.status(200).json({
      provider: provider.label,
      models: curated,
      source: 'fallback',
      keySource,
      warning: err.message || 'catalog fetch failed',
    });
  }
}
