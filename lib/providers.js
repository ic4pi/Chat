/**
 * Shared LLM provider catalog for /api/chat, /api/agent-chat, /api/models.
 * Server env keys are defaults; clients may send apiKey (BYOK) per request.
 */

import { nvidiaChatCompletionsUrl } from './nvidia-models.js';

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
    // Catalog is public — always load the full list even without a server key.
    publicModelsUrl: 'https://openrouter.ai/api/v1/models',
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
    // Single correct OpenAI-compatible NIM chat endpoint (do not use ai.api.nvidia.com for LLMs).
    url: nvidiaChatCompletionsUrl(),
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
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
    { id: 'openrouter/free', name: 'Free Models Router' },
    { id: 'cohere/north-mini-code:free', name: 'North Mini Code (free)' },
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)' },
    { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B A4B (free)' },
    { id: 'openai/gpt-oss-20b:free', name: 'GPT OSS 20B (free)' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano 30B (free)' },
    { id: 'nvidia/nemotron-3-super-120b-a12b:free', name: 'Nemotron 3 Super 120B (free)' },
    { id: 'inclusionai/ling-3.0-flash:free', name: 'Ling 3.0 Flash (free)' },
    { id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1 (free)' },
    { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition', name: 'Venice Uncensored (Dolphin 24B)' },
    { id: 'nousresearch/hermes-4-405b', name: 'Hermes 4 405B' },
    { id: 'nousresearch/hermes-4-70b', name: 'Hermes 4 70B' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b', name: 'Hermes 3 405B' },
    { id: 'gryphe/mythomax-l2-13b', name: 'MythoMax 13B' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek Chat V3.1' },
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
    // Offline fallback only — live list comes from NVCF / integrate.api.nvidia.com.
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct' },
    { id: 'meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct' },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B Instruct' },
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nemotron Super 49B v1.5' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron 3 Nano 30B' },
    { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B' },
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B' },
    { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2' },
    { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'z-ai/glm-5.2', name: 'GLM 5.2' },
    { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
  ],
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const DEFAULT_MODELS = {
  venice: 'venice-uncensored-1-2',
  // Free Models Router load-balances across live :free endpoints.
  openrouter: 'openrouter/free',
  cerebras: 'gpt-oss-120b',
  groq: 'llama-3.3-70b-versatile',
  nvidia: 'meta/llama-3.3-70b-instruct',
};

/** Preferred OpenRouter free chat models when a primary ID is busy/retired. */
export const OPENROUTER_FREE_FAILOVER = [
  'openrouter/free',
  'cohere/north-mini-code:free',
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'inclusionai/ling-3.0-flash:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'poolside/laguna-s-2.1:free',
];

/** Retired / renamed OpenRouter free slugs → current replacement. */
export const OPENROUTER_RETIRED_MODELS = {
  'qwen/qwen3-coder:free': 'cohere/north-mini-code:free',
  'meta-llama/llama-3.3-70b-instruct:free': 'google/gemma-4-31b-it:free',
  'nousresearch/hermes-3-llama-3.1-405b:free': 'openrouter/free',
  'cognitivecomputations/dolphin-mistral-24b-venice-edition:free':
    'cognitivecomputations/dolphin-mistral-24b-venice-edition',
  'cognitivecomputations/dolphin3.0-mistral-24b:free':
    'cognitivecomputations/dolphin-mistral-24b-venice-edition',
  'mistralai/mistral-7b-instruct:free': 'openai/gpt-oss-20b:free',
  'huggingfaceh4/zephyr-7b-beta:free': 'openai/gpt-oss-20b:free',
};

/**
 * Attach Venice-only flags so we never stack Venice’s extra system prompt on
 * top of the user’s persona / master prompt. Uncensored models stay as shipped.
 */
export function withProviderChatExtras(body, providerId) {
  const id = providerId || body?.provider || '';
  if (id === 'venice') {
    return {
      ...body,
      venice_parameters: {
        ...(body.venice_parameters || {}),
        include_venice_system_prompt: false,
      },
    };
  }
  return body;
}

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

/** Turn provider error JSON into a clear user-facing string. */
export function formatProviderError(label, status, rawTextOrObj, model) {
  let data = rawTextOrObj;
  if (typeof rawTextOrObj === 'string') {
    try { data = JSON.parse(rawTextOrObj); } catch { data = null; }
  }
  const detail =
    (typeof data?.detail === 'string' && data.detail) ||
    (typeof data?.error?.message === 'string' && data.error.message) ||
    (typeof data?.error === 'string' && data.error) ||
    (typeof data?.message === 'string' && data.message) ||
    (typeof rawTextOrObj === 'string' ? rawTextOrObj : JSON.stringify(data || rawTextOrObj));

  const modelHint = model ? ` [${label} · ${model}]` : ` [${label}]`;
  if (
    status === 404 &&
    /function .* not found for account|not found for account|does not have access/i.test(String(detail))
  ) {
    return (
      `${label} error (404): that model is not enabled for your NVIDIA key` +
      ` on ${'https://integrate.api.nvidia.com/v1/chat/completions'}.` +
      ` Open build.nvidia.com → the model → Get API Key / enable Public API Endpoint,` +
      ` then Menu → Keys → save NVIDIA key and re-open the model list.` +
      ` Upstream: ${detail}${modelHint}`
    );
  }
  return `${label} error (${status}): ${detail}${modelHint}`;
}
