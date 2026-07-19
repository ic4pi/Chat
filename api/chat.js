// Vercel serverless function — proxies to Venice / OpenRouter / Cerebras /
// Groq / NVIDIA. Server env keys are used by default; the client may also
// send apiKey (BYOK) which takes precedence for that request.
//
// System-prompt handling: the browser sends a personaId. The server looks up
// that persona's system prompt in KV and prepends the master prompt. An
// explicit client systemPrompt string is IGNORED.

import { loadConfig } from '../lib/config.js';
import { resolveProvider } from '../lib/providers.js';

const FALLBACK_SYSTEM_PROMPT = 'You are a helpful, direct assistant.';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, model, provider: providerId, personaId, apiKey: clientKey } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model is required' });
  }

  let resolved;
  try {
    resolved = resolveProvider(providerId || 'openrouter', clientKey || req.headers['x-provider-key']);
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Provider not configured',
      provider: providerId,
    });
  }

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

  const UPSTREAM_TIMEOUT_MS = 110_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(resolved.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
        ...resolved.extraHeaders(),
      },
      body: JSON.stringify({
        model,
        messages: messagesWithSystem,
        stream: false,
      }),
      signal: controller.signal,
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
        `Upstream ${resolved.label} error (HTTP ${upstream.status})`;
      return res.status(upstream.status).json({
        error: typeof message === 'string' ? message : JSON.stringify(message),
        provider: resolved.label,
        model,
        raw: data,
      });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({
      reply,
      provider: resolved.label,
      model,
      keySource: resolved.keySource,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    return res.status(aborted ? 504 : 500).json({
      error: aborted
        ? `${resolved.label} took too long (>${UPSTREAM_TIMEOUT_MS / 1000}s). Try a faster model or a shorter prompt.`
        : (err.message || 'Unknown server error'),
      provider: resolved.label,
      model,
    });
  } finally {
    clearTimeout(timer);
  }
}
