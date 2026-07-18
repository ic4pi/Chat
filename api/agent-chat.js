/**
 * POST /api/agent-chat
 * Body: { messages, systemPrompt, model?, provider? }
 *
 * Like /api/chat but the client can supply a full systemPrompt (the agent
 * injects the file tree + context into it). Enforces a hard prompt budget
 * so oversized context never reaches the upstream model.
 */

import { estimateTokens } from '../lib/context-filters.js';

const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    extraHeaders: () => ({
      'HTTP-Referer': process.env.SITE_URL || 'https://example.vercel.app',
      'X-Title': 'Sandbox Agent',
    }),
  },
  venice: {
    url: 'https://api.venice.ai/api/v1/chat/completions',
    apiKeyEnv: 'VENICE_API_KEY',
    label: 'Venice',
    extraHeaders: () => ({}),
  },
};

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

function budgetMessages(systemPrompt, messages) {
  let system = truncateToTokens(systemPrompt || '', MAX_SYSTEM_TOKENS);

  // Keep newest messages; drop oldest until history fits.
  const hist = messages.map(m => ({
    role: m.role,
    content: String(m.content ?? ''),
  }));
  let histTokens = hist.reduce((n, m) => n + estimateTokens(m.content), 0);
  while (hist.length > 1 && histTokens > MAX_HISTORY_TOKENS) {
    const removed = hist.shift();
    histTokens -= estimateTokens(removed.content);
  }
  for (const m of hist) {
    if (estimateTokens(m.content) > 8_000) {
      m.content = truncateToTokens(m.content, 8_000);
    }
  }

  let total = estimateTokens(system) + hist.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (total > MAX_INPUT_TOKENS) {
    system = truncateToTokens(system, Math.max(4_000, MAX_INPUT_TOKENS - histTokens - 1_000));
    total = estimateTokens(system) + hist.reduce((n, m) => n + estimateTokens(m.content), 0);
  }

  return {
    system,
    messages: hist,
    tokens: total,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sandbox-Session');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { messages, systemPrompt, model, provider: providerId } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const provider = PROVIDERS[providerId] || PROVIDERS.venice;
  const apiKey   = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    return res.status(500).json({
      error: `${provider.apiKeyEnv} not set. Add it in Vercel → Settings → Environment Variables.`,
    });
  }

  const budgeted = budgetMessages(systemPrompt, messages);
  const messagesWithSystem = budgeted.system
    ? [{ role: 'system', content: budgeted.system }, ...budgeted.messages]
    : budgeted.messages;

  if (budgeted.tokens > MAX_INPUT_TOKENS) {
    return res.status(413).json({
      error:
        `Prompt still too large (~${budgeted.tokens} tokens) after trimming. ` +
        `Remove large files from context (never add dist/ or public/agent/assets/).`,
      tokens: budgeted.tokens,
    });
  }

  const UPSTREAM_TIMEOUT_MS = 110_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...provider.extraHeaders(),
      },
      body: JSON.stringify({
        model: model ?? 'venice-uncensored',
        messages: messagesWithSystem,
        stream: false,
      }),
      signal: controller.signal,
    });

    const rawText = await upstream.text();
    let data;
    try { data = JSON.parse(rawText); } catch { data = { error: { message: rawText } }; }

    if (!upstream.ok) {
      const msg = data?.error?.message || `Upstream error HTTP ${upstream.status}`;
      return res.status(upstream.status).json({ error: msg, tokens: budgeted.tokens });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({
      reply,
      model,
      provider: provider.label,
      tokens: budgeted.tokens,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    return res.status(aborted ? 504 : 500).json({
      error: aborted
        ? `${provider.label} took too long (>${UPSTREAM_TIMEOUT_MS / 1000}s). Try a faster model or a shorter prompt.`
        : (err.message || 'Unknown server error'),
    });
  } finally {
    clearTimeout(timer);
  }
}
