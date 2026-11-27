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

/** Comedy brands write with an uncensored model by default (the owner's choice); a model picked per brand goes first. */
export const COMEDY_MODELS = [
  { provider: 'venice', model: 'venice-uncensored-1-2' },
  { provider: 'venice', model: 'gemma-4-uncensored' },
  { provider: 'venice', model: 'venice-uncensored' },
];

/**
 * What writes for ONE brand. The model chosen on the Team page for that brand (business.writerProvider/writerModel)
 * goes first, then an explicit environment choice, then the brand kind's defaults: uncensored for comedy,
 * a standard model for everything else.
 */
export function attemptsFor(business, env = process.env, prefixes = ['AUTOPOST']) {
  const base = business?.kind === 'comedy' ? COMEDY_MODELS : SAFE_MODELS;
  const picked = business?.writerModel ? [{ provider: business.writerProvider || 'venice', model: business.writerModel }] : [];
  const list = [...picked, ...modelAttempts(env, picked.length ? [] : prefixes, base)];
  return list.filter((e, i) => list.findIndex((x) => x.provider === e.provider && x.model === e.model) === i);
}

/**
 * The attempt list. The first `<PREFIX>_PROVIDER` / `<PREFIX>_MODEL` pair set in the environment (checked in the
 * order of `prefixes`, e.g. ['LEADS', 'AUTOPOST']) goes first — your explicit choice — then the safe list.
 */
export function modelAttempts(env = process.env, prefixes = ['AUTOPOST'], base = SAFE_MODELS) {
  const out = [];
  for (const p of prefixes) {
    const provider = env[`${p}_PROVIDER`];
    const model = env[`${p}_MODEL`] || (provider ? DEFAULT_MODELS[provider] : '');
    if (model) { out.push({ provider: provider || 'venice', model }); break; }
  }
  out.push(...base);
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
