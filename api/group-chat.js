/**
 * POST /api/group-chat  (SSE — maxDuration: 300)
 *
 * Round-table discussion with ALL personas. Client picks a mode + topic,
 * then each user message triggers one speaking round (every persona once).
 *
 * Each persona may use its own provider/model via `personaModels`.
 * Context stays small: each speaker gets a rolling summary of the previous
 * ~10 messages plus what others already said this round — not the full history.
 *
 * Modes:
 *   boardroom  — fully serious
 *   brainstorm — serious about the work, jokes allowed
 *   freechat   — anything goes
 *
 * A round produces speeches, never an outcome. `phase: 'verdict'` is the other
 * thing a table needs: every persona files a position, then a chair reports
 * what those positions add up to — including, honestly, that they add up to no
 * consensus at all.
 *
 * SSE: status | speaker | token | turn | summary | done | error
 *      verdict phase: status | position | verdict | done | error
 */

import { loadConfig } from '../lib/config.js';
import { resolveProvider, withProviderChatExtras } from '../lib/providers.js';
import { requirePaidAccess } from '../lib/model-meta.js';

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

function pickKey(providerKeys, providerId, fallbackKey) {
  const map = providerKeys && typeof providerKeys === 'object' ? providerKeys : {};
  const fromMap = typeof map[providerId] === 'string' ? map[providerId].trim() : '';
  if (fromMap) return fromMap;
  return typeof fallbackKey === 'string' ? fallbackKey : '';
}

function resolveForPersona(personaModels, personaId, defaultProvider, defaultModel, providerKeys, fallbackKey) {
  const map = personaModels && typeof personaModels === 'object' ? personaModels : {};
  const assigned = map[personaId] && typeof map[personaId] === 'object' ? map[personaId] : {};
  const providerId = assigned.provider || defaultProvider || 'venice';
  const model = assigned.model || defaultModel;
  const apiKey = pickKey(providerKeys, providerId, fallbackKey);
  const resolved = resolveProvider(providerId, apiKey);
  return { resolved, model, providerId };
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
          temperature: 0.75,
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
      { maxTokens: 220, signal, providerId: resolved.id },
    );
  } catch {
    // Fallback: keep prior + truncate recent if summarizer fails
    const fallback = [priorSummary, recentBlock].filter(Boolean).join('\n').slice(0, 1200);
    return fallback || priorSummary || '';
  }
}


// ---- Calling the question -------------------------------------------------
// A round produces speeches; it never produces an outcome. The rolling
// summary is not one either — it exists to keep the next round's prompt
// small, and it reports "key disagreements" precisely because it is not
// trying to resolve them.
//
// So the verdict is a poll, not a summary. Every persona files a position of
// its own first, and only then does a chair report what those positions add
// up to. Asking one model to describe the mood of the table would give an
// answer that sounds like consensus without anyone having agreed to anything,
// which is the failure mode worth spending an extra pass to avoid.

const POSITION_RULES = `The chair has called the question. You are not making another speech — you
are filing your position for the record, as JSON.

Return JSON: { "stance": "...", "agree": "...", "blocker": "...", "confidence": 0 }

STANCE: in one sentence, what you think the table should actually conclude or
do. Commit to something. "It depends" is not a stance — say what it depends on,
then pick.
AGREE: in one sentence, the part of this discussion you consider settled and
back. "" if you honestly think nothing is settled yet.
BLOCKER: in one sentence, the one thing you cannot accept and would argue
against if the table adopted it. "" if you have none — do not invent one to
look rigorous.
CONFIDENCE: an integer 0-100, how sure you are of your own stance. Be honest; a
low number is real information to the chair.

Stay in character. This is your position, not a summary of everyone else's.`;

const CHAIR_RULES = `You are the chair of a round table. Every member has filed a written position.
You have no vote and add no opinion of your own — you report what the filed
positions actually say.

Return JSON:
{ "consensus": "unanimous" | "strong" | "split" | "none",
  "decision": "...", "agreed": [], "disagreed": [], "nextStep": "..." }

CONSENSUS — judge from the stances as filed, never from tone or politeness:
  unanimous  every stance points the same way and no blocker is unresolved.
  strong     a clear majority agrees and the remaining blockers are minor.
  split      the table divides into camps of comparable weight.
  none       no shared position — members are answering different questions, or
             every stance carries a blocker against the others.
DECISION: what the table actually concluded, in one or two sentences. If
consensus is "split" or "none", say plainly that no conclusion was reached and
name the fault line. Do not invent a middle position nobody filed.
AGREED: the specific points genuinely backed across positions, as short
strings. An empty array is a correct and useful answer.
DISAGREED: the specific points still contested, each written so a reader can
tell who is on which side. Short strings.
NEXT STEP: the single thing that would move this forward — the question to
settle, the missing information, the person to ask. One sentence.

Never report agreement that is not in the positions. An honest "no consensus"
is the answer that helps; a manufactured one is worse than nothing.`;

const CONSENSUS_LABELS = {
  unanimous: 'Unanimous',
  strong: 'Strong majority',
  split: 'Split table',
  none: 'No consensus',
};

/** Salvage JSON the way lib/hub.js does: not every model honours a schema. */
function parseLoose(raw) {
  const cleaned = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function clampConfidence(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/** One persona's filed position. */
async function filePosition(persona, ctx) {
  const { resolved, model, providerId } = resolveForPersona(
    ctx.personaModels,
    persona.id,
    ctx.defaultProviderId,
    ctx.defaultModel,
    ctx.providerKeys,
    ctx.clientKeyStr,
  );

  const system = [ctx.master, persona.systemPrompt, ctx.modeRules, POSITION_RULES]
    .filter((s) => typeof s === 'string' && s.trim())
    .join('\n\n');

  const user = [
    `GROUP DISCUSSION — topic: ${ctx.topicText}`,
    '',
    'The discussion so far, condensed:',
    ctx.rollingSummary || '(Only just started.)',
    '',
    ctx.recentBlock ? `The most recent exchanges:\n${ctx.recentBlock}` : '',
    '',
    `You are ${persona.name}. File your position.`,
  ]
    .filter((l) => l !== false && l != null)
    .join('\n');

  const raw = await callCompletion(
    resolved,
    model,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 320, signal: ctx.signal, providerId: providerId || resolved.id },
  );

  const out = parseLoose(raw) || {};
  const stance = String(out.stance || '').trim();
  // A position with no stance is not a position; it would show up in the tally
  // as a silent vote for whatever the chair already leaned towards.
  if (!stance) throw new Error(`${persona.name} filed no stance.`);

  return {
    personaId: persona.id,
    personaName: persona.name,
    stance,
    agree: String(out.agree || '').trim(),
    blocker: String(out.blocker || '').trim(),
    confidence: clampConfidence(out.confidence),
    model,
    provider: resolved.label,
  };
}

/** What the filed positions add up to, reported by a chair with no vote. */
async function chairVerdict(positions, ctx) {
  const filed = positions
    .map((p, i) => {
      const bits = [
        `${i + 1}. ${p.personaName}`,
        `   stance: ${p.stance}`,
        p.agree ? `   agrees: ${p.agree}` : '   agrees: (nothing stated)',
        p.blocker ? `   blocker: ${p.blocker}` : '   blocker: (none)',
        p.confidence != null ? `   confidence: ${p.confidence}/100` : '   confidence: (not given)',
      ];
      return bits.join('\n');
    })
    .join('\n\n');

  const user = [
    `TOPIC: ${ctx.topicText}`,
    '',
    'Discussion so far, condensed:',
    ctx.rollingSummary || '(Only just started.)',
    '',
    `FILED POSITIONS (${positions.length}):`,
    filed,
    '',
    'Report what these positions add up to.',
  ].join('\n');

  const raw = await callCompletion(
    ctx.defaultResolved,
    ctx.defaultModel,
    [
      { role: 'system', content: CHAIR_RULES },
      { role: 'user', content: user },
    ],
    { maxTokens: 700, signal: ctx.signal, providerId: ctx.defaultResolved.id },
  );

  const out = parseLoose(raw) || {};
  const level = String(out.consensus || '').toLowerCase().trim();
  const strings = (v) =>
    (Array.isArray(v) ? v : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .slice(0, 8);

  return {
    // An unrecognised level is reported as "none" rather than guessed at:
    // claiming consensus the chair did not actually name is the one error
    // this whole phase exists to prevent.
    consensus: CONSENSUS_LABELS[level] ? level : 'none',
    consensusLabel: CONSENSUS_LABELS[level] || CONSENSUS_LABELS.none,
    decision: String(out.decision || '').trim() || 'The chair could not read a conclusion from the filed positions.',
    agreed: strings(out.agreed),
    disagreed: strings(out.disagreed),
    nextStep: String(out.nextStep || '').trim(),
  };
}

/**
 * The verdict phase. Positions are filed in parallel — each is an independent
 * statement that does not react to the others, and twelve of them in series
 * would not fit the function's 300s budget.
 */
async function runVerdictPhase(res, ctx) {
  sseWrite(res, {
    type: 'status',
    message: `Calling the question · polling ${ctx.personas.length} personas…`,
  });

  const settled = await Promise.allSettled(
    ctx.personas.map(async (persona) => {
      const position = await filePosition(persona, ctx);
      sseWrite(res, { type: 'position', ...position });
      return position;
    }),
  );

  const positions = [];
  for (const [i, r] of settled.entries()) {
    if (r.status === 'fulfilled') {
      positions.push(r.value);
      continue;
    }
    const persona = ctx.personas[i];
    const aborted = r.reason?.name === 'AbortError' || ctx.signal.aborted;
    sseWrite(res, {
      type: 'error',
      error: aborted
        ? `${persona.name} timed out before filing a position.`
        : (r.reason?.message || `${persona.name} could not file a position.`),
      personaId: persona.id,
      personaName: persona.name,
    });
  }

  if (!positions.length) {
    sseWrite(res, { type: 'error', error: 'No positions were filed, so there is nothing to tally.' });
    return;
  }

  sseWrite(res, { type: 'status', message: 'Reading the tally…' });
  const verdict = await chairVerdict(positions, ctx);

  sseWrite(res, {
    type: 'verdict',
    ...verdict,
    positions,
    // Named so the client can say "9 of 12 filed" rather than implying the
    // whole table was polled when three of them failed.
    filed: positions.length,
    polled: ctx.personas.length,
  });
  sseWrite(res, {
    type: 'done',
    summary: ctx.rollingSummary,
    verdict: { ...verdict, positions, filed: positions.length, polled: ctx.personas.length },
    turns: positions.length,
    expectedTurns: ctx.personas.length,
    provider: ctx.defaultResolved.label,
    model: ctx.defaultModel,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Provider-Key, X-Paid-Password');
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
    personaModels = {},
    providerKeys = {},
    phase: rawPhase,
  } = req.body || {};

  const phase = String(rawPhase || 'round').toLowerCase() === 'verdict' ? 'verdict' : 'round';

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

  // Gate default + every per-persona paid model before starting the round.
  const paidChecks = [
    { provider: providerId || 'venice', model: model || 'venice-uncensored' },
    ...Object.values(personaModels || {}).map((a) => ({
      provider: a?.provider || providerId || 'venice',
      model: a?.model || model || 'venice-uncensored',
    })),
  ];
  for (const check of paidChecks) {
    const paidGate = requirePaidAccess(req, check.provider, check.model);
    if (paidGate) {
      sseWrite(res, { type: 'error', error: paidGate.error, paidLocked: true });
      return res.end();
    }
  }

  let defaultResolved;
  try {
    defaultResolved = resolveProvider(providerId || 'venice', clientKeyStr);
  } catch (err) {
    sseWrite(res, { type: 'error', error: err.message || 'Provider not configured' });
    return res.end();
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS * Math.min(MAX_PERSONAS + 2, 14),
  );
  res.on('close', () => {
    if (!controller.signal.aborted) controller.abort();
  });

  try {
    const config = await loadConfig();
    // All configured personas sit at the table (hard cap for latency/cost).
    const personas = (config.personas || []).slice(0, MAX_PERSONAS);
    if (!personas.length) {
      sseWrite(res, { type: 'error', error: 'No personas configured.' });
      return res.end();
    }

    const modeRules = MODE_RULES[mode];
    const history = Array.isArray(messages) ? messages : [];
    const recentBlock = formatRecent(history, RECENT_WINDOW);
    const defaultModel = model || 'venice-uncensored';

    const master = (config.masterPrompt || '').trim();

    // Calling the question ends here: it polls the table rather than running
    // another speaking round, so none of the turn loop below applies to it.
    //
    // It also skips the summary refresh. The client's summary was written at
    // the end of the last round and the raw recent messages go to every
    // persona anyway, so re-summarising would buy nothing and spend one of
    // the three sequential model calls this phase can afford inside the
    // function's 300s budget — a poll plus a chair pass is already two.
    if (phase === 'verdict') {
      sseWrite(res, {
        type: 'status',
        message: `Calling the question (${mode}) · ${personas.length} at the table…`,
      });
      await runVerdictPhase(res, {
        rollingSummary: String(clientSummary || '').trim(),
        personas,
        master,
        modeRules,
        topicText,
        recentBlock,
        personaModels,
        providerKeys,
        clientKeyStr,
        defaultProviderId: providerId || 'venice',
        defaultModel,
        defaultResolved,
        signal: controller.signal,
      });
      return;
    }

    sseWrite(res, {
      type: 'status',
      message: `Updating table context (${mode}) · ${personas.length} personas…`,
    });
    let rollingSummary = await refreshSummary(defaultResolved, defaultModel, {
      priorSummary: String(clientSummary || '').trim(),
      recentBlock,
      topic: topicText,
      mode,
      signal: controller.signal,
    });
    sseWrite(res, { type: 'summary', summary: rollingSummary });

    const roundSoFar = [];

    for (const persona of personas) {
      if (controller.signal.aborted) break;

      let turnResolved;
      let turnModel;
      let turnProviderId;
      try {
        ({
          resolved: turnResolved,
          model: turnModel,
          providerId: turnProviderId,
        } = resolveForPersona(
          personaModels,
          persona.id,
          providerId || 'venice',
          defaultModel,
          providerKeys,
          clientKeyStr,
        ));
      } catch (err) {
        sseWrite(res, {
          type: 'error',
          error: err.message || `No API key for ${persona.name}`,
          personaId: persona.id,
          personaName: persona.name,
        });
        continue;
      }

      sseWrite(res, {
        type: 'speaker',
        personaId: persona.id,
        personaName: persona.name,
        provider: turnResolved.label,
        model: turnModel,
      });
      sseWrite(res, {
        type: 'status',
        message: `${persona.name} is speaking (${turnResolved.label} · ${turnModel})…`,
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
          turnResolved,
          turnModel,
          [
            { role: 'system', content: personaPrompt },
            { role: 'user', content: userPayload },
          ],
          {
            maxTokens: MAX_TOKENS_PER_TURN,
            signal: controller.signal,
            providerId: turnProviderId || turnResolved.id,
          },
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
      sseWrite(res, {
        type: 'token',
        text: reply,
        personaId: persona.id,
        personaName: persona.name,
        provider: turnResolved.label,
        model: turnModel,
      });
      sseWrite(res, {
        type: 'turn',
        personaId: persona.id,
        personaName: persona.name,
        content: reply,
        provider: turnResolved.label,
        model: turnModel,
      });

      roundSoFar.push({
        id: persona.id,
        name: persona.name,
        content: reply,
        provider: turnProviderId,
        model: turnModel,
      });
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
    rollingSummary = await refreshSummary(defaultResolved, defaultModel, {
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
      expectedTurns: personas.length,
      provider: defaultResolved.label,
      model: defaultModel,
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
