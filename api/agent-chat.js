/**
 * POST /api/agent-chat
 * Body: { messages, systemPrompt, model?, provider?, apiKey?, stream? }
 *
 * Client can supply a full systemPrompt (file tree + context) and optionally
 * a BYOK apiKey for Venice / OpenRouter / Cerebras / Groq / NVIDIA.
 *
 * Default is SSE streaming so tokens reach the browser before Vercel's
 * function kill. Non-stream JSON remains available via stream:false.
 *
 * Auto-routing (lib/agent-routing.js): when the request is on Workspace's own
 * default model (or sends none), a simple ask goes to free Qwen coder and a
 * tougher one goes to Sonnet 4.5. Free Qwen getting rate-limited escalates to
 * paid Qwen. A refusal from ANY tier — including a manually picked model —
 * reroutes once to the uncensored default. Each hop is a fresh upstream call;
 * up to 3 hops total before giving up.
 *
 * IMPORTANT: keep UPSTREAM_TIMEOUT_MS under vercel.json maxDuration (800,
 * this route only — Fluid Compute on Pro allows up to 800s/invocation,
 * well above the plain-Node 300s ceiling the rest of the API stays under).
 * A longer abort timer never fires — Vercel returns opaque 504.
 */

import { estimateTokens } from '../lib/context-filters.js';
import { resolveProvider, withProviderChatExtras, formatProviderError } from '../lib/providers.js';
import { requirePaidAccess } from '../lib/model-meta.js';
import { TIERS, pickInitialAttempt, isRateLimited, isRefusal } from '../lib/agent-routing.js';

/** Stay under Venice/Dolphin ~131k with room for the completion. */
const MAX_INPUT_TOKENS = 100_000;
const MAX_SYSTEM_TOKENS = 70_000;
const MAX_HISTORY_TOKENS = 25_000;

/**
 * Headroom under vercel.json maxDuration 800 (Fluid Compute, Pro plan).
 * Reasoning models (Qwen, GLM Flash Heretic, etc.) routinely spend several
 * minutes on thinking tokens before any content — a flat 280s cap was
 * killing the upstream connection right as reasoning finished and writing
 * was about to start, regardless of how much real, visible work was still
 * happening. Override with AGENT_CHAT_TIMEOUT_MS if needed.
 */
const UPSTREAM_TIMEOUT_MS = Math.max(
  10_000,
  Math.min(Number(process.env.AGENT_CHAT_TIMEOUT_MS) || 770_000, 770_000),
);

/**
 * Agent replies must contain COMPLETE File: blocks — the write endpoint
 * rejects truncated files. 8192 was too small for real source files
 * (api/group-chat.js, public/app.js class sizes) and caused a loop of
 * length-cut replies → rejected writes. 16k output is supported by the
 * coding models on all five providers we route to.
 */
const CHUNK_MAX_TOKENS = 16_384;

/** Comment-frame keepalive so idle proxies don't kill silent reasoning phases. */
const KEEPALIVE_MS = 15_000;

/** Continuation marker — same protocol as /api/chat so the client handles one signal. */
const MORE_MARKER = '⟦MORE⟧';
const MARKER_RE = /⟦\s*MORE\s*⟧|⟦\s*DONE\s*⟧/i;

/** Auto-routing hops for one request: primary + at most 2 fallbacks. */
const MAX_HOPS = 3;

function truncateToTokens(text, maxTokens) {
  const maxChars = maxTokens * 4;
  if (!text || text.length <= maxChars) return text || '';
  const head = Math.floor(maxChars * 0.75);
  const tail = maxChars - head - 120;
  return (
    text.slice(0, head) +
    '\n\n[… truncated by server to fit model context window …]\n\n' +
    text.slice(-Math.max(tail, 0))
  );
}

function contentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'image_url') return '[image]';
        return '';
      })
      .join('\n');
  }
  return String(content ?? '');
}

function budgetMessages(systemPrompt, messages) {
  let system = truncateToTokens(systemPrompt || '', MAX_SYSTEM_TOKENS);

  const hist = messages.map((m) => ({
    role: m.role,
    // Preserve multimodal arrays for vision models; budget uses string length.
    content: m.content,
  }));
  let histTokens = hist.reduce((n, m) => n + estimateTokens(contentToString(m.content)), 0);
  while (hist.length > 1 && histTokens > MAX_HISTORY_TOKENS) {
    const removed = hist.shift();
    histTokens -= estimateTokens(contentToString(removed.content));
  }
  for (const m of hist) {
    if (typeof m.content === 'string' && estimateTokens(m.content) > 8_000) {
      m.content = truncateToTokens(m.content, 8_000);
    }
  }

  let total = estimateTokens(system) + hist.reduce((n, m) => n + estimateTokens(contentToString(m.content)), 0);
  if (total > MAX_INPUT_TOKENS) {
    system = truncateToTokens(system, Math.max(4_000, MAX_INPUT_TOKENS - histTokens - 1_000));
    total = estimateTokens(system) + hist.reduce((n, m) => n + estimateTokens(contentToString(m.content)), 0);
  }

  return { system, messages: hist, tokens: total };
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

/** Never write to a closed/destroyed response — client may have disconnected. */
function sseWrite(res, obj) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseComment(res, text) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`:${text}\n\n`);
}

/** Resolve a provider for one hop. Only forward the client's BYOK key when the
 *  hop is still on the provider they originally picked — an escalation to a
 *  different provider (e.g. OpenRouter -> Venice) must use the server's own
 *  env key, never the wrong provider's key. */
function resolveHop(attempt, clientKey, originalProviderId) {
  const key = attempt.provider === originalProviderId ? clientKey : undefined;
  return resolveProvider(attempt.provider, key);
}

/**
 * Single non-streamed upstream call for one hop.
 * @returns {{ ok: boolean, status: number, reply?: string, finishReason?: string, errBody?: any, aborted?: boolean, message?: string }}
 */
async function callOnce(resolved, attempt, messagesWithSystem) {
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
      body: JSON.stringify(
        withProviderChatExtras(
          { model: attempt.model || 'dolphin-3.0-mistral-24b', messages: messagesWithSystem, stream: false, max_tokens: CHUNK_MAX_TOKENS },
          attempt.provider,
        ),
      ),
      signal: controller.signal,
    });
    const rawText = await upstream.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = { error: { message: rawText } }; }
    if (!upstream.ok) return { ok: false, status: upstream.status, errBody: data };
    return {
      ok: true,
      status: upstream.status,
      reply: String(data.choices?.[0]?.message?.content ?? ''),
      finishReason: data.choices?.[0]?.finish_reason || '',
    };
  } catch (err) {
    return { ok: false, status: 0, aborted: err?.name === 'AbortError', message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function handleJson(req, res, initialAttempt, messagesWithSystem, budgeted, clientKey, originalProviderId) {
  let attempt = initialAttempt;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const paidGate = requirePaidAccess(req, attempt.provider, attempt.model);
    if (paidGate) {
      return res.status(paidGate.status).json({ error: paidGate.error, paidLocked: true, routedTier: attempt.tier });
    }

    let resolved;
    try {
      resolved = resolveHop(attempt, clientKey, originalProviderId);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Provider not configured' });
    }

    const result = await callOnce(resolved, attempt, messagesWithSystem);

    if (!result.ok) {
      if (result.aborted) {
        return res.status(504).json({
          error: `${resolved.label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s (Vercel function limit). Try a faster model or a shorter fix ask.`,
          provider: resolved.label,
          model: attempt.model,
        });
      }
      if (result.status === 0) {
        return res.status(502).json({ error: result.message || 'Upstream request failed' });
      }
      if (isRateLimited(result.status) && attempt.tier === 'simpleFree') {
        attempt = TIERS.simplePaid;
        continue;
      }
      return res.status(result.status).json({
        error: formatProviderError(resolved.label, result.status, result.errBody, attempt.model),
        provider: resolved.label,
        model: attempt.model,
        tokens: budgeted.tokens,
      });
    }

    if (isRefusal(result.reply) && attempt.tier !== 'uncensored') {
      attempt = TIERS.uncensored;
      continue;
    }

    const incomplete = result.finishReason === 'length';
    const out =
      incomplete && result.reply.trim() && !MARKER_RE.test(result.reply)
        ? `${result.reply.trimEnd()}\n\n${MORE_MARKER}`
        : result.reply;
    return res.status(200).json({
      reply: out,
      incomplete: incomplete || undefined,
      model: attempt.model,
      provider: resolved.label,
      tokens: budgeted.tokens,
      keySource: resolved.keySource,
      routedTier: attempt.tier,
    });
  }

  return res.status(502).json({ error: 'All fallback models were exhausted without a usable reply.' });
}

/**
 * One streamed upstream call. Reasoning deltas always forward live (progress
 * feedback during long thinking phases). Content deltas only forward live
 * when `forwardTokens` is set — otherwise they're buffered so the caller can
 * check for a refusal before anything reaches the user.
 */
async function runStreamAttempt(res, resolved, attempt, messagesWithSystem, forwardTokens, registerController) {
  const controller = new AbortController();
  registerController(controller);
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const keepalive = setInterval(() => sseComment(res, 'keepalive'), KEEPALIVE_MS);

  let fullReply = '';
  let fullReasoning = '';
  let finishReason = '';

  try {
    sseWrite(res, { type: 'status', message: `Connecting to ${resolved.label}…` });

    const upstream = await fetch(resolved.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
        Accept: 'text/event-stream',
        ...resolved.extraHeaders(),
      },
      body: JSON.stringify(
        withProviderChatExtras(
          { model: attempt.model || 'dolphin-3.0-mistral-24b', messages: messagesWithSystem, stream: true, max_tokens: CHUNK_MAX_TOKENS },
          attempt.provider,
        ),
      ),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return { httpStatus: upstream.status, errText, fullReply, fullReasoning, finishReason };
    }

    sseWrite(res, { type: 'status', message: 'Model is writing…' });

    const reader = upstream.body?.getReader();
    if (!reader) return { httpStatus: 0, errText: 'Upstream returned no stream body', fullReply, fullReasoning, finishReason };

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
        if (payload === '[DONE]') return { httpStatus: 200, fullReply, fullReasoning, finishReason, done: true };
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
          if (forwardTokens) sseWrite(res, { type: 'token', text });
        }
      }
    }
    return { httpStatus: 200, fullReply, fullReasoning, finishReason, done: true };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    return { httpStatus: 0, errText: err.message, fullReply, fullReasoning, finishReason, aborted };
  } finally {
    clearTimeout(timer);
    clearInterval(keepalive);
  }
}

async function handleStream(req, res, initialAttempt, messagesWithSystem, budgeted, clientKey, originalProviderId) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let clientClosed = false;
  let activeController = null;
  const onClose = () => {
    clientClosed = true;
    if (activeController && !activeController.signal.aborted) activeController.abort();
  };
  res.on('close', onClose);

  const finalizeAndEnd = (fullReply, fullReasoning, resolved, model, tier, opts = {}) => {
    let reply = fullReply;
    const incomplete = Boolean(opts.incomplete);
    if (incomplete && !clientClosed && reply.trim() && !MARKER_RE.test(reply)) {
      reply = `${reply.trimEnd()}\n\n${MORE_MARKER}`;
    }
    sseWrite(res, {
      type: 'done',
      reply,
      reasoning: fullReasoning || undefined,
      incomplete: incomplete || undefined,
      timedOut: opts.timedOut || undefined,
      provider: resolved.label,
      model,
      tokens: budgeted.tokens,
      keySource: resolved.keySource,
      routedTier: tier,
    });
    res.off('close', onClose);
    return res.end();
  };

  let attempt = initialAttempt;
  let combinedReasoning = '';

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const paidGate = requirePaidAccess(req, attempt.provider, attempt.model);
    if (paidGate) {
      sseWrite(res, { type: 'error', error: paidGate.error, paidLocked: true });
      res.off('close', onClose);
      return res.end();
    }

    let resolved;
    try {
      resolved = resolveHop(attempt, clientKey, originalProviderId);
    } catch (err) {
      sseWrite(res, { type: 'error', error: err.message || 'Provider not configured' });
      res.off('close', onClose);
      return res.end();
    }

    // Nothing left to fall back to from the uncensored tier — show it live.
    const forwardTokens = attempt.tier === 'uncensored';
    const result = await runStreamAttempt(res, resolved, attempt, messagesWithSystem, forwardTokens, (c) => {
      activeController = c;
    });
    combinedReasoning += result.fullReasoning || '';

    if (clientClosed) {
      res.off('close', onClose);
      return res.end();
    }

    // Hard upstream failure (not a timeout/abort).
    if (!result.done && !result.aborted) {
      if (isRateLimited(result.httpStatus) && attempt.tier === 'simpleFree') {
        sseWrite(res, { type: 'status', message: 'Free tier is rate-limited — retrying on paid Qwen…' });
        attempt = TIERS.simplePaid;
        continue;
      }
      sseWrite(res, {
        type: 'error',
        error: formatProviderError(resolved.label, result.httpStatus, result.errText, attempt.model),
        provider: resolved.label,
        model: attempt.model,
      });
      res.off('close', onClose);
      return res.end();
    }

    if (result.aborted) {
      if (result.fullReply.trim() || result.fullReasoning.trim()) {
        if (!forwardTokens && result.fullReply) sseWrite(res, { type: 'token', text: result.fullReply });
        return finalizeAndEnd(result.fullReply, combinedReasoning, resolved, attempt.model, attempt.tier, {
          incomplete: true,
          timedOut: true,
        });
      }
      sseWrite(res, {
        type: 'error',
        error: `${resolved.label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s (Vercel function limit). Try a faster model or a shorter fix ask.`,
        provider: resolved.label,
        model: attempt.model,
      });
      res.off('close', onClose);
      return res.end();
    }

    // Full reply in hand. Reroute a refusal once, to the uncensored default.
    if (!forwardTokens && isRefusal(result.fullReply) && attempt.tier !== 'uncensored') {
      sseWrite(res, { type: 'status', message: 'That model declined — retrying with your uncensored default…' });
      attempt = TIERS.uncensored;
      continue;
    }

    if (!forwardTokens && result.fullReply) {
      sseWrite(res, { type: 'token', text: result.fullReply });
    }
    return finalizeAndEnd(result.fullReply, combinedReasoning, resolved, attempt.model, attempt.tier, {
      incomplete: result.finishReason === 'length',
    });
  }

  sseWrite(res, { type: 'error', error: 'All fallback models were exhausted without a usable reply.' });
  res.off('close', onClose);
  return res.end();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sandbox-Session, X-Provider-Key, X-Paid-Password');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    messages,
    systemPrompt,
    model,
    provider: providerId,
    apiKey: clientKey,
    stream: wantStream,
  } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const budgeted = budgetMessages(systemPrompt, messages);
  const messagesWithSystem = budgeted.system
    ? [{ role: 'system', content: budgeted.system }, ...budgeted.messages]
    : budgeted.messages;

  const originalProviderId = providerId || 'openrouter';
  const initialAttempt = pickInitialAttempt({
    provider: originalProviderId,
    model,
    messages,
    systemPrompt,
    tokens: budgeted.tokens,
  });

  const clientKeyHeader = clientKey || req.headers['x-provider-key'];

  // Default stream:true — Workspace needs tokens before the function time limit.
  const useStream = wantStream !== false;
  if (useStream) {
    return handleStream(req, res, initialAttempt, messagesWithSystem, budgeted, clientKeyHeader, originalProviderId);
  }
  return handleJson(req, res, initialAttempt, messagesWithSystem, budgeted, clientKeyHeader, originalProviderId);
}
