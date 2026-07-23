/**
 * POST /api/group-chat  (SSE — maxDuration: 300)
 *
 * Round-table discussion with ALL personas. Client picks a mode + topic,
 * then each user message triggers one speaking round (every persona once).
 *
 * Context stays small: each speaker gets a rolling summary of the previous
 * ~10 messages plus what others already said this round — not the full history.
 *
 * Modes:
 *   boardroom  — fully serious
 *   brainstorm — serious about the work, jokes allowed
 *   freechat   — anything goes
 *
 * SSE: status | speaker | token | turn | summary | done | error
 */

import { loadConfig } from '../lib/config.js';
import { resolveProvider } from '../lib/providers.js';

const UPSTREAM_TIMEOUT_MS = 90_000;
const MAX_PERSONAS = 12;
const RECENT_WINDOW = 10;
const MAX_TOKENS_PER_TURN = 280;

const MODE_RULES = {
  boardroom: `MODE: BOARDROOM
- Completely serious. No jokes, banter, memes, or sarcasm-for-fun.
- Professional boardroom tone. Challenge ideas with substance and evidence.
- Stay strictly on the topic. Concise, decisive contributions (1–3 short paragraphs).
- Address the table as colleagues; do not speak for other personas.`,

  brainstorm: `MODE: BRAINSTORMING
- Serious about generating useful ideas — this is real work.
- Light humor and witty asides are welcome when they help creativity.
- Build on others' ideas. Propose options, then refine. Stay on topic.
- 1–3 short paragraphs. Do not speak for other personas.`,

  freechat: `MODE: FREE CHAT
- Casual group hangout. Be fully yourself — jokes, tangents, seriousness as it fits.
- Still respond to what others said; don't monologue forever.
- 1–3 short paragraphs. Do not speak for other personas.`,
};

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function normalizeMode(raw) {
  const m = String(raw || '').toLowerCase().trim();
  if (m === 'boardroom' || m === 'board') return 'boardroom';
  if (m === 'brainstorm' || m === 'brainstorming') return 'brainstorm';
  if (m === 'freechat' || m === 'free' || m === 'free-chat') return 'freechat';
  return 'brainstorm';
}

/** Compact lines from the last N chat messages for the summarizer / context. */
function formatRecent(messages, limit = RECENT_WINDOW) {
  const slice = (Array.isArray(messages) ? messages : []).slice(-limit);
  return slice
    .map((m) => {
      const who =
        m.role === 'user'
          ? 'User'
          : m.personaName || m.personaId || 'Assistant';
      const text = String(m.content || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      return `${who}: ${text}`;
    })
    .filter((line) => line.length > 8)
    .join('\n');
}

async function callCompletion(resolved, model, messages, { maxTokens, signal }) {
  const upstream = await fetch(resolved.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resolved.apiKey}`,
      ...resolved.extraHeaders(),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      max_tokens: maxTokens,
      temperature: 0.75,
    }),
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
    const message =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      `Upstream ${resolved.label} error (HTTP ${upstream.status})`;
    const err = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    err.status = upstream.status;
    throw err;
  }

  return String(data.choices?.[0]?.message?.content ?? '').trim();
}

async function refreshSummary(resolved, model, {
  priorSummary,
  recentBlock,
  topic,
  mode,
  signal,
}) {
  const prompt = [
    'You compress a multi-persona group discussion into a tight rolling summary.',
    'Keep names, decisions, open questions, and key disagreements.',
    'Max 180 words. No preamble. Plain prose or short bullets.',
    `Topic: ${topic}`,
    `Mode: ${mode}`,
    priorSummary ? `Previous summary:\n${priorSummary}` : 'Previous summary: (none yet)',
    `Latest messages (up to ${RECENT_WINDOW}):\n${recentBlock || '(none)'}`,
  ].join('\n\n');

  try {
    return await callCompletion(
      resolved,
      model,
      [
        { role: 'system', content: 'You write terse discussion summaries for group chat context.' },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 220, signal },
    );
  } catch {
    // Fallback: keep prior + truncate recent if summarizer fails
    const fallback = [priorSummary, recentBlock].filter(Boolean).join('\n').slice(0, 1200);
    return fallback || priorSummary || '';
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const {
    messages = [],
    summary: clientSummary = '',
    topic = '',
    mode: rawMode,
    model,
    provider: providerId,
    apiKey: clientKey,
  } = req.body || {};

  const mode = normalizeMode(rawMode);
  const topicText = String(topic || '').trim();
  if (!topicText) {
    sseWrite(res, { type: 'error', error: 'A topic is required for group chat.' });
    return res.end();
  }

  const headerKey = req.headers['x-provider-key'];
  const clientKeyStr =
    typeof clientKey === 'string'
      ? clientKey
      : (typeof headerKey === 'string' ? headerKey : '');

  let resolved;
  try {
    resolved = resolveProvider(providerId || 'venice', clientKeyStr);
  } catch (err) {
    sseWrite(res, { type: 'error', error: err.message || 'Provider not configured' });
    return res.end();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS * Math.min(MAX_PERSONAS, 8));
  res.on('close', () => {
    if (!controller.signal.aborted) controller.abort();
  });

  try {
    const config = await loadConfig();
    const personas = (config.personas || []).slice(0, MAX_PERSONAS);
    if (!personas.length) {
      sseWrite(res, { type: 'error', error: 'No personas configured.' });
      return res.end();
    }

    const modeRules = MODE_RULES[mode];
    const history = Array.isArray(messages) ? messages : [];
    const recentBlock = formatRecent(history, RECENT_WINDOW);

    sseWrite(res, { type: 'status', message: `Updating table context (${mode})…` });
    let rollingSummary = await refreshSummary(resolved, model, {
      priorSummary: String(clientSummary || '').trim(),
      recentBlock,
      topic: topicText,
      mode,
      signal: controller.signal,
    });
    sseWrite(res, { type: 'summary', summary: rollingSummary });

    const roundSoFar = [];
    const master = (config.masterPrompt || '').trim();

    for (const persona of personas) {
      if (controller.signal.aborted) break;

      sseWrite(res, {
        type: 'speaker',
        personaId: persona.id,
        personaName: persona.name,
      });
      sseWrite(res, {
        type: 'status',
        message: `${persona.name} is speaking…`,
      });

      const personaPrompt = [master, persona.systemPrompt, modeRules]
        .filter((s) => typeof s === 'string' && s.trim())
        .join('\n\n');

      const roundBlock = roundSoFar.length
        ? roundSoFar.map((t) => `${t.name}: ${t.content}`).join('\n\n')
        : '(You speak first this round.)';

      const userPayload = [
        `GROUP DISCUSSION — topic: ${topicText}`,
        '',
        'Rolling summary of earlier discussion (previous ~10 messages condensed):',
        rollingSummary || '(Just starting.)',
        '',
        'This round so far (other personas already spoke):',
        roundBlock,
        '',
        `You are ${persona.name}. It is your turn at the table.`,
        'Speak in character. Do not narrate stage directions. Do not invent other speakers\' lines.',
      ].join('\n');

      let reply = '';
      try {
        reply = await callCompletion(
          resolved,
          model,
          [
            { role: 'system', content: personaPrompt },
            { role: 'user', content: userPayload },
          ],
          { maxTokens: MAX_TOKENS_PER_TURN, signal: controller.signal },
        );
      } catch (err) {
        const aborted = err?.name === 'AbortError' || controller.signal.aborted;
        sseWrite(res, {
          type: 'error',
          error: aborted
            ? 'Group round timed out.'
            : (err.message || 'Persona turn failed'),
          personaId: persona.id,
          personaName: persona.name,
        });
        // Skip this persona; continue the round if possible
        continue;
      }

      if (!reply) reply = '…';

      // Stream as one token chunk so the client can reuse streaming UI
      sseWrite(res, { type: 'token', text: reply, personaId: persona.id, personaName: persona.name });
      sseWrite(res, {
        type: 'turn',
        personaId: persona.id,
        personaName: persona.name,
        content: reply,
      });

      roundSoFar.push({ id: persona.id, name: persona.name, content: reply });
    }

    // Fold this round into the rolling summary for the next user message
    const roundAsMsgs = roundSoFar.map((t) => ({
      role: 'assistant',
      personaName: t.name,
      content: t.content,
    }));
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    const forSummary = [
      ...(lastUser ? [lastUser] : []),
      ...roundAsMsgs,
    ];
    rollingSummary = await refreshSummary(resolved, model, {
      priorSummary: rollingSummary,
      recentBlock: formatRecent(forSummary, RECENT_WINDOW),
      topic: topicText,
      mode,
      signal: controller.signal,
    });
    sseWrite(res, { type: 'summary', summary: rollingSummary });
    sseWrite(res, {
      type: 'done',
      summary: rollingSummary,
      turns: roundSoFar.length,
      provider: resolved.label,
      model,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    sseWrite(res, {
      type: 'error',
      error: aborted
        ? 'Group chat timed out.'
        : (err.message || 'Group chat failed'),
    });
  } finally {
    clearTimeout(timer);
    res.end();
  }
}
