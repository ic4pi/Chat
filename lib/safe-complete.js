/**
 * One place for "write text that goes out under the business name": standard (not uncensored) models only, tried in
 * order, so a retired model, a rejected request or a missing key moves on to the next instead of failing the job.
 * (Nov 2026: the e2ee Gemma 404'd overnight and every autopost and lead draft failed for days.)
 *
 * Used by autopost (posts to Facebook / Instagram / X) and lead replies. The persona chat is separate and may use
 * whatever model you choose.
 */
import { resolveProvider, withProviderChatExtras, DEFAULT_MODELS, formatProviderError } from './providers.js';

export const SAFE_MODELS = [
  { provider: 'venice', model: 'google-gemma-4-26b-a4b-it' },   // standard instruct Gemma, on the Venice key that already works
  { provider: 'groq', model: 'llama-3.3-70b-versatile' },
];

/**
 * The attempt list. The first `<PREFIX>_PROVIDER` / `<PREFIX>_MODEL` pair set in the environment (checked in the
 * order of `prefixes`, e.g. ['LEADS', 'AUTOPOST']) goes first — your explicit choice — then the safe list.
 */
export function modelAttempts(env = process.env, prefixes = ['AUTOPOST']) {
  const out = [];
  for (const p of prefixes) {
    const provider = env[`${p}_PROVIDER`];
    const model = env[`${p}_MODEL`] || (provider ? DEFAULT_MODELS[provider] : '');
    if (model) { out.push({ provider: provider || 'venice', model }); break; }
  }
  out.push(...SAFE_MODELS);
  return out.filter((e, i) => out.findIndex((x) => x.provider === e.provider && x.model === e.model) === i);
}

/** Returns the model's text. Throws the first error if every attempt fails. */
export async function completeSafe({ system, user, temperature = 0.7, maxTokens = 600, attempts, timeoutMs = 90_000 }) {
  let firstError = null;
  for (const { provider: providerId, model } of attempts || modelAttempts()) {
    let resolved;
    try { resolved = resolveProvider(providerId, ''); } catch (err) { firstError ||= err; continue; }   // no key for this one
    try {
      const res = await fetch(resolved.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.apiKey}`, ...resolved.extraHeaders() },
        body: JSON.stringify(withProviderChatExtras({
          model, stream: false, temperature, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }, providerId)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(formatProviderError(resolved.label, res.status, raw, model));
      return String(JSON.parse(raw)?.choices?.[0]?.message?.content || '').trim();
    } catch (err) {
      firstError ||= err;
      console.warn(`[safe-complete] ${providerId}/${model} failed: ${String(err.message || err).slice(0, 200)}`);
    }
  }
  throw firstError || new Error('No model could write the text.');
}
