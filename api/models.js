// GET /api/models?provider=venice
// Returns a normalized list of chat-completion-capable models for the requested provider.
// Currently only Venice is fetched live (their catalog changes often and includes multiple
// uncensored fine-tunes). OpenRouter models remain hard-coded in the UI because their free-tier
// slugs change less frequently and don't need a live lookup.

const PROVIDERS = {
  venice: {
    url: 'https://api.venice.ai/api/v1/models?type=text',
    apiKeyEnv: 'VENICE_API_KEY',
    label: 'Venice',
  },
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const providerId = (req.query?.provider || 'venice').toString();
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return res.status(400).json({ error: `Unknown provider: ${providerId}` });
  }

  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    return res.status(500).json({
      error: `Server is missing ${provider.apiKeyEnv}. Add it in Vercel → Settings → Environment Variables.`,
      provider: provider.label,
    });
  }

  try {
    const upstream = await fetch(provider.url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    const rawText = await upstream.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: rawText || 'Non-JSON response from provider' };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data?.error?.message || data?.error || `Upstream ${provider.label} error (HTTP ${upstream.status})`,
        provider: provider.label,
        raw: data,
      });
    }

    const list = Array.isArray(data?.data) ? data.data : [];

    const models = list
      .filter((m) => m?.type === 'text' && m?.model_spec?.offline !== true)
      .map((m) => {
        const spec = m.model_spec || {};
        const traits = Array.isArray(spec.traits) ? spec.traits : [];
        return {
          id: m.id,
          name: spec.name || m.id,
          description: spec.description || '',
          traits,
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

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ provider: provider.label, models });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Unknown server error',
      provider: provider.label,
    });
  }
}
