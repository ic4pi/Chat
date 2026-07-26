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
    // Public catalog — no API key required
    publicModelsUrl: 'https://api.cerebras.ai/public/v1/models',
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
    // NVIDIA model list is publicly readable
    publicModelsUrl: 'https://integrate.api.nvidia.com/v1/models',
    apiKeyEnv: 'NVIDIA_API_KEY',
    label: 'NVIDIA',
    extraHeaders: () => ({}),
  },
};

/** Used when live/public catalog fetch fails. */
export const FALLBACK_MODELS = {
  venice: [
    { id: 'venice-uncensored-1-2', name: 'Venice Uncensored 1.2' },
    { id: 'e2ee-venice-uncensored-24b-p', name: 'Venice Uncensored 1.1' },
    { id: 'venice-uncensored-role-play', name: 'Venice Role Play Uncensored' },
    { id: 'olafangensan-glm-4.7-flash-heretic', name: 'GLM 4.7 Flash Heretic' },
    { id: 'gemma-4-uncensored', name: 'Gemma 4 Uncensored' },
    { id: 'e2ee-gemma-4-26b-a4b-uncensored-p', name: 'Gemma 4 26B A4B Uncensored' },
    { id: 'e2ee-qwen3-6-35b-a3b-uncensored-p', name: 'Qwen3.6 35B A3B Uncensored' },
    { id: 'venice-uncensored', name: 'Dolphin Mistral 24B Venice Edition' },
  ],
  openrouter: [
    { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', name: 'Dolphin-Venice 24B (free)' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Hermes 3 405B (free)' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)' },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)' },
  ],
  cerebras: [
    { id: 'gpt-oss-120b', name: 'OpenAI GPT OSS 120B' },
    { id: 'zai-glm-4.7', name: 'Z.ai GLM 4.7' },
    { id: 'gemma-4-31b', name: 'Gemma 4 31B' },
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    { id: 'qwen-3-32b', name: 'Qwen 3 32B' },
    { id: 'llama3.1-8b', name: 'Llama 3.1 8B' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
    { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
    { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B' },
    { id: 'qwen/qwen3.6-27b', name: 'Qwen3.6 27B' },
    { id: 'qwen/qwen3-32b', name: 'Qwen3 32B' },
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B' },
    { id: 'groq/compound', name: 'Groq Compound' },
    { id: 'groq/compound-mini', name: 'Groq Compound Mini' },
    { id: 'minimaxai/minimax-m2.7', name: 'MiniMax M2.7' },
  ],
  nvidia: [
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'meta/llama-3.1-405b-instruct', name: 'Llama 3.1 405B Instruct' },
    { id: 'meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct' },
    { id: 'meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct' },
    { id: 'meta/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B' },
    { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B' },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B Instruct' },
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B' },
    { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2' },
    { id: 'mistralai/mixtral-8x22b-instruct', name: 'Mixtral 8x22B' },
  ],
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const DEFAULT_MODELS = {
  venice: 'venice-uncensored-1-2',
  openrouter: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
  cerebras: 'gpt-oss-120b',
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
