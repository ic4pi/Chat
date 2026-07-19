/**
 * POST /api/agent-chat
 * Body: { messages, systemPrompt, model?, provider?, apiKey? }
 *
 * Client can supply a full systemPrompt (file tree + context) and optionally
 * a BYOK apiKey for Venice / OpenRouter / Cerebras / Groq / NVIDIA.
 */

import { estimateTokens } from '../lib/context-filters.js';
import { resolveProvider } from '../lib/providers.js';

/** Stay under Venice/Dolphin ~131k with room for the completion. */
const MAX_INPUT_TOKENS = 100_000;
const MAX_SYSTEM_TOKENS = 70_000;
const MAX_HISTORY_TOKENS = 25_000;

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sandbox-Session, X-Provider-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { messages, systemPrompt, model, provider: providerId, apiKey: clientKey } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
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
        model: model || 'dolphin-3.0-mistral-24b',
        messages: messagesWithSystem,
        stream: false,
      }),
      signal: controller.signal,
    });

    const rawText = await upstream.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = { error: { message: rawText } }; }

    if (!upstream.ok) {
      const detail = data?.error?.message || data?.error || `Upstream HTTP ${upstream.status}`;
      return res.status(upstream.status).json({
        error: `${resolved.label} error (${upstream.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
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
        error: `${resolved.label} timed out after ${UPSTREAM_TIMEOUT_MS / 1000}s.`,
        provider: resolved.label,
        model,
      });
    }
    return res.status(502).json({ error: err.message || 'Upstream request failed' });
  } finally {
    clearTimeout(timer);
  }
}
