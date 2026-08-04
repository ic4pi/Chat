/**
 * POST /api/generate  (SSE — maxDuration: 300)
 *
 * Multi-LLM code-slice orchestrator. Client sends a prompt plus a
 * per-chunk model map (`chunkModels`). Each coding chunk (HTML, CSS,
 * JS logic, scaffolding, state, data-fetch, animations, a11y, tests)
 * is routed to its assigned LLM endpoint. If a chunk has no usable
 * assignment, falls back to the pre-approved general-purpose model.
 *
 * Body:
 *   {
 *     prompt: string,                 // required
 *     chunks?: string[],              // subset of chunk ids (default: all)
 *     chunkModels?: {                 // keyed by chunk id
 *       [chunkId]: { provider, model }
 *     },
 *     provider?: string,              // unused for routing; kept for compat
 *     model?: string,
 *     apiKey?: string,                // single BYOK fallback
 *     providerKeys?: { [providerId]: string },
 *     context?: string,               // optional extra context (tree, files)
 *     stream?: boolean                // default true (SSE)
 *   }
 *
 * SSE events: status | chunk-start | token | chunk-done | done | error
 */

import {
  CHUNK_LIST,
  GENERAL_PURPOSE_MODEL,
  buildChunkSystemPrompt,
  resolveChunkModel,
  selectChunks,
} from '../lib/code-slices.js';
import { requirePaidAccess } from '../lib/model-meta.js';
import { resolveProvider, withProviderChatExtras, formatProviderError } from '../lib/providers.js';

const UPSTREAM_TIMEOUT_MS = Math.max(
  10_000,
  Math.min(Number(process.env.GENERATE_TIMEOUT_MS) || 55_000, 280_000),
);
const MAX_TOKENS_PER_CHUNK = 4096;
const MAX_PROMPT_CHARS = 24_000;
const MAX_CONTEXT_CHARS = 40_000;

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function pickKey(providerKeys, providerId, fallbackKey) {
  const map = providerKeys && typeof providerKeys === 'object' ? providerKeys : {};
  const fromMap = typeof map[providerId] === 'string' ? map[providerId].trim() : '';
  if (fromMap) return fromMap;
  return typeof fallbackKey === 'string' ? fallbackKey : '';
}

async function callCompletion(resolved, model, messages, { maxTokens, signal, providerId }) {
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
          model,
          messages,
          stream: false,
          max_tokens: maxTokens,
          temperature: 0.35,
        },
        providerId || resolved.id,
      ),
    ),
    signal,
  });

  const rawText = await upstream.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { error: { message: rawText || 'Non-JSON response' } };
  }

  if (!upstream.ok) {
    const message = formatProviderError(
      resolved.label,
      upstream.status,
      data,
      model,
    );
    const err = new Error(message);
    err.status = upstream.status;
    throw err;
  }

  return String(data.choices?.[0]?.message?.content ?? '').trim();
}

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[… truncated …]`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Sandbox-Session, X-Provider-Key, X-Paid-Password',
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    prompt,
    chunks: requestedChunks,
    chunkModels = {},
    apiKey: clientKey,
    providerKeys = {},
    context = '',
    stream: wantStream,
  } = req.body || {};

  const promptText = truncate(String(prompt || '').trim(), MAX_PROMPT_CHARS);
  if (!promptText) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const headerKey = req.headers['x-provider-key'];
  const clientKeyStr =
    typeof clientKey === 'string'
      ? clientKey
      : (typeof headerKey === 'string' ? headerKey : '');

  const selected = selectChunks(requestedChunks);

  // Gate paid models before starting the run.
  for (const chunk of selected) {
    const resolved = resolveChunkModel(chunkModels, chunk.id);
    const paidGate = requirePaidAccess(req, resolved.provider, resolved.model);
    if (paidGate) {
      return res.status(paidGate.status).json({
        error: paidGate.error,
        paidLocked: true,
        chunkId: chunk.id,
      });
    }
  }

  const useStream = wantStream !== false;

  if (!useStream) {
    return handleJson(res, {
      promptText,
      selected,
      chunkModels,
      providerKeys,
      clientKeyStr,
      context: truncate(context, MAX_CONTEXT_CHARS),
    });
  }

  return handleStream(res, {
    promptText,
    selected,
    chunkModels,
    providerKeys,
    clientKeyStr,
    context: truncate(context, MAX_CONTEXT_CHARS),
  });
}

async function runChunks({
  promptText,
  selected,
  chunkModels,
  providerKeys,
  clientKeyStr,
  context,
  onStatus,
  onChunkStart,
  onToken,
  onChunkDone,
  signal,
}) {
  const prior = [];
  const results = [];

  for (const chunk of selected) {
    if (signal?.aborted) break;

    let assignment = resolveChunkModel(chunkModels, chunk.id);
    let turnResolved;
    try {
      const key = pickKey(providerKeys, assignment.provider, clientKeyStr);
      turnResolved = resolveProvider(assignment.provider, key);
    } catch (err) {
      // Provider key missing — fall back to general-purpose once.
      const fallback = {
        provider: GENERAL_PURPOSE_MODEL.provider,
        model: GENERAL_PURPOSE_MODEL.model,
        badge: GENERAL_PURPOSE_MODEL.badge,
        usedFallback: true,
        source: 'general',
      };
      try {
        const key = pickKey(providerKeys, fallback.provider, clientKeyStr);
        turnResolved = resolveProvider(fallback.provider, key);
        assignment = fallback;
        onStatus?.(
          `${chunk.label}: falling back to general-purpose (${fallback.model}) — ${err.message || 'provider unavailable'}`,
        );
      } catch (err2) {
        onChunkDone?.({
          chunkId: chunk.id,
          label: chunk.label,
          ok: false,
          error: err2.message || err.message || 'Provider not configured',
          provider: assignment.provider,
          model: assignment.model,
          badge: assignment.badge,
          usedFallback: assignment.usedFallback,
        });
        results.push({
          chunkId: chunk.id,
          label: chunk.label,
          ok: false,
          error: err2.message || err.message || 'Provider not configured',
        });
        continue;
      }
    }

    onChunkStart?.({
      chunkId: chunk.id,
      label: chunk.label,
      provider: turnResolved.label || assignment.provider,
      model: assignment.model,
      badge: assignment.badge,
      usedFallback: assignment.usedFallback,
      source: assignment.source,
    });
    onStatus?.(
      `Generating ${chunk.label} with ${turnResolved.label} · ${assignment.model}${assignment.usedFallback ? ' (fallback)' : ''}…`,
    );

    const system = buildChunkSystemPrompt(chunk);
    const priorBlock = prior.length
      ? prior
          .map((p) => `### Already generated — ${p.label}\n${p.content}`)
          .join('\n\n')
      : '(This is the first slice.)';

    const userPayload = [
      `FEATURE REQUEST:\n${promptText}`,
      context ? `\nADDITIONAL CONTEXT:\n${context}` : '',
      `\nPRIOR SLICES:\n${priorBlock}`,
      `\nNow produce ONLY the "${chunk.label}" slice.`,
    ]
      .filter(Boolean)
      .join('\n');

    let content = '';
    try {
      content = await callCompletion(
        turnResolved,
        assignment.model,
        [
          { role: 'system', content: system },
          { role: 'user', content: userPayload },
        ],
        {
          maxTokens: MAX_TOKENS_PER_CHUNK,
          signal,
          providerId: assignment.provider || turnResolved.id,
        },
      );
    } catch (err) {
      const aborted = err?.name === 'AbortError' || signal?.aborted;
      const error = aborted
        ? `Timed out generating ${chunk.label}.`
        : (err.message || `Failed generating ${chunk.label}`);
      onChunkDone?.({
        chunkId: chunk.id,
        label: chunk.label,
        ok: false,
        error,
        provider: turnResolved.label || assignment.provider,
        model: assignment.model,
        badge: assignment.badge,
        usedFallback: assignment.usedFallback,
      });
      results.push({
        chunkId: chunk.id,
        label: chunk.label,
        ok: false,
        error,
        provider: assignment.provider,
        model: assignment.model,
        badge: assignment.badge,
        usedFallback: assignment.usedFallback,
      });
      continue;
    }

    if (!content) content = `(No output for ${chunk.label}.)`;

    onToken?.({
      chunkId: chunk.id,
      label: chunk.label,
      text: content,
      provider: turnResolved.label || assignment.provider,
      model: assignment.model,
      badge: assignment.badge,
    });

    const donePayload = {
      chunkId: chunk.id,
      label: chunk.label,
      ok: true,
      content,
      provider: turnResolved.label || assignment.provider,
      model: assignment.model,
      badge: assignment.badge,
      usedFallback: !!assignment.usedFallback,
      source: assignment.source,
    };
    onChunkDone?.(donePayload);
    prior.push({ label: chunk.label, content });
    results.push(donePayload);
  }

  return results;
}

async function handleStream(res, opts) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS * Math.min(opts.selected.length + 1, 12),
  );
  res.on('close', () => {
    if (!controller.signal.aborted) controller.abort();
  });

  try {
    sseWrite(res, {
      type: 'status',
      message: `Starting generate · ${opts.selected.length} slices…`,
      chunks: opts.selected.map((c) => c.id),
    });

    const results = await runChunks({
      ...opts,
      signal: controller.signal,
      onStatus: (message) => sseWrite(res, { type: 'status', message }),
      onChunkStart: (payload) => sseWrite(res, { type: 'chunk-start', ...payload }),
      onToken: (payload) => sseWrite(res, { type: 'token', ...payload }),
      onChunkDone: (payload) => sseWrite(res, { type: 'chunk-done', ...payload }),
    });

    sseWrite(res, {
      type: 'done',
      ok: results.every((r) => r.ok),
      chunks: results,
      catalog: CHUNK_LIST.map((c) => c.id),
    });
  } catch (err) {
    sseWrite(res, {
      type: 'error',
      error: err.message || 'Generate failed',
    });
  } finally {
    clearTimeout(timer);
    res.end();
  }
}

async function handleJson(res, opts) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS * Math.min(opts.selected.length + 1, 12),
  );
  try {
    const results = await runChunks({
      ...opts,
      signal: controller.signal,
    });
    return res.status(200).json({
      ok: results.every((r) => r.ok),
      chunks: results,
      catalog: CHUNK_LIST.map((c) => c.id),
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'Generate timed out.' });
    }
    return res.status(502).json({ error: err.message || 'Generate failed' });
  } finally {
    clearTimeout(timer);
  }
}
