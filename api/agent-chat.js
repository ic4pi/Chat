/**
 * POST /api/agent-chat
 * Body: { messages, systemPrompt, model?, provider?, apiKey?, stream? }
 *
 * Client can supply a full systemPrompt (file tree + context) and optionally
 * a BYOK apiKey for Venice / OpenRouter / Cerebras / Groq / NVIDIA.
 *
 * Default is SSE streaming so tokens reach the browser before Vercel's
 * Hobby ~60s hard kill. Non-stream JSON remains available via stream:false.
 *
 * IMPORTANT: keep UPSTREAM_TIMEOUT_MS under vercel.json maxDuration (Hobby
 * caps at 60s). A longer abort timer never fires — Vercel returns opaque 504.
 */

import { estimateTokens } from '../lib/context-filters.js';
import { resolveProvider, withProviderChatExtras, formatProviderError } from '../lib/providers.js';
import { requirePaidAccess } from '../lib/model-meta.js';

/** Stay under Venice/Dolphin ~131k with room for the completion. */
const MAX_INPUT_TOKENS = 100_000;
const MAX_SYSTEM_TOKENS = 70_000;
const MAX_HISTORY_TOKENS = 25_000;

/**
 * Leave headroom under Vercel Hobby's hard 60s cap by default.
 * On Pro (vercel.json maxDuration 300), set AGENT_CHAT_TIMEOUT_MS=280000.
 */
const UPSTREAM_TIMEOUT_MS = Math.max(
  10_000,
  Math.min(Number(process.env.AGENT_CHAT_TIMEOUT_MS) || 55_000, 280_000),
);
const CHUNK_MAX_TOKENS = 8192;

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

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handleStream(res, resolved, model, messagesWithSystem, providerId, budgeted) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  sseWrite(res, { type: 'status', message: `Connecting to ${resolved.label}…` });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let fullReply = '';
  let finishReason = '';

  const finalizeReply = (opts = {}) => {
    sseWrite(res, {
      type: 'done',
      reply: fullReply,
      incomplete: opts.incomplete || finishReason === 'length' || undefined,
      timedOut: opts.timedOut || undefined,
      provider: resolved.label,
      model,
      tokens: budgeted.tokens,
      keySource: resolved.keySource,
    });
    return res.end();
  };

  try {
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
          {
            model: model || 'dolphin-3.0-mistral-24b',
            messages: messagesWithSystem,
            stream: true,
            max_tokens: CHUNK_MAX_TOKENS,
          },
          providerId || resolved.id || 'venice',
        ),
      ),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      sseWrite(res, {
        type: 'error',
        error: formatProviderError(resolved.label, upstream.status, errText, model),
        provider: resolved.label,
        model,
      });
      return res.end();
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
        const { text } = extractDelta(chunk);
        if (text) {
          fullReply += text;
          sseWrite(res, { type: 'token', text });
        }
      }
    }

    return finalizeReply();
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    // Keep any streamed text so Workspace can still apply File: blocks.
    if (aborted && fullReply.trim()) {
      return finalizeReply({ incomplete: true, timedOut: true });
    }
    sseWrite(res, {
      type: 'error',
      error: aborted
        ? `${resolved.label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s (Vercel function limit). Try a faster model or a shorter fix ask.`
        : (err.message || 'Upstream request failed'),
      provider: resolved.label,
      model,
      partialReply: fullReply || undefined,
    });
    return res.end();
  } finally {
    clearTimeout(timer);
  }
}

async function handleJson(res, resolved, model, messagesWithSystem, providerId, budgeted) {
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
          {
            model: model || 'dolphin-3.0-mistral-24b',
            messages: messagesWithSystem,
            stream: false,
            max_tokens: CHUNK_MAX_TOKENS,
          },
          providerId || resolved.id || 'venice',
        ),
      ),
      signal: controller.signal,
    });

    const rawText = await upstream.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = { error: { message: rawText } }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: formatProviderError(resolved.label, upstream.status, data, model),
        provider: resolved.label,
        model,
        tokens: budgeted.tokens,
      });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({
      reply,
      model,
      provider: resolved.label,
      tokens: budgeted.tokens,
      keySource: resolved.keySource,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({
        error: `${resolved.label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s (Vercel function limit). Try a faster model or a shorter fix ask.`,
        provider: resolved.label,
        model,
      });
    }
    return res.status(502).json({ error: err.message || 'Upstream request failed' });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sandbox-Session, X-Provider-Key, X-Paid-Password');
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

  const paidGate = requirePaidAccess(req, providerId || 'venice', model || '');
  if (paidGate) {
    return res.status(paidGate.status).json({ error: paidGate.error, paidLocked: true });
  }

  let resolved;
  try {
    resolved = resolveProvider(providerId || 'venice', clientKey || req.headers['x-provider-key']);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Provider not configured' });
  }

  const budgeted = budgetMessages(systemPrompt, messages);
  const messagesWithSystem = budgeted.system
    ? [{ role: 'system', content: budgeted.system }, ...budgeted.messages]
    : budgeted.messages;

  // Default stream:true — Workspace needs tokens before the 60s Hobby kill.
  const useStream = wantStream !== false;
  if (useStream) {
    return handleStream(res, resolved, model, messagesWithSystem, providerId, budgeted);
  }
  return handleJson(res, resolved, model, messagesWithSystem, providerId, budgeted);
}
