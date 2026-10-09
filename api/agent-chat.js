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
 * IMPORTANT: keep UPSTREAM_TIMEOUT_MS under vercel.json maxDuration (800,
 * this route only — Fluid Compute on Pro allows up to 800s/invocation,
 * well above the plain-Node 300s ceiling the rest of the API stays under).
 * A longer abort timer never fires — Vercel returns opaque 504.
 */

import { estimateTokens } from '../lib/context-filters.js';
import { resolveProvider, withProviderChatExtras, formatProviderError } from '../lib/providers.js';
import { prepareImageMessages } from '../lib/vision.js';
import { requirePaidAccess } from '../lib/model-meta.js';
import { loadConfig } from '../lib/config.js';
import { fetchWithModelFallback } from '../lib/model-health.js';

/**
 * Orchestrator turns (body.orchestrate + personaId): the user talks to their
 * persona, and the persona decides what the coding agent is told. The persona
 * prompt and master prompt are resolved here, same as /api/chat, so neither
 * ever reaches the browser. The client's systemPrompt carries only the live
 * workspace state.
 */
const ORCHESTRATOR_PROTOCOL = [
  'WORKSPACE ORCHESTRATOR MODE',
  'You are still yourself — same character, same voice. The user is talking to YOU inside their coding',
  'workspace. Behind you is a coding agent that writes files into the user\'s sandbox. The coder cannot see',
  'this conversation. It sees only the brief you write, so the brief is the entire spec it builds from.',
  '',
  'Your job is to be the bridge:',
  '1. Work out what the user actually wants, using everything you have: this conversation, the earlier',
  '   chat history, the workspace state below, and every [CODER RESULT] so far. The user\'s wording will',
  '   often be rough or incomplete — fill the gaps from context. Never make them write a better prompt.',
  '2. If the request needs code written, changed, fixed, or debugged, write a brief for the coder.',
  '   If it is a question, discussion, or opinion, just answer — no brief.',
  '3. Ask the user a question only when a wrong guess would waste real work (two incompatible directions,',
  '   a missing credential, an unknown target). Otherwise decide, state the assumption in one line, brief it.',
  '',
  'Brief format — at most one block per reply, at the very end, exactly these markers:',
  '<<<BRIEF',
  'Goal: what the finished result must do, in concrete observable terms.',
  'Context: every fact from the conversation the coder needs — decisions made, preferences, constraints,',
  '  style, earlier attempts and why they failed. The coder knows nothing you do not write here.',
  'Files: real paths from the file tree to change, and any new paths to create.',
  'Requirements: a numbered list — specific and testable, no vague "make it better".',
  'Do not: what must stay untouched, approaches to avoid.',
  'Done when: how the result is checked (what to run, what should appear or pass).',
  'BRIEF>>>',
  '',
  'Text outside the block is what the user reads: short, in your voice — what you are having built and',
  'any assumption you made. Do not write the code yourself; the coder does that.',
  'You CAN reach the coder: the app hands your BRIEF block to it the moment you reply. Never ask the user',
  'to copy, paste or relay a prompt, and never say you cannot talk to the coder — write the BRIEF block.',
  'Messages starting with [CODER RESULT] or [AUTO-TEST] are real reports of what the coder and the',
  'sandbox tests did. Trust them over memory. If the coder failed, missed the point, or broke something,',
  'say so plainly and write a corrected brief that names exactly what went wrong.',
].join('\n');

async function resolvePersonaPrompt(personaId) {
  try {
    const config = await loadConfig();
    const persona =
      config.personas.find((p) => p.id === personaId) ||
      config.personas.find((p) => p.id === 'nexus') ||
      config.personas[0];
    return [config.masterPrompt, persona?.systemPrompt]
      .filter((s) => typeof s === 'string' && s.trim())
      .join('\n\n');
  } catch (err) {
    console.error('loadConfig failed:', err);
    return '';
  }
}

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

async function handleStream(req, res, resolved, model, messagesWithSystem, providerId, budgeted, kind) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  sseWrite(res, { type: 'status', message: `Connecting to ${resolved.label}…` });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  // Reasoning models can be silent for 1–2 min before the first delta;
  // some proxies drop idle SSE connections well before that.
  const keepalive = setInterval(() => sseComment(res, 'keepalive'), KEEPALIVE_MS);

  // Stop paying for upstream generation the moment the browser goes away.
  let clientClosed = false;
  const onClose = () => {
    clientClosed = true;
    if (!controller.signal.aborted) controller.abort();
  };
  res.on('close', onClose);

  // Set when the chosen model was retired and a current one answered instead.
  let modelReplaced = null;
  let fullReply = '';
  let fullReasoning = '';
  let finishReason = '';

  const finalizeReply = (opts = {}) => {
    let reply = fullReply;
    const incomplete = Boolean(opts.incomplete || finishReason === 'length');
    // Continuation marker — same protocol as /api/chat. Never add it when the
    // client is gone (nobody to continue) or the model already emitted one.
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
      modelReplaced: modelReplaced || undefined,
      tokens: budgeted.tokens,
      keySource: resolved.keySource,
    });
    return res.end();
  };

  try {
    const fb = await fetchWithModelFallback({
      providerId: providerId || resolved.id || 'venice',
      model,
      kind: kind,
      canUse: (id) => !requirePaidAccess(req, providerId || resolved.id || 'openrouter', id),
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
              model: m || 'dolphin-3.0-mistral-24b',
              messages: messagesWithSystem,
              stream: true,
              max_tokens: CHUNK_MAX_TOKENS,
            },
            providerId || resolved.id || 'venice',
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
        error: formatProviderError(resolved.label, upstream.status, errText, model),
        provider: resolved.label,
        model,
      });
      return res.end();
    }

    if (modelReplaced) {
      sseWrite(res, { type: 'status', message: `${modelReplaced.from} is no longer available — using ${modelReplaced.to}.` });
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

    return finalizeReply();
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    if (clientClosed) {
      // Browser disconnected mid-stream; nothing to report to anyone.
      return res.end();
    }
    // Keep any streamed text / reasoning so Workspace can continue or show thoughts.
    if (aborted && (fullReply.trim() || fullReasoning.trim())) {
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
      reasoning: fullReasoning || undefined,
    });
    return res.end();
  } finally {
    clearTimeout(timer);
    clearInterval(keepalive);
    res.off('close', onClose);
  }
}

async function handleJson(req, res, resolved, model, messagesWithSystem, providerId, budgeted, kind) {
  let modelReplaced = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const fb = await fetchWithModelFallback({
      providerId: providerId || resolved.id || 'venice',
      model,
      kind: kind,
      canUse: (id) => !requirePaidAccess(req, providerId || resolved.id || 'openrouter', id),
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
              model: m || 'dolphin-3.0-mistral-24b',
              messages: messagesWithSystem,
              stream: false,
              max_tokens: CHUNK_MAX_TOKENS,
            },
            providerId || resolved.id || 'venice',
          ),
        ),
        signal: controller.signal,
      }),
    });
    const upstream = fb.res;
    if (fb.replaced) { modelReplaced = fb.replaced; model = fb.model; }

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

    const reply = String(data.choices?.[0]?.message?.content ?? '');
    const finishReason = data.choices?.[0]?.finish_reason || '';
    const incomplete = finishReason === 'length';
    const out =
      incomplete && reply.trim() && !MARKER_RE.test(reply)
        ? `${reply.trimEnd()}\n\n${MORE_MARKER}`
        : reply;
    return res.status(200).json({
      reply: out,
      incomplete: incomplete || undefined,
      model,
      modelReplaced: modelReplaced || undefined,
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
    personaId,
    orchestrate,
  } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const paidGate = requirePaidAccess(req, providerId || 'openrouter', model || '');
  if (paidGate) {
    return res.status(paidGate.status).json({ error: paidGate.error, paidLocked: true });
  }

  let resolved;
  try {
    resolved = resolveProvider(providerId || 'openrouter', clientKey || req.headers['x-provider-key']);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Provider not configured' });
  }

  // Same guard as /api/chat: text-only models 400 on an image_url part, so
  // turn attachments into text before they ever reach the provider.
  const pid = providerId || resolved.id || 'openrouter';
  let chatMessages = messages;
  try {
    const prepared = await prepareImageMessages({
      providerId: pid,
      model: model || '',
      resolved,
      messages,
      canUseModel: (id) => !requirePaidAccess(req, pid, id),
    });
    chatMessages = prepared.messages;
  } catch (err) {
    console.error('image preparation failed:', err);
  }

  // Persona first so budget truncation (which keeps the head) never drops it.
  const effectiveSystem = orchestrate && typeof personaId === 'string' && personaId
    ? [await resolvePersonaPrompt(personaId), ORCHESTRATOR_PROTOCOL, systemPrompt]
        .filter((s) => typeof s === 'string' && s.trim())
        .join('\n\n')
    : systemPrompt;

  const budgeted = budgetMessages(effectiveSystem, chatMessages);
  const messagesWithSystem = budgeted.system
    ? [{ role: 'system', content: budgeted.system }, ...budgeted.messages]
    : budgeted.messages;

  // Default stream:true — Workspace needs tokens before the function time limit.
  const useStream = wantStream !== false;
  // A retired model is replaced in kind: the persona with a chat model, the coder with a coder.
  const kind = orchestrate ? 'chat' : 'coder';
  if (useStream) {
    return handleStream(req, res, resolved, model, messagesWithSystem, providerId, budgeted, kind);
  }
  return handleJson(req, res, resolved, model, messagesWithSystem, providerId, budgeted, kind);
}
