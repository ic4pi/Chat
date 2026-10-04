// Non-streaming model call for the agency modules, built on the app's existing
// provider table. Default is a small, cheap model; override per deployment with
// AGENCY_LLM_PROVIDER / AGENCY_LLM_MODEL.

import { resolveProvider, withProviderChatExtras, formatProviderError, DEFAULT_MODELS } from './providers.js';

export function createLlm({ providerId, model, timeoutMs = 45000 } = {}) {
  const pid = providerId || process.env.AGENCY_LLM_PROVIDER || 'openrouter';
  const mdl = model || process.env.AGENCY_LLM_MODEL || (pid === 'openrouter' ? 'openai/gpt-4o-mini' : DEFAULT_MODELS[pid]);

  return async function llm({ system, user }) {
    const resolved = resolveProvider(pid);
    const res = await fetch(resolved.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
        ...resolved.extraHeaders(),
      },
      body: JSON.stringify(withProviderChatExtras({
        model: mdl,
        stream: false,
        max_tokens: 1500,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      }, pid)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(formatProviderError(resolved.label, res.status, text, mdl));
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Model returned a non-JSON response'); }
    return data?.choices?.[0]?.message?.content || '';
  };
}
