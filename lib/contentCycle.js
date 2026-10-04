// Content engine: a short, structured debate between a client's personas that
// produces ranked post drafts and places them on the client's schedule.
//
//   Round 1  every persona proposes post ideas (with finished copy)
//   Round 2  every persona scores the OTHER personas' ideas 1-10 with a critique
//   Rank     mean score, duplicates and repeats of recent posts removed
//   Place    top N become drafts in the client's next open time slots
//
// `llm` is injected: async ({ system, user }) => string. That keeps this file
// testable with a stub and independent of any one model provider.

const MAX_PERSONAS = 6;
const IDEAS_PER_PERSONA = 2;

// --- time helpers (client-local schedule) --------------------------------

/** Local weekday/hour for an instant in an IANA timezone. */
export function localParts(ms, timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    day,
    hour: Number(get('hour')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/**
 * The next `count` schedule slots after `now` that no existing draft already
 * occupies. Walks hour boundaries, so it is correct across DST changes.
 */
export function nextSlots(client, count, now = Date.now(), horizonDays = 21) {
  const { slots } = client.state.schedule;
  const tz = client.state.timezone;
  const taken = new Set(
    client.state.drafts
      .filter((d) => d.scheduledFor && !['rejected', 'expired', 'failed'].includes(d.status))
      .map((d) => Math.floor(Date.parse(d.scheduledFor) / 3600000)),
  );
  const out = [];
  let t = (Math.floor(now / 3600000) + 1) * 3600000;
  for (let i = 0; i < horizonDays * 24 && out.length < count; i++, t += 3600000) {
    const { day, hour } = localParts(t, tz);
    if (!slots.some((s) => s.day === day && s.hour === hour)) continue;
    if (taken.has(t / 3600000)) continue;
    out.push(new Date(t).toISOString());
  }
  return out;
}

// --- parsing -------------------------------------------------------------

/** Pull the first JSON array/object out of a model reply (tolerates code fences). */
export function parseJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) return null;
  const open = cleaned[start];
  const close = open === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}

function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

// --- prompts -------------------------------------------------------------

function personaSystem(client, persona) {
  return [
    `You are ${persona.name}, a member of the content team for "${client.state.name}".`,
    persona.voice ? `Your voice and priorities: ${persona.voice}` : '',
    client.state.brief ? `About the business:\n${client.state.brief}` : '',
    'Write honest, useful social posts. Do not invent prices, offers, statistics, awards or customer quotes. ' +
      'No misleading claims, no engagement-bait tricks, no hashtags spam (max 3 relevant hashtags).',
  ].filter(Boolean).join('\n\n');
}

function recentContext(client, now) {
  const recent = client.postsSince(now - 30 * 86400000).slice(-12).map((p) => `- ${p.text.slice(0, 140)}`);
  const rejected = client.state.rejectedIdeas.slice(-10).map((r) => `- ${r.idea}${r.reason ? ` (${r.reason})` : ''}`);
  return [
    recent.length ? `Recent posts (do not repeat these):\n${recent.join('\n')}` : '',
    rejected.length ? `Ideas the client already rejected (avoid):\n${rejected.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

// --- the cycle -----------------------------------------------------------

export async function runContentCycle(client, { llm, now = Date.now(), count, reason = 'scheduled' } = {}) {
  if (typeof llm !== 'function') throw new Error('runContentCycle needs an llm function');
  const personas = client.state.personas.slice(0, MAX_PERSONAS);
  if (!personas.length) return { created: [], ranking: [], note: 'no personas configured' };

  const want = Math.max(1, count || client.settings.contentBatchSize);
  const context = recentContext(client, now);
  const angle = reason === 'engagement_drop'
    ? 'Engagement has dropped recently. Propose fresher angles: questions, behind-the-scenes, customer-useful tips, timely hooks.'
    : 'Propose posts that fit the next two weeks of the schedule.';

  // Round 1: proposals
  const proposalRuns = await Promise.allSettled(personas.map(async (p) => {
    const reply = await llm({
      system: personaSystem(client, p),
      user: `${angle}\n\n${context}\n\nPropose ${IDEAS_PER_PERSONA} distinct post ideas. ` +
        'Reply with ONLY a JSON array: [{"idea": "one line", "text": "the finished post copy"}]',
    });
    const arr = parseJson(reply);
    return (Array.isArray(arr) ? arr : [])
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .slice(0, IDEAS_PER_PERSONA)
      .map((x) => ({ idea: String(x.idea || x.text).slice(0, 200), text: x.text.trim().slice(0, 2200), personaId: p.id }));
  }));
  let proposals = proposalRuns.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  // Drop near-duplicates of recent posts and of each other.
  const recentTexts = client.postsSince(now - 30 * 86400000).map((p) => p.text);
  const kept = [];
  for (const prop of proposals) {
    const dupe = recentTexts.some((t) => similarity(t, prop.text) > 0.7) ||
      kept.some((k) => similarity(k.text, prop.text) > 0.7);
    if (!dupe) kept.push(prop);
  }
  proposals = kept;
  if (!proposals.length) return { created: [], ranking: [], note: 'no usable proposals' };

  // Round 2: each persona critiques the others' proposals
  proposals.forEach((p, i) => { p.n = i; p.scores = []; p.critiques = []; });
  if (personas.length > 1) {
    const reviews = await Promise.allSettled(personas.map(async (judge) => {
      const others = proposals.filter((p) => p.personaId !== judge.id);
      if (!others.length) return [];
      const list = others.map((p) => `#${p.n}: ${p.text}`).join('\n\n');
      const reply = await llm({
        system: personaSystem(client, judge),
        user: `Score each proposed post from 1 (weak) to 10 (strong) for this business: clarity, usefulness to the audience, brand fit, honesty.\n\n${list}\n\n` +
          'Reply with ONLY a JSON array: [{"n": 0, "score": 7, "critique": "one sentence"}]',
      });
      return Array.isArray(parseJson(reply)) ? parseJson(reply) : [];
    }));
    for (const r of reviews) {
      if (r.status !== 'fulfilled') continue;
      for (const row of r.value) {
        const target = proposals[row?.n];
        const score = Number(row?.score);
        if (target && Number.isFinite(score)) {
          target.scores.push(Math.min(10, Math.max(1, score)));
          if (row.critique) target.critiques.push(String(row.critique).slice(0, 200));
        }
      }
    }
  }

  const ranked = proposals
    .map((p) => ({ ...p, score: p.scores.length ? p.scores.reduce((a, b) => a + b, 0) / p.scores.length : 5 }))
    .sort((a, b) => b.score - a.score);

  // Place the winners on open schedule slots.
  const slots = nextSlots(client, want, now);
  const created = ranked.slice(0, Math.min(want, slots.length)).map((p, i) =>
    client.addDraft({ text: p.text, idea: p.idea, personaId: p.personaId, score: p.score, scheduledFor: slots[i] }));

  client.state.lastContentCycleAt = new Date(now).toISOString();
  await client.save();

  return {
    created,
    ranking: ranked.map((p) => ({ idea: p.idea, score: Number(p.score.toFixed(2)), personaId: p.personaId })),
    note: created.length < want ? `only ${created.length} open schedule slots` : undefined,
  };
}
