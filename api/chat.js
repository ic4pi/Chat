// Vercel serverless function — proxies to Venice / OpenRouter / Cerebras /
// Groq / NVIDIA. Supports JSON (stream:false) and SSE (stream:true).
//
// System-prompt handling: the browser sends a personaId. The server looks up
// that persona's system prompt in KV and prepends the master prompt.

import { loadConfig } from '../lib/config.js';
import { resolveProvider } from '../lib/providers.js';

const FALLBACK_SYSTEM_PROMPT = 'You are a helpful, direct assistant.';
const UPSTREAM_TIMEOUT_MS = 110_000;

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function resolveSystemPrompt(personaId) {
  let effectiveSystemPrompt = FALLBACK_SYSTEM_PROMPT;
  try {
    const config = await loadConfig();
    const persona =
      config.personas.find((p) => p.id === personaId) ||
      config.personas.find((p) => p.id === 'nexus') ||
      config.personas[0];
    const parts = [config.masterPrompt, persona?.systemPrompt].filter(
      (s) => typeof s === 'string' && s.trim().length > 0,
    );
    if (parts.length > 0) effectiveSystemPrompt = parts.join('\n\n');
  } catch (err) {
    console.error('loadConfig failed:', err);
  }
  return effectiveSystemPrompt;
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

async function handleStream(req, res, resolved, model, messagesWithSystem) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  sseWrite(res, { type: 'status', message: `Connecting to ${resolved.label}…` });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(resolved.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
        Accept: 'text/event-stream',
        ...resolved.extraHeaders(),
      },
      body: JSON.stringify({
        model,
        messages: messagesWithSystem,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      let detail = errText;
      try { detail = JSON.parse(errText)?.error?.message || errText; } catch { /* keep */ }
      sseWrite(res, {
        type: 'error',
        error: `${resolved.label} error (${upstream.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
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
    let fullReply = '';
    let fullReasoning = '';

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
          sseWrite(res, {
            type: 'done',
            reply: fullReply,
            reasoning: fullReasoning || undefined,
            provider: resolved.label,
            model,
            keySource: resolved.keySource,
          });
          return res.end();
        }
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
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
    sseWrite(res, {
      type: 'done',
      reply: fullReply,
      reasoning: fullReasoning || undefined,
      provider: resolved.label,
      model,
      keySource: resolved.keySource,
    });
    return res.end();
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    sseWrite(res, {
      type: 'error',
      error: aborted
        ? `${resolved.label} took too long (>${UPSTREAM_TIMEOUT_MS / 1000}s). Try a faster model or a shorter prompt.`
        : (err.message || 'Upstream request failed'),
      provider: resolved.label,
      model,
    });
    return res.end();
  } finally {
    clearTimeout(timer);
  }
}

async function handleJson(req, res, resolved, model, messagesWithSystem) {
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
        model,
        messages: messagesWithSystem,
        stream: false,
      }),
      signal: controller.signal,
    });

    const rawText = await upstream.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { error: { message: rawText || 'Non-JSON response from provider' } };
    }

    if (!upstream.ok) {
      const message =
        data?.error?.message ||
        data?.error ||
        data?.message ||
        `Upstream ${resolved.label} error (HTTP ${upstream.status})`;
      return res.status(upstream.status).json({
        error: typeof message === 'string' ? message : JSON.stringify(message),
        provider: resolved.label,
        model,
        raw: data,
      });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({
      reply,
      provider: resolved.label,
      model,
      keySource: resolved.keySource,
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key');
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
  } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model is required' });
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

  const effectiveSystemPrompt = await resolveSystemPrompt(personaId);
  const messagesWithSystem = [
    { role: 'system', content: effectiveSystemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  if (wantStream) {
    return handleStream(req, res, resolved, model, messagesWithSystem);
  }
  return handleJson(req, res, resolved, model, messagesWithSystem);
}
