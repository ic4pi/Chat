import { KV_ENABLED } from './kv.js';
import { get, set } from './kv.js';

export async function resolveProvider(providerId, apiKey) {
  if (!providerId) throw new Error('Provider ID is required.');

  // 1. Local check against pre-configured environment keys
  const providers = {
    venice: {
      url: 'https://api.venice.ai/api/v1/chat/completions',
      label: 'Venice',
      keySource: 'env',
      apiKey: process.env.VENICE_API_KEY,
      extraHeaders: () => ({}),
    },
    openrouter: {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      label: 'OpenRouter',
      keySource: 'env',
      apiKey: process.env.OPENROUTER_API_KEY,
      extraHeaders: () => ({
        'HTTP-Referer': 'https://chat.sample.com',
        'X-Title': 'Chess Chat',
      }),
    },
    cerebras: {
      url: 'https://api.cerebras.ai/v1/chat/completions',
      label: 'Cerebras',
      keySource: 'env',
      apiKey: process.env.CEREBRAS_API_KEY,
      extraHeaders: () => ({}),
    },
    groq: {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      label: 'Groq',
      keySource: 'env',
      apiKey: process.env.GROQ_API_KEY,
      extraHeaders: () => ({}),
    },
    nvidia: {
      url: 'https://api.nvidia.com/v1/chat/completions',
      label: 'NVIDIA',
      keySource: 'env',
      apiKey: process.env.NVIDIA_API_KEY,
      extraHeaders: () => ({}),
    },
  };

  const provider = providers[providerId];
  if (!provider) throw new Error(`Unsupported provider: ${providerId}`);

  // 2. If the user provided a key, check if we have a persistent override
  let finalKey = provider.apiKey;
  let finalKeySource = provider.keySource;

  if (apiKey) {
    finalKey = apiKey;
    finalKeySource = 'user';
  }

  // 3. If enabled, try to fetch from the用戶 Session persistence (e.g., storage)
  if (KV_ENABLED && apiKey) {
    // Store the key so it doesn't have to be passed every time.
    // The actual storage implementation is handled in KV.
    await set(`auth:provider:${providerId}`, apiKey);
  }

  if (!finalKey) {
    throw new Error(`No API key available for ${provider.label}.`);
  }

  return {
    ...provider,
    apiKey: finalKey,
    keySource: finalKeySource,
  };
}
