// Vercel serverless function — proxies to Venice / OpenRouter / Cerebras /
// Groq / NVIDIA. Supports JSON (stream:false) and SSE (stream:true).
//
// System-prompt handling: the browser sends a personaId. The server looks up
// that persona's system prompt in KV and prepends the master prompt, plus a
// live search block when the caller asked for one. No channel/role/safety
// rules are ever injected.

import { loadConfig } from '../lib/config.js';
import { resolveProvider, withProviderChatExtras, formatProviderError } from '../lib/providers.js';
import { requirePaidAccess } from '../lib/model-meta.js';
import { prepareImageMessages, hasImageParts } from '../lib/vision.js';
import { extractQueryText, searchWeb, formatSearchContext } from '../lib/websearch.js';
import { fetchWithModelFallback } from '../lib/model-health.js';
import { loadClientBrief, ClientAccessError } from '../lib/hub.js';

/**
 * Headroom under vercel.json maxDuration 300. Must stay below the platform
 * kill so AbortController can emit a clean SSE timedOut/done instead of a
 * silent drop. Reasoning models often burn 1–2+ minutes before content.
 */
const UPSTREAM_TIMEOUT_MS = 280_000;
/**
 * Room for a full normal reply (lyrics, essays, short plans) in one message.
 * Auto-continue only kicks in on hard cutoffs (length / timeout), not by design.
 */
const CHUNK_MAX_TOKENS = 8192;

/**
 * Small models (venice-uncensored et al.) tend to re-emit their entire prior
 * answer verbatim on every follow-up instead of addressing just the new
 * question — this is a response-quality instruction, not a content/safety
 * rule, so it stays consistent with "nothing injected on uncensored models"
 * below: it never tells the model what it may or may not say, only how to
 * scope a reply once there's prior turns to not repeat.
 */
const NO_REPEAT_INSTRUCTION =
  'This is an ongoing conversation. When replying to a follow-up, respond only ' +
  'to what is newly asked — do not restate, re-summarize, or repeat your ' +
  'previous answer(s) first.';

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Only the admin master prompt + selected persona. Nothing else is injected —
 * no channel rules, role rules, or soft safety hedges on top of uncensored models.
 * Returns '' when neither is set so the request can omit a system message entirely.
 */
async function resolveSystemPrompt(personaId) {
  try {
    const config = await loadConfig();
    const persona =
      config.personas.find((p) => p.id === personaId) ||
      config.personas.find((p) => p.id === 'nexus') ||
      config.personas[0];
    const parts = [config.masterPrompt, persona?.systemPrompt].filter(
      (s) => typeof s === 'string' && s.trim().length > 0,
    );
    return parts.join('\n\n');
  } catch (err) {
    console.error('loadConfig failed:', err);
    return '';
  }
}

function extractDelta(chunk) {
  const choice = chunk?.choices?.[0];
  if (!choice) return { text: '', reasoning: '' };
  const delta = choice.delta || {};
  const text =
    (typeof delta.content === 'string' ? delta.content : '') ||
    (typeof choice.text === 'string' ? choice.text : '') ||
    '';
  const reasoning =
    (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '') ||
    (typeof delta.reasoning === 'string' ? delta.reasoning : '') ||
    (typeof delta.thinking === 'string' ? delta.thinking : '') ||
    '';
  return { text, reasoning };
}

async function handleStream(req, res, resolved, model, messagesWithSystem, providerId, notice, hadImages, sources) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (sources && sources.length) sseWrite(res, { type: 'sources', sources });
  if (notice) sseWrite(res, { type: 'status', message: notice });
  sseWrite(res, { type: 'status', message: `Connecting to ${resolved.label}…` });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  // Set when the chosen model was retired and a current one answered instead.
  let modelReplaced = null;
  let fullReply = '';
  let fullReasoning = '';
  let finishReason = '';

  const finalizeReply = (opts = {}) => {
    let reply = fullReply;
    const incomplete = Boolean(opts.incomplete || finishReason === 'length');
    if (incomplete && reply.trim() && !/⟦\s*MORE\s*⟧|⟦\s*DONE\s*⟧/i.test(reply)) {
      reply = `${reply.trimEnd()}\n\n⟦MORE⟧`;
    }
    sseWrite(res, {
      type: 'done',
      reply,
      reasoning: fullReasoning || undefined,
      incomplete: incomplete || undefined,
      timedOut: opts.timedOut || undefined,
      provider: resolved.label,
      model,
      modelReplaced: modelReplaced || undefined,
      keySource: resolved.keySource,
    });
    return res.end();
  };

  try {
    const fb = await fetchWithModelFallback({
      providerId: providerId || resolved.id,
      model,
      kind: 'chat',
      canUse: (id) => !requirePaidAccess(req, providerId || resolved.id, id),
      doFetch: (m) => fetch(resolved.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
          Accept: 'text/event-stream',
          ...resolved.extraHeaders(),
        },
        body: JSON.stringify(
          withProviderChatExtras(
            {
              model: m,
              messages: messagesWithSystem,
              stream: true,
              max_tokens: CHUNK_MAX_TOKENS,
            },
            providerId || resolved.id,
          ),
        ),
        signal: controller.signal,
      }),
    });
    const upstream = fb.res;
    if (fb.replaced) { modelReplaced = fb.replaced; model = fb.model; }

    if (!upstream.ok) {
      const errText = await upstream.text();
      sseWrite(res, {
        type: 'error',
        error: formatProviderError(resolved.label, upstream.status, errText, model, { hadImages }),
        provider: resolved.label,
        model,
      });
      return res.end();
    }

    if (modelReplaced) {
      sseWrite(res, { type: 'status', message: `${modelReplaced.from} is no longer available — answering with ${modelReplaced.to}.` });
    }
    sseWrite(res, { type: 'status', message: 'Model is writing…' });

    const reader = upstream.body?.getReader();
    if (!reader) {
      sseWrite(res, { type: 'error', error: 'Upstream returned no stream body' });
      return res.end();
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          return finalizeReply();
        }
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const fr = chunk?.choices?.[0]?.finish_reason;
        if (typeof fr === 'string' && fr) finishReason = fr;
        const { text, reasoning } = extractDelta(chunk);
        if (reasoning) {
          fullReasoning += reasoning;
          sseWrite(res, { type: 'thinking', text: reasoning });
        }
        if (text) {
          fullReply += text;
          sseWrite(res, { type: 'token', text });
        }
      }
    }

    // Some providers close without [DONE]
    return finalizeReply();
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    // Keep streamed content or reasoning and mark incomplete so the client
    // can auto-continue — reasoning-only timeouts used to wipe ~minutes of
    // thinking with a bare error and nothing left on screen.
    if (aborted && (fullReply.trim() || fullReasoning.trim())) {
      return finalizeReply({ incomplete: true, timedOut: true });
    }
    sseWrite(res, {
      type: 'error',
      error: aborted
        ? `${resolved.label} took too long (>${UPSTREAM_TIMEOUT_MS / 1000}s). Try a faster model or a shorter prompt.`
        : (err.message || 'Upstream request failed'),
      provider: resolved.label,
      model,
      partialReply: fullReply || undefined,
      reasoning: fullReasoning || undefined,
    });
    return res.end();
  } finally {
    clearTimeout(timer);
  }
}

async function handleJson(req, res, resolved, model, messagesWithSystem, providerId, notice, hadImages, sources) {
  let modelReplaced = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const fb = await fetchWithModelFallback({
      providerId: providerId || resolved.id,
      model,
      kind: 'chat',
      canUse: (id) => !requirePaidAccess(req, providerId || resolved.id, id),
      doFetch: (m) => fetch(resolved.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
          ...resolved.extraHeaders(),
        },
        body: JSON.stringify(
          withProviderChatExtras(
            {
              model: m,
              messages: messagesWithSystem,
              stream: false,
              max_tokens: CHUNK_MAX_TOKENS,
            },
            providerId || resolved.id,
          ),
        ),
        signal: controller.signal,
      }),
    });
    const upstream = fb.res;
    if (fb.replaced) { modelReplaced = fb.replaced; model = fb.model; }

    const rawText = await upstream.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: { message: rawText || 'Non-JSON response from provider' } };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: formatProviderError(resolved.label, upstream.status, data, model, { hadImages }),
        provider: resolved.label,
        model,
        raw: data,
      });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    const finish = data.choices?.[0]?.finish_reason;
    const incomplete = finish === 'length';
    const out =
      incomplete && reply && !/⟦\s*MORE\s*⟧|⟦\s*DONE\s*⟧/i.test(reply)
        ? `${String(reply).trimEnd()}\n\n⟦MORE⟧`
        : reply;
    return res.status(200).json({
      reply: out,
      notice: notice || undefined,
      incomplete: incomplete || undefined,
      provider: resolved.label,
      model,
      modelReplaced: modelReplaced || undefined,
      keySource: resolved.keySource,
      sources: sources && sources.length ? sources : undefined,
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key, X-Paid-Password');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    messages,
    model,
    provider: providerId,
    personaId,
    apiKey: clientKey,
    stream: wantStream,
    webSearch: wantWebSearch,
    // What to search for, when the client pulled it out of a plain-words ask
    // ("search the web for X" → "X"). Otherwise the last user message.
    webSearchQuery,
  } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model is required' });
  }

  const paidGate = requirePaidAccess(req, providerId || 'openrouter', model);
  if (paidGate) {
    return res.status(paidGate.status).json({ error: paidGate.error, paidLocked: true });
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

  const pid = providerId || resolved.id || 'openrouter';

  // Uncensored text models answer an image_url part with a bare
  // "400 Invalid request parameters". Turn the upload into text first.
  let chatMessages = messages;
  let visionNotice;
  try {
    const prepared = await prepareImageMessages({
      providerId: pid,
      model,
      resolved,
      messages,
      // A helper model must clear the same paid gate the picked model did.
      canUseModel: (id) => !requirePaidAccess(req, pid, id),
    });
    chatMessages = prepared.messages;
    visionNotice = prepared.notice;
  } catch (err) {
    console.error('image preparation failed:', err);
  }

  // True only when images survive preparation, i.e. the model claims vision.
  const sentImages = hasImageParts(chatMessages);

  // Working for a client: their profile rides along, and a client that is not
  // the caller's is refused outright (never answered from Personal).
  let clientBriefText = '';
  try {
    clientBriefText = await loadClientBrief(req);
  } catch (err) {
    if (err instanceof ClientAccessError) return res.status(403).json({ error: err.message });
    console.error('client brief:', err);
  }

  const hasPriorTurn = chatMessages.some((m) => m.role === 'assistant');
  const basePrompt = [await resolveSystemPrompt(personaId), clientBriefText, hasPriorTurn ? NO_REPEAT_INSTRUCTION : '']
    .filter(Boolean)
    .join('\n\n');

  // Grounding: real search results turned into a numbered context block the
  // model is told to cite, plus the same list handed back to the client so
  // it can render real links instead of trusting whatever the model claims.
  let searchNotice;
  let sources = [];
  let effectiveSystemPrompt = basePrompt;
  if (wantWebSearch) {
    try {
      const lastUser = [...chatMessages].reverse().find((m) => m.role === 'user');
      const query = (typeof webSearchQuery === 'string' && webSearchQuery.trim()) || extractQueryText(lastUser?.content);
      sources = await searchWeb(query);
      const context = formatSearchContext(query, sources);
      effectiveSystemPrompt = [basePrompt, context].filter(Boolean).join('\n\n');
    } catch (err) {
      searchNotice = `Web search skipped: ${err.message}`;
    }
  }
  const notice = [visionNotice, searchNotice].filter(Boolean).join(' ') || undefined;

  const messagesWithSystem = effectiveSystemPrompt
    ? [
        { role: 'system', content: effectiveSystemPrompt },
        ...chatMessages.map((m) => ({ role: m.role, content: m.content })),
      ]
    : chatMessages.map((m) => ({ role: m.role, content: m.content }));

  if (wantStream) {
    return handleStream(req, res, resolved, model, messagesWithSystem, pid, notice, sentImages, sources);
  }
  return handleJson(req, res, resolved, model, messagesWithSystem, pid, notice, sentImages, sources);
}
