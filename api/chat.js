// Vercel serverless function — proxies to OpenRouter or Venice so API keys
// never hit the browser. The provider is chosen by the client and the correct
// key is used per provider. No silent fallback to a different model: if the
// selected model fails, the caller sees the real upstream error.
//
// System-prompt handling: the browser sends a personaId (a short string like
// 'nexus' or a uid). The server looks up that persona's system prompt in KV
// and prepends the (also KV-stored) master prompt to it, so the actual
// contents of neither prompt are ever sent to or accessible by the client.
// If a client passes an explicit systemPrompt string, it is IGNORED — the
// server is the source of truth for what the model sees.

import { loadConfig } from '../lib/config.js';

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

// Absolute last-resort system prompt, used only if KV is unreachable AND the
// client somehow supplies no personaId. Everything else takes precedence.
const FALLBACK_SYSTEM_PROMPT = 'You are a helpful, direct assistant.';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, model, provider: providerId, personaId } = req.body || {};

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

  // Resolve the effective system prompt server-side, from KV. Client never
  // participates in this decision — only sends the ID it wants.
  let effectiveSystemPrompt = FALLBACK_SYSTEM_PROMPT;
  try {
    const config = await loadConfig();
    const persona =
      config.personas.find((p) => p.id === personaId) ||
      config.personas.find((p) => p.id === 'nexus') ||
      config.personas[0];
    const parts = [config.masterPrompt, persona?.systemPrompt].filter((s) => typeof s === 'string' && s.trim().length > 0);
    if (parts.length > 0) effectiveSystemPrompt = parts.join('\n\n');
  } catch (err) {
    console.error('loadConfig failed:', err);
  }

  const messagesWithSystem = [
    { role: 'system', content: effectiveSystemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
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
