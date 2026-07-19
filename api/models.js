/**
 * GET /api/models?provider=venice|openrouter|cerebras|groq|nvidia
 * Optional header: X-Provider-Key (BYOK for listing)
 */

import { PROVIDERS, FALLBACK_MODELS, resolveProvider } from '../lib/providers.js';

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
    })
    .sort((a, b) => {
      if (a.uncensored !== b.uncensored) return a.uncensored ? -1 : 1;
      return a.name.localeCompare(b.name);
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
    }))
    .filter((m) => m.id)
    .sort((a, b) => a.name.localeCompare(b.name));
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

  // No key → return static fallback so the UI still lists models
  if (!apiKey) {
    return res.status(200).json({
      provider: provider.label,
      models: FALLBACK_MODELS[providerId] || [],
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
        models: FALLBACK_MODELS[providerId] || [],
        source: 'fallback',
        keySource,
        warning: data?.error?.message || data?.error || `Upstream HTTP ${upstream.status}`,
      });
    }

    const models = providerId === 'venice'
      ? normalizeVenice(data)
      : normalizeOpenAIStyle(data);

    // Ensure GLM heretic is present even if catalog lags
    if (providerId === 'venice' && !models.some((m) => m.id.includes('glm-4.7') && m.id.includes('heretic'))) {
      models.unshift({
        id: 'olafangensan-glm-4.7-flash-heretic',
        name: 'GLM 4.7 Flash Heretic (200k)',
        description: 'Decensored GLM-4.7-Flash',
        uncensored: true,
      });
    }

    res.setHeader('Cache-Control', keySource === 'client' ? 'no-store' : 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      provider: provider.label,
      models: models.length ? models : (FALLBACK_MODELS[providerId] || []),
      source: models.length ? 'live' : 'fallback',
      keySource,
    });
  } catch (err) {
    return res.status(200).json({
      provider: provider.label,
      models: FALLBACK_MODELS[providerId] || [],
      source: 'fallback',
      keySource,
      warning: err.message || 'catalog fetch failed',
    });
  }
}
