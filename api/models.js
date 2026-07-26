/**
 * GET /api/models?provider=venice|openrouter|cerebras|groq|nvidia
 * Optional header: X-Provider-Key (BYOK for listing)
 *
 * Returns models for THAT provider only:
 *   - Venice: short uncensored/Venice list (their API also dumps proxied GPT/Claude — we drop those)
 *   - OpenRouter / Cerebras / Groq / NVIDIA: live catalog from that provider
 */

import {
  PROVIDERS,
  FALLBACK_MODELS,
  resolveProvider,
} from '../lib/providers.js';

const VENICE_ALLOW = new Set(
  (FALLBACK_MODELS.venice || []).map((m) => m.id),
);

function normalizeVenice(data) {
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .filter((m) => m?.type === 'text' && m?.model_spec?.offline !== true)
    .map((m) => {
      const spec = m.model_spec || {};
      const traits = Array.isArray(spec.traits) ? spec.traits : [];
      return {
        id: m.id,
        name: spec.name || m.id,
        description: spec.description || '',
        contextTokens: spec.availableContextTokens || null,
        uncensored:
          traits.some((t) => /uncensored|most_uncensored|abliterated/i.test(String(t))) ||
          /uncensored|dolphin|hermes|heretic|abliterated|decensored/i.test(m.id),
      };
    });
}

function normalizeOpenAIStyle(data) {
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description || '',
      contextTokens: m.context_length || m.context_window || null,
      uncensored: /uncensored|dolphin|hermes|heretic|abliterated/i.test(m.id || ''),
      free: /:free$/i.test(m.id || '') || m.pricing?.prompt === '0' || m.pricing?.prompt === 0,
    }))
    .filter((m) => m.id);
}

/** Venice’s API lists proxied Claude/GPT/etc — keep Venice-relevant only. */
function filterVenice(live) {
  const fromLive = (live || []).filter(
    (m) =>
      VENICE_ALLOW.has(m.id) ||
      m.uncensored ||
      /^(venice-|olafangensan-|dolphin-|hermes-|qwen3-|llama-3|mistral-)/i.test(m.id),
  );
  // Always include curated entries even if catalog lagged
  const byId = new Map(fromLive.map((m) => [m.id, m]));
  for (const curated of FALLBACK_MODELS.venice || []) {
    if (!byId.has(curated.id)) byId.set(curated.id, { ...curated });
  }
  return [...byId.values()].sort((a, b) => {
    if (!!a.uncensored !== !!b.uncensored) return a.uncensored ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

function sortOpenRouter(models) {
  return models.slice().sort((a, b) => {
    if (!!a.free !== !!b.free) return a.free ? -1 : 1;
    if (!!a.uncensored !== !!b.uncensored) return a.uncensored ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key');
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
  const curated = FALLBACK_MODELS[providerId] || [];

  if (!apiKey) {
    return res.status(200).json({
      provider: provider.label,
      models: curated,
      source: 'fallback',
      keySource,
      note: `Add ${provider.apiKeyEnv} on the server, or paste your own key (BYOK).`,
    });
  }

  try {
    const upstream = await fetch(provider.modelsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...provider.extraHeaders(),
      },
    });

    const rawText = await upstream.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = { error: rawText }; }

    if (!upstream.ok) {
      return res.status(200).json({
        provider: provider.label,
        models: curated,
        source: 'fallback',
        keySource,
        warning: data?.error?.message || data?.error || `Upstream HTTP ${upstream.status}`,
      });
    }

    let models;
    if (providerId === 'venice') {
      models = filterVenice(normalizeVenice(data));
    } else if (providerId === 'openrouter') {
      models = sortOpenRouter(normalizeOpenAIStyle(data));
    } else {
      models = normalizeOpenAIStyle(data).sort((a, b) =>
        (a.name || a.id).localeCompare(b.name || b.id),
      );
    }

    res.setHeader('Cache-Control', keySource === 'client' ? 'no-store' : 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      provider: provider.label,
      models: models.length ? models : curated,
      source: models.length ? 'live' : 'fallback',
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
