// POST /api/campaign           — run the campaign engine on this conversation (SSE)
// POST /api/campaign?op=hook   — save a post that worked as a proven hook
//
// Runs on whatever provider + model the chat has selected. Proven hooks live
// in Supabase (campaign_hooks, pgvector, per owner) — the same memory and
// owner cookie the rest of the app uses. With the hub unconfigured the engine
// still runs, just without hook memory.

import { resolveProvider, withProviderChatExtras, formatProviderError } from '../lib/providers.js';
import { requirePaidAccess } from '../lib/model-meta.js';
import { db, HUB_ENABLED, resolveOwner, embedOne, rateLimit } from '../lib/hub.js';
import { runCampaign, platformsFromText, PLATFORMS } from '../lib/campaign-engine.js';

/** Per model call. Several run per campaign, so each is capped on its own. */
const CALL_TIMEOUT_MS = 120_000;
/** Whole run, under vercel.json maxDuration 800 with room to report. */
const RUN_BUDGET_MS = 600_000;
const MAX_RETRIES = 3;
const KEEPALIVE_MS = 15_000;
/** bge-base cosine: related text sits well above this, unrelated below. */
const HOOK_MIN_SIMILARITY = Number(process.env.CAMPAIGN_HOOK_MIN_SIMILARITY) || 0.6;

function sseWrite(res, obj) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Short JSON turns: hidden reasoning only burns the budget and the clock.
function reasoningOff(body, providerId) {
  if (providerId === 'venice') {
    return { ...body, venice_parameters: { ...(body.venice_parameters || {}), disable_thinking: true } };
  }
  if (providerId === 'openrouter') return { ...body, reasoning: { effort: 'low', exclude: true } };
  return body;
}

function retryAfterMs(headers) {
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
});

/**
 * One chat completion with the retry policy: rate limits wait as long as the
 * provider asks, timeouts / 5xx / dropped connections back off and retry,
 * auth and bad-request errors fail at once (retrying can't fix them).
 */
function makeComplete({ resolved, model, providerId, signal, onRetry }) {
  return async function complete(messages, { temperature = 0.7, maxTokens = 1500 } = {}) {
    let tokens = maxTokens;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(resolved.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${resolved.apiKey}`,
            ...resolved.extraHeaders(),
          },
          body: JSON.stringify(reasoningOff(
            withProviderChatExtras({ model, messages, stream: false, temperature, max_tokens: tokens }, providerId),
            providerId,
          )),
          signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
        });
      } catch (err) {
        if (signal.aborted) throw new Error('cancelled');
        if (attempt >= MAX_RETRIES) throw new Error(`${resolved.label} unreachable after ${attempt + 1} tries: ${err.message}`);
        const wait = Math.min(20_000, 1000 * 2 ** attempt + Math.random() * 500);
        onRetry(`${resolved.label} didn't answer — retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait, signal);
        continue;
      }

      const raw = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status === 408 || res.status === 409 || res.status >= 500;
        if (!retryable || attempt >= MAX_RETRIES) {
          throw new Error(formatProviderError(resolved.label, res.status, raw, model));
        }
        const hinted = retryAfterMs(res.headers);
        const wait = Math.min(60_000, hinted ?? Math.min(20_000, 1000 * 2 ** attempt + Math.random() * 500));
        onRetry(res.status === 429
          ? `${resolved.label} rate limit — waiting ${Math.ceil(wait / 1000)}s`
          : `${resolved.label} error ${res.status} — retrying in ${Math.ceil(wait / 1000)}s`);
        await sleep(wait, signal);
        continue;
      }

      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      const choice = data?.choices?.[0];
      const content = String(choice?.message?.content ?? '').trim();
      // A reasoning model can spend the whole budget thinking: one retry with room.
      if (!content && choice?.finish_reason === 'length' && tokens < maxTokens * 3) {
        tokens = maxTokens * 3;
        continue;
      }
      return content;
    }
  };
}

async function retrieveHooksFor(ownerId, query) {
  if (!ownerId) return [];
  const embedding = await embedOne(query);
  const { data, error } = await db.rpc('match_campaign_hooks', {
    p_owner_id: ownerId,
    p_embedding: embedding,
    p_threshold: HOOK_MIN_SIMILARITY,
    p_limit: 20,
  });
  if (error) throw new Error(error.message);
  // Relevant first (the threshold), then the best performers among them.
  return (data || [])
    .sort((a, b) => b.performance - a.performance)
    .map((h) => ({ id: h.id, text: h.text, platform: h.platform, performance: h.performance }));
}

async function saveHook(req, res) {
  if (!HUB_ENABLED) return res.status(503).json({ error: 'Hook memory needs the hub (SUPABASE_SERVICE_ROLE_KEY).' });
  if (!(await rateLimit(req, res, { bucket: 'campaign-hook', limit: 60, windowSeconds: 3600 }))) return;
  const { text, platform, performance } = req.body || {};
  const hook = typeof text === 'string' ? text.trim().slice(0, 500) : '';
  if (hook.length < 8) return res.status(400).json({ error: 'text is required' });
  const perf = performance === '' || performance == null ? 1 : Number(performance);
  if (!Number.isFinite(perf) || perf < 0) return res.status(400).json({ error: 'performance must be a number ≥ 0' });
  const plat = PLATFORMS[platform] ? platform : 'any';
  try {
    const ownerId = await resolveOwner(req, res);
    const embedding = await embedOne(hook);
    const { data, error } = await db
      .from('campaign_hooks')
      .insert({ owner_id: ownerId, text: hook, platform: plat, performance: perf, embedding })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    return res.status(502).json({ error: `Could not save the hook: ${err.message}` });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.query?.op === 'hook') return saveHook(req, res);

  const { messages, provider: providerId = 'openrouter', model, apiKey } = req.body || {};
  if (!Array.isArray(messages) || !messages.some((m) => m?.role === 'user')) {
    return res.status(400).json({ error: 'messages with at least one user turn are required' });
  }
  if (!model || typeof model !== 'string') return res.status(400).json({ error: 'model is required' });

  const paidGate = requirePaidAccess(req, providerId, model);
  if (paidGate) return res.status(paidGate.status).json({ error: paidGate.error, paidLocked: true });
  if (!(await rateLimit(req, res, { bucket: 'campaign', limit: 20, windowSeconds: 3600 }))) return;

  let resolved;
  try {
    resolved = resolveProvider(providerId, apiKey || req.headers['x-provider-key']);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Cookie must be set before the SSE headers go out.
  let ownerId = null;
  if (HUB_ENABLED) {
    try { ownerId = await resolveOwner(req, res); } catch (err) { console.error('campaign owner:', err); }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);
  const keepalive = setInterval(() => { if (!res.writableEnded) res.write(':keepalive\n\n'); }, KEEPALIVE_MS);
  const onEvent = (ev) => sseWrite(res, ev);

  const conversation = messages
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  const lastUser = [...conversation].reverse().find((m) => m.role === 'user')?.content || '';

  try {
    const result = await runCampaign({
      complete: makeComplete({
        resolved, model, providerId, signal: controller.signal,
        onRetry: (message) => onEvent({ type: 'status', message }),
      }),
      conversation,
      platforms: platformsFromText(lastUser),
      retrieveHooks: (q) => retrieveHooksFor(ownerId, q),
      onEvent,
      budgetMs: RUN_BUDGET_MS,
    });
    sseWrite(res, { type: 'done', result, hookMemory: !!ownerId, provider: resolved.label, model });
  } catch (err) {
    if (!controller.signal.aborted) {
      sseWrite(res, { type: 'error', error: err.message || 'Campaign failed' });
    }
  } finally {
    clearInterval(keepalive);
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}
