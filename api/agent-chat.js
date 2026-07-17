/**
 * POST /api/agent-chat
 * Body: { messages, systemPrompt, model?, provider? }
 *
 * Like /api/chat but the client can supply a full systemPrompt (the agent
 * injects the file tree + context into it). The persona/master-prompt system
 * from the KV store is bypassed here — the agent owns its own system prompt.
 */

const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    extraHeaders: () => ({
      'HTTP-Referer': process.env.SITE_URL || 'https://example.vercel.app',
      'X-Title': 'Sandbox Agent',
    }),
  },
  venice: {
    url: 'https://api.venice.ai/api/v1/chat/completions',
    apiKeyEnv: 'VENICE_API_KEY',
    label: 'Venice',
    extraHeaders: () => ({}),
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  res.setHeader('Access-Control-Allow-Origin', '*');

  const { messages, systemPrompt, model, provider: providerId } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const provider = PROVIDERS[providerId] || PROVIDERS.venice;
  const apiKey   = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    return res.status(500).json({
      error: `${provider.apiKeyEnv} not set. Add it in Vercel → Settings → Environment Variables.`,
    });
  }

  const messagesWithSystem = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  // Keep under Vercel maxDuration (120s) so the isolate returns JSON instead
  // of being killed — iOS Safari otherwise reports that as "Load failed".
  const UPSTREAM_TIMEOUT_MS = 110_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...provider.extraHeaders(),
      },
      body: JSON.stringify({
        model: model ?? 'venice-uncensored',
        messages: messagesWithSystem,
        stream: false,
      }),
      signal: controller.signal,
    });

    const rawText = await upstream.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = { error: { message: rawText } }; }

    if (!upstream.ok) {
      const msg = data?.error?.message || `Upstream error HTTP ${upstream.status}`;
      return res.status(upstream.status).json({ error: msg });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({ reply, model, provider: provider.label });
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    return res.status(aborted ? 504 : 500).json({
      error: aborted
        ? `${provider.label} took too long (>${UPSTREAM_TIMEOUT_MS / 1000}s). Try a faster model or a shorter prompt.`
        : (err.message || 'Unknown server error'),
    });
  } finally {
    clearTimeout(timer);
  }
}
