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
 * SSE: status | speaker | token | turn | summary | done | error
 */

import { loadConfig } from '../lib/config.js';
import { fetchWithModelFallback } from '../lib/model-health.js';
import { resolveProvider, withProviderChatExtras } from '../lib/providers.js';
import { requirePaidAccess } from '../lib/model-meta.js';
import { searchWeb, formatSearchContext } from '../lib/websearch.js';
import { resolveOwner } from '../lib/hub.js';
import { recentTeamActions, formatTeamActions } from '../lib/team-log.js';

const UPSTREAM_TIMEOUT_MS = 90_000;
const MAX_PERSONAS = 12;
const RECENT_WINDOW = 10;
// 280 was cutting every persona off mid-sentence on anything longer than a
// couple sentences — group chat has no auto-continue like solo chat does,
// so a hit cap here is just a silently truncated reply, not a retry.
// 700 turned out to still be broken for any reasoning-tagged free model
// (confirmed live: apodex-1.1-mini, which burns its whole budget on hidden
// reasoning tokens before it ever starts the visible answer) — content
// comes back empty and the turn silently becomes "…". Solo chat gives a
// single model 8192; this is per-turn with up to MAX_PERSONAS speakers a
// round, so it stays well short of that, but needs real headroom for a
// reasoning model's invisible thinking pass plus an actual answer.
const MAX_TOKENS_PER_TURN = 2048;

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

  orchestrated: `MODE: ORCHESTRATED
- You are the lead on this round. Everyone else stays silent unless you bring them in.
- If someone else's specific expertise is actually needed, address them BY NAME directly
  in your reply (e.g. "Rook, can you check the auth flow on this?") — naming them pulls
  them into the round to respond next. Don't name someone just to be polite.
- If no one else needs to weigh in, answer fully yourself and stop there.
- Whoever you bring in can bring in someone else the same way, if they genuinely need to.
- 1–4 short paragraphs. Do not speak for other personas.`,
};

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function normalizeMode(raw) {
  const m = String(raw || '').toLowerCase().trim();
  if (m === 'boardroom' || m === 'board') return 'boardroom';
  if (m === 'brainstorm' || m === 'brainstorming') return 'brainstorm';
  if (m === 'freechat' || m === 'free' || m === 'free-chat') return 'freechat';
  if (m === 'orchestrated' || m === 'orchestrate' || m === 'lead') return 'orchestrated';
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

/**
 * Order personas by actual relevance to this topic, not a fixed config
 * order and not a blind shuffle — a persona whose expertise matches the
 * topic should lead; one whose expertise clearly doesn't should not be
 * forced to open (or fake authority it doesn't have). Falls back to
 * config order — never a random one — if the ranking call fails or
 * returns something that isn't a clean permutation of every persona.
 */
async function rankPersonasByRelevance(resolved, model, { topic, personas, recentBlock, signal }) {
  if (personas.length <= 1) return personas;
  const roster = personas
    .map((p) => `${p.id}: ${p.name} — ${(p.description || 'no stated specialty').slice(0, 200)}`)
    .join('\n');
  const prompt = [
    'You are seating a round-table discussion. Order these personas from',
    'MOST to LEAST relevant to speak on THIS SPECIFIC topic, based on their',
    'actual stated expertise below — not popularity, not seniority. The',
    'persona whose specialty genuinely matches the topic leads; a persona',
    'whose expertise clearly does not match (e.g. a comedy persona on a',
    'technical topic, or vice versa) should go later, not first.',
    '',
    `Topic: ${topic}`,
    recentBlock ? `Recent discussion so far:\n${recentBlock}` : '',
    '',
    'Personas (id: name — description):',
    roster,
    '',
    'Reply with ONLY a JSON array of persona ids, most relevant first, every',
    'id exactly once. No prose, no markdown fences, no explanation.',
  ].filter(Boolean).join('\n');

  try {
    const raw = await callCompletion(
      resolved,
      model,
      [
        { role: 'system', content: 'You output only a valid JSON array of strings, nothing else.' },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 200, signal, providerId: resolved.id },
    );
    const match = raw.match(/\[[\s\S]*\]/);
    const ids = match ? JSON.parse(match[0]) : null;
    if (!Array.isArray(ids)) throw new Error('not an array');
    const byId = new Map(personas.map((p) => [p.id, p]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    // A partial or hallucinated list would silently drop someone from the
    // round — only trust it when it's a clean permutation of everyone.
    if (ordered.length !== personas.length) throw new Error('incomplete ranking');
    return ordered;
  } catch {
    return personas;
  }
}

/**
 * Did this reply address another seated persona by name? Used to bump that
 * persona to speak next instead of sticking to the fixed relevance order —
 * the difference between a round-robin and a conversation that actually
 * responds to being asked something.
 */
function detectHandoff(replyText, currentPersona, remainingQueue) {
  if (!replyText || !remainingQueue.length) return null;
  let best = null;
  let bestIndex = Infinity;
  for (const p of remainingQueue) {
    const name = (p.name || '').trim();
    if (!name || name === currentPersona.name) continue;
    const tokens = [...new Set([name, name.split(/\s+/)[0]])].filter((t) => t.length > 1);
    for (const t of tokens) {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`\\b${escaped}\\b`, 'i').exec(replyText);
      if (match && match.index < bestIndex) {
        bestIndex = match.index;
        best = p.id;
      }
    }
  }
  return best;
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

// Group turns are short in-character lines — hidden reasoning only eats the
// token budget and leaves the visible reply empty. Ask providers to skip it.
function groupReasoningOff(body, providerId) {
  if (providerId === 'venice') {
    return { ...body, venice_parameters: { ...(body.venice_parameters || {}), disable_thinking: true } };
  }
  if (providerId === 'openrouter') {
    return { ...body, reasoning: { effort: 'low', exclude: true } };
  }
  return body;
}

async function callCompletionOnce(resolved, model, messages, { maxTokens, signal, providerId }) {
  // A persona whose model was retired still speaks — on the provider's current
  // chat model (lib/model-health.js) — instead of dropping out of the round.
  let modelReplaced = null;
  // Cap each call on its own. Without this, one hung model ate the whole
  // round's budget and every persona queued after it was dropped as "timed out".
  const callSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
    : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const fb = await fetchWithModelFallback({
    providerId: providerId || resolved.id,
    model,
    kind: 'chat',
    canUse: () => true,
    doFetch: (m) => fetch(resolved.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolved.apiKey}`,
        ...resolved.extraHeaders(),
      },
      body: JSON.stringify(groupReasoningOff(
        withProviderChatExtras(
          {
            model: m,
            messages,
            stream: false,
            max_tokens: maxTokens,
            temperature: 0.75,
          },
          providerId || resolved.id,
        ),
        providerId || resolved.id,
      )),
      signal: callSignal,
    }),
  });
  const upstream = fb.res;
  if (fb.replaced) { modelReplaced = fb.replaced; model = fb.model; }

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

  const choice = data.choices?.[0];
  return {
    modelReplaced,
    content: String(choice?.message?.content ?? '').trim(),
    truncated: choice?.finish_reason === 'length' || choice?.native_finish_reason === 'length',
  };
}

/**
 * A reasoning-tagged model can burn its ENTIRE max_tokens budget on hidden
 * "thinking" before it ever starts the visible answer — confirmed live:
 * apodex-1.1-mini hit finish_reason:"length" at 2048 tokens still mid
 * "Thinking Process:", content: null. Raising the default budget for every
 * call just to cover this tail case would slow down and cost more on every
 * normal turn. Instead: one retry, only when this exact failure shows up,
 * with real headroom — pays the extra cost/time only when it's needed.
 */
async function callCompletion(resolved, model, messages, opts) {
  const first = await callCompletionOnce(resolved, model, messages, opts);
  if (first.content) return first.content;
  if (!first.truncated) return ''; // genuinely empty reply, not a budget problem — let the '…' fallback handle it

  const retried = await callCompletionOnce(resolved, model, messages, { ...opts, maxTokens: 6000 });
  return retried.content;
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
    webSearch: wantWebSearch,
    webSearchQuery,
    personaIds,
    personaTasks = {},
    // Team brief for a meeting run by a named team (editable in the app).
    teamPrompt,
    // Orchestrated-only: pin a specific persona as lead instead of letting
    // rankPersonasByRelevance pick one. This is what turns Orchestrated mode
    // into "solo chat with a team behind it" — the persona you're actually
    // talking to stays the lead no matter what the topic is about.
    forcedLeadId,
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
  // Leave headroom under vercel.json's maxDuration (800s) so a stuck persona
  // gets aborted in time for the closing summary + `done` event to still go
  // out, instead of the platform killing the function mid-stream with no
  // `done` ever sent — which the client currently has no way to recover
  // from short of losing every remaining round.
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(UPSTREAM_TIMEOUT_MS * Math.min(MAX_PERSONAS + 2, 14), 750_000),
  );
  res.on('close', () => {
    if (!controller.signal.aborted) controller.abort();
  });

  try {
    const config = await loadConfig();
    // A caller can seat a subset (e.g. "just the marketing personas"); with
    // no list, every configured persona sits at the table as before.
    const wantedIds = Array.isArray(personaIds) ? personaIds.filter((id) => typeof id === 'string') : null;
    const roster = wantedIds && wantedIds.length
      ? (config.personas || []).filter((p) => wantedIds.includes(p.id))
      : (config.personas || []);
    const personas = roster.slice(0, MAX_PERSONAS);
    if (!personas.length) {
      sseWrite(res, { type: 'error', error: 'No personas configured.' });
      return res.end();
    }

    const modeRules = MODE_RULES[mode];
    const history = Array.isArray(messages) ? messages : [];
    const recentBlock = formatRecent(history, RECENT_WINDOW);
    const defaultModel = model || 'venice-uncensored';
    // The message each persona must actually answer this round, as opposed
    // to the table's standing topic, which can drift once the user follows
    // up with something narrower or different.
    const lastUser = [...history].reverse().find((m) => m.role === 'user');

    // Default query when a persona has no assigned task of its own.
    const fallbackQuery = (typeof webSearchQuery === 'string' && webSearchQuery.trim())
      || (lastUser?.content && String(lastUser.content).trim()) || topicText;

    // Fetch once for the round, not once per speaker — shared action log is
    // owner-level, not per-persona.
    let teamActionsBlock = '';
    try {
      const ownerId = await resolveOwner(req, res);
      if (ownerId) {
        teamActionsBlock = formatTeamActions(await recentTeamActions(ownerId));
      }
    } catch (err) {
      console.error('recentTeamActions failed:', err);
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
    const master = (config.masterPrompt || '').trim();

    const speakingOrder = await rankPersonasByRelevance(defaultResolved, defaultModel, {
      topic: topicText,
      personas,
      recentBlock,
      signal: controller.signal,
    });

    // Mutable queue so a persona who gets addressed by name mid-round can be
    // bumped to speak next, instead of waiting for a fixed relevance order —
    // this is what makes the table feel like it's actually listening.
    //
    // Orchestrated mode inverts the default: instead of everyone queued up
    // front, only the top-ranked persona (the lead) starts in the queue.
    // Everyone else sits in `summonPool` and only joins if the lead (or
    // whoever's speaking) names them directly — detected by the same
    // detectHandoff() the other modes use for reordering, just driving
    // whether someone speaks at all instead of only when they speak.
    const isOrchestrated = mode === 'orchestrated';
    const pinnedLead = isOrchestrated && typeof forcedLeadId === 'string'
      ? speakingOrder.find((p) => p.id === forcedLeadId)
      : null;
    const queue = isOrchestrated
      ? (pinnedLead ? [pinnedLead] : speakingOrder.slice(0, 1))
      : speakingOrder.slice();
    const summonPool = isOrchestrated
      ? speakingOrder.filter((p) => !queue.some((q) => q.id === p.id))
      : [];
    const calledOnBy = new Map(); // personaId -> name of whoever just addressed them
    // Models the provider said don't exist, learned this round. Every later
    // persona on the same model goes straight to the fallback — no wasted call.
    const goneModels = new Set();

    while (queue.length) {
      if (controller.signal.aborted) break;
      const persona = queue.shift();

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

      if (goneModels.has(turnModel) && turnModel !== defaultModel) {
        turnResolved = defaultResolved;
        turnModel = defaultModel;
        turnProviderId = defaultResolved.id;
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

      // Each persona with an assigned task searches on THAT task, not the
      // shared topic — real evidence differences, not just prose disagreement.
      const task = typeof personaTasks?.[persona.id] === 'string' ? personaTasks[persona.id].trim() : '';
      let searchContext = '';
      let personaSources = [];
      if (wantWebSearch) {
        const query = task || fallbackQuery;
        try {
          personaSources = await searchWeb(query);
          searchContext = formatSearchContext(query, personaSources);
        } catch (err) {
          sseWrite(res, {
            type: 'status',
            message: `${persona.name}: web search skipped: ${err.message}`,
          });
        }
      }

      const teamBrief = typeof teamPrompt === 'string' && teamPrompt.trim()
        ? `TEAM BRIEF (how this team works together):\n${teamPrompt.trim().slice(0, 4000)}`
        : '';
      const personaPrompt = [master, persona.systemPrompt, teamBrief, modeRules, teamActionsBlock, searchContext]
        .filter((s) => typeof s === 'string' && s.trim())
        .join('\n\n');

      const roundBlock = roundSoFar.length
        ? roundSoFar.map((t) => `${t.name}: ${t.content}`).join('\n\n')
        : '(No one else has spoken yet this round.)';

      // The table's standing topic frames the discussion, but the thing each
      // persona must actually answer is whatever the user just said — which
      // can drift from (or be a follow-up narrower than) that original topic.
      // Burying it inside the rolling summary let personas keep re-answering
      // the opening topic verbatim instead of the latest question.
      const latestUserMessage = (lastUser?.content && String(lastUser.content).trim()) || topicText;

      const userPayload = [
        `GROUP DISCUSSION — standing topic: ${topicText}`,
        '',
        'Rolling summary of earlier discussion (previous ~10 messages condensed):',
        rollingSummary || '(Just starting.)',
        '',
        'What others have said so far this round (context only — not a script to follow):',
        roundBlock,
        '',
        'THE USER JUST SAID THIS — answer it directly, not the standing topic in general:',
        latestUserMessage,
        '',
        `You are ${persona.name}. Respond to the user's message above, from your own`,
        'perspective — do not just summarize or react to what others already said. Bring',
        'a point they haven\'t made, or push back with a reason if you actually disagree.',
        'Speaking order is seated by who is actually relevant to this topic, not',
        'turn-taking, so do not assume you are "first" or "last" for form\'s sake. If this',
        'genuinely falls outside what you\'d actually know or care about, say so briefly',
        'and give whatever honest, limited perspective you do have — do not fake expertise',
        'you don\'t have. Speak in character. Do not narrate stage directions. Do not',
        'invent other speakers\' lines.',
        task ? `\nYour assigned task this round: ${task}\nWork that task specifically — don't just give a generic take on the topic.` : '',
        calledOnBy.has(persona.id)
          ? `\n${calledOnBy.get(persona.id)} just addressed you directly — respond to them specifically, by name, before anything else.`
          : '',
      ].filter(Boolean).join('\n');

      // One retry per persona on a thrown error (HTTP 4xx/5xx, per-call
      // timeout, network) or an empty reply, so a single flaky call doesn't
      // silently cost the table a speaker. If both attempts fail, the persona
      // is reported by name with the real reason and the round moves on.
      let reply = '';
      let lastError = '';
      for (let attempt = 1; attempt <= 2 && !reply; attempt++) {
        if (controller.signal.aborted) break;
        if (attempt > 1) {
          sseWrite(res, { type: 'status', message: `${persona.name}: retrying (${lastError})…` });
        }
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
          if (!reply) lastError = 'empty reply';
        } catch (err) {
          if (controller.signal.aborted) break;
          // Provider retired or renamed this persona's saved model (seen live:
          // Venice dropped e2ee-venice-uncensored-24b-p). Don't lose the
          // speaker over it: retry on the chat's own model instead.
          const modelGone = /model not found|model .*does not exist|unknown model|invalid model|no endpoints found|not a valid model/i
            .test(String(err?.message || ''));
          if (modelGone && turnModel !== defaultModel) {
            sseWrite(res, {
              type: 'status',
              message: `${persona.name}: ${turnModel} is no longer available — using ${defaultModel}.`,
            });
            console.error(`group-chat persona ${persona.id}: ${turnModel} gone, falling back to ${defaultModel}`);
            goneModels.add(turnModel);
            turnResolved = defaultResolved;
            turnModel = defaultModel;
            turnProviderId = defaultResolved.id;
            lastError = 'model no longer available';
            attempt -= 1; // the fallback gets its own two tries
            continue;
          }
          const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
          lastError = timedOut
            ? `no response in ${UPSTREAM_TIMEOUT_MS / 1000}s`
            : (err.message || 'request failed');
          console.error(`group-chat persona ${persona.id} (${turnModel}) attempt ${attempt}:`, lastError);
        }
      }

      if (!reply) {
        sseWrite(res, {
          type: 'error',
          error: controller.signal.aborted
            ? 'Group round timed out.'
            : `${persona.name} (${turnModel}) failed twice: ${lastError}`,
          personaId: persona.id,
          personaName: persona.name,
        });
        if (controller.signal.aborted) break;
        continue;
      }

      // Did this reply call on someone specific? In orchestrated mode that's
      // the ONLY way anyone else gets seated this round — search the summon
      // pool (everyone who hasn't spoken) and pull them in. In every other
      // mode everyone's queued already; this just bumps them to speak next
      // instead of three turns later.
      const handoffSearchPool = isOrchestrated ? summonPool : queue;
      const handoffId = detectHandoff(reply, persona, handoffSearchPool);
      if (handoffId) {
        const idx = handoffSearchPool.findIndex((p) => p.id === handoffId);
        if (idx > -1) {
          const [bumped] = handoffSearchPool.splice(idx, 1);
          queue.unshift(bumped);
          calledOnBy.set(bumped.id, persona.name);
        }
      }

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
        sources: personaSources.length ? personaSources : undefined,
        task: task || undefined,
      });

      roundSoFar.push({
        id: persona.id,
        name: persona.name,
        content: reply,
        provider: turnProviderId,
        model: turnModel,
      });
    }

    // Wrap-up: turn the round into one concrete, actionable takeaway instead
    // of leaving the user to read N replies and infer it themselves. Skipped
    // when only one persona spoke — nothing to synthesize.
    if (roundSoFar.length > 1 && !controller.signal.aborted) {
      sseWrite(res, {
        type: 'speaker',
        personaId: '_synthesis',
        personaName: 'Wrap-up',
        provider: defaultResolved.label,
        model: defaultModel,
      });
      sseWrite(res, { type: 'status', message: 'Summarizing into one action item…' });

      const synthesisUserMessage = (lastUser?.content && String(lastUser.content).trim()) || topicText;
      const synthesisPrompt = [
        'You are the team lead closing out this round. Read what everyone said and',
        'produce ONE concrete, actionable takeaway — not a recap of who said what.',
        'If the group reached a decision, state it plainly and say what happens next',
        '(a draft to post, an email to send, a next step, an open question that',
        'still needs the user\'s call). If they genuinely did not converge, say that',
        'plainly and name the real disagreement instead of papering over it.',
        'Max 120 words. No preamble like "Here is the summary". Speak directly.',
        '',
        `Topic: ${topicText}`,
        `The user asked: ${synthesisUserMessage}`,
        '',
        'What was said this round:',
        roundSoFar.map((t) => `${t.name}: ${t.content}`).join('\n\n'),
      ].join('\n');

      let synthesis = '';
      try {
        synthesis = await callCompletion(
          defaultResolved,
          defaultModel,
          [
            { role: 'system', content: 'You write terse, decisive wrap-ups for a multi-persona team discussion.' },
            { role: 'user', content: synthesisPrompt },
          ],
          { maxTokens: 220, signal: controller.signal, providerId: defaultResolved.id },
        );
      } catch {
        synthesis = '';
      }

      if (synthesis) {
        sseWrite(res, {
          type: 'token',
          text: synthesis,
          personaId: '_synthesis',
          personaName: 'Wrap-up',
          provider: defaultResolved.label,
          model: defaultModel,
        });
        sseWrite(res, {
          type: 'turn',
          personaId: '_synthesis',
          personaName: 'Wrap-up',
          content: synthesis,
          provider: defaultResolved.label,
          model: defaultModel,
        });
        roundSoFar.push({
          id: '_synthesis',
          name: 'Wrap-up',
          content: synthesis,
          provider: defaultResolved.id,
          model: defaultModel,
        });
      }
    }

    // Fold this round into the rolling summary for the next user message
    const roundAsMsgs = roundSoFar.map((t) => ({
      role: 'assistant',
      personaName: t.name,
      content: t.content,
    }));
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
