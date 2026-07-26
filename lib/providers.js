/**
 * Shared LLM provider catalog for /api/chat, /api/agent-chat, /api/models.
 * Server env keys are defaults; clients may send apiKey (BYOK) per request.
 */

export const PROVIDERS = {
  venice: {
    id: 'venice',
    url: 'https://api.venice.ai/api/v1/chat/completions',
    modelsUrl: 'https://api.venice.ai/api/v1/models?type=text',
    apiKeyEnv: 'VENICE_API_KEY',
    label: 'Venice',
    extraHeaders: () => ({}),
  },
  openrouter: {
    id: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    extraHeaders: () => ({
      'HTTP-Referer': process.env.SITE_URL || 'https://example.vercel.app',
      'X-Title': 'Uncensored Chat',
    }),
  },
  cerebras: {
    id: 'cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    modelsUrl: 'https://api.cerebras.ai/v1/models',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    label: 'Cerebras',
    extraHeaders: () => ({}),
  },
  groq: {
    id: 'groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    apiKeyEnv: 'GROQ_API_KEY',
    label: 'Groq',
    extraHeaders: () => ({}),
  },
  nvidia: {
    id: 'nvidia',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
    apiKeyEnv: 'NVIDIA_API_KEY',
    label: 'NVIDIA',
    extraHeaders: () => ({}),
  },
};

/**
 * Short allowlists — the UI only shows these for each provider.
 * Live catalogs often dump every proxied model (100+); we never list those.
 */
export const FALLBACK_MODELS = {
  venice: [
    { id: 'venice-uncensored', name: 'Venice Uncensored (Dolphin 24B)' },
    { id: 'venice-uncensored-1-2', name: 'Venice Uncensored 1.2' },
    { id: 'olafangensan-glm-4.7-flash-heretic', name: 'GLM 4.7 Flash Heretic (200k)' },
    { id: 'hermes-3-llama-3.1-405b', name: 'Hermes 3 Llama 3.1 405B' },
    { id: 'qwen3-235b-a22b-instruct-2507', name: 'Qwen3 235B Instruct' },
    { id: 'qwen3-next-80b', name: 'Qwen3 Next 80B' },
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    { id: 'mistral-31-24b', name: 'Mistral 3.1 24B' },
  ],
  openrouter: [
    { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', name: 'Dolphin-Venice 24B (free)' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Hermes 3 405B (free)' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)' },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)' },
  ],
  cerebras: [
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    { id: 'qwen-3-32b', name: 'Qwen 3 32B' },
    { id: 'llama3.1-8b', name: 'Llama 3.1 8B' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
    { id: 'qwen/qwen3-32b', name: 'Qwen3 32B' },
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct' },
  ],
  nvidia: [
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'meta/llama-3.1-405b-instruct', name: 'Llama 3.1 405B Instruct' },
    { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B' },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B Instruct' },
  ],
};

/** Allowed model ids per provider — anything else is dropped from the UI. */
export const ALLOWED_MODEL_IDS = Object.fromEntries(
  Object.entries(FALLBACK_MODELS).map(([provider, models]) => [
    provider,
    new Set(models.map((m) => m.id)),
  ]),
);

/**
 * Keep only this provider's allowlisted models.
 * Prefer live metadata when an id is present; otherwise use the curated entry.
 */
export function filterToProviderModels(providerId, liveModels) {
  const allowed = FALLBACK_MODELS[providerId] || [];
  if (!allowed.length) return [];
  const liveById = new Map(
    (Array.isArray(liveModels) ? liveModels : [])
      .filter((m) => m && m.id)
      .map((m) => [m.id, m]),
  );
  return allowed.map((curated) => {
    const live = liveById.get(curated.id);
    if (!live) return { ...curated };
    return {
      ...curated,
      name: live.name || curated.name,
      description: live.description || curated.description || '',
      contextTokens: live.contextTokens ?? null,
      uncensored: live.uncensored ?? curated.uncensored,
    };
  });
}

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const DEFAULT_MODELS = {
  venice: 'venice-uncensored',
  openrouter: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
  cerebras: 'llama-3.3-70b',
  groq: 'llama-3.3-70b-versatile',
  nvidia: 'meta/llama-3.3-70b-instruct',
};

/**
 * Resolve provider + API key.
 * Prefer client-supplied apiKey (BYOK); else server env.
 * Throws if neither is available (chat/agent paths).
 */
export function resolveProvider(providerId, clientApiKey, { requireKey = true } = {}) {
  const provider = PROVIDERS[providerId] || PROVIDERS.venice;
  const fromClient = typeof clientApiKey === 'string' ? clientApiKey.trim() : '';
  const fromEnv = process.env[provider.apiKeyEnv] || '';
  const apiKey = fromClient || fromEnv;
  const keySource = fromClient ? 'client' : (fromEnv ? 'env' : 'none');

  if (requireKey && !apiKey) {
    throw new Error(
      `No API key for ${provider.label}. Add ${provider.apiKeyEnv} in Vercel, or paste your own key (BYOK).`,
    );
  }

  return {
    ...provider,
    provider,
    apiKey,
    keySource,
  };
}
