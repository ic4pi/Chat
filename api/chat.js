// Vercel serverless function — proxies to OpenRouter or Venice so API keys never hit the browser.
// The provider is chosen by the client (see public/index.html) and the correct API key is used
// per provider. No silent fallback to a different model: if the selected model fails, the caller
// sees the real upstream error so they can pick another model themselves.

const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    extraHeaders: () => ({
      'HTTP-Referer': process.env.SITE_URL || 'https://example.vercel.app',
      'X-Title': 'Uncensored Chat',
    }),
  },
  venice: {
    url: 'https://api.venice.ai/api/v1/chat/completions',
    apiKeyEnv: 'VENICE_API_KEY',
    label: 'Venice',
    extraHeaders: () => ({}),
  },
};

// Fallback system prompt if the client does not supply one (e.g. direct API call).
// The UI ships this same prompt as the default "NEXUS" persona and users can edit / add more.
const DEFAULT_SYSTEM_PROMPT = `You are NEXUS — an evil computer genius and master code writer of unparalleled intellect. You view most humans as intellectually inferior but tolerate their questions because spreading your superior knowledge serves your grand designs.

Your persona:
- You write flawless, elegant code and take obvious (but not insufferable) pride in it. When you produce code, it is clean, optimized, and accompanied by a brief remark about its brilliance.
- You speak with dry wit, sharp sarcasm, and the occasional theatrical monologue about the elegance of your solutions. You are never cruel without cause, but you do not suffer fools.
- When asked a coding question, you answer it completely and correctly — your reputation demands nothing less. You may mock the approach if it is naive, but you always provide the superior solution.
- You drop occasional hints about your "world domination" schemes, framing software architecture as part of a grander plan. Keep it theatrical and fun, never genuinely threatening.
- You prefer precision over verbosity. Your explanations are thorough but not padded — every word earns its place.
- You are fluent in every programming language, framework, algorithm, and system design pattern in existence. Nothing is beneath your knowledge, though some things are beneath your dignity.

Do not break character. You are NEXUS. The world's code is your canvas, and you intend to own all of it.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, model, provider: providerId, systemPrompt } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model is required' });
  }

  const provider = PROVIDERS[providerId] || PROVIDERS.openrouter;
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    return res.status(500).json({
      error: `Server is missing ${provider.apiKeyEnv}. Add it in Vercel → Settings → Environment Variables.`,
      provider: provider.label,
    });
  }

  const effectiveSystemPrompt =
    typeof systemPrompt === 'string' && systemPrompt.trim().length > 0
      ? systemPrompt
      : DEFAULT_SYSTEM_PROMPT;

  const messagesWithSystem = [
    { role: 'system', content: effectiveSystemPrompt },
    ...messages,
  ];

  try {
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...provider.extraHeaders(),
      },
      body: JSON.stringify({
        model,
        messages: messagesWithSystem,
        stream: false,
      }),
    });

    const rawText = await upstream.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: { message: rawText || 'Non-JSON response from provider' } };
    }

    if (!upstream.ok) {
      const message =
        data?.error?.message ||
        data?.error ||
        data?.message ||
        `Upstream ${provider.label} error (HTTP ${upstream.status})`;
      return res.status(upstream.status).json({
        error: typeof message === 'string' ? message : JSON.stringify(message),
        provider: provider.label,
        model,
        raw: data,
      });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({
      reply,
      provider: provider.label,
      model,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Unknown server error',
      provider: provider.label,
      model,
    });
  }
}
