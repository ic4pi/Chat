// Campaign engine — the in-app port of agency-engine/black_ops_engine.py.
//
//   conversation ─► brief (product, audience, offer, the user's own facts)
//               ─► proven hooks from memory (pgvector, per owner)
//               ─► strategist ─► editor ─► score ≥ threshold? ── yes ─► adapt to every platform at once
//                      ▲                          │ no
//                      └──── editor's fixes ◄─────┘   (maxRevisions, then best draft + what's still wrong)
//
// Pure: every model call goes through the injected `complete(messages, opts)`,
// so this runs the same against any provider and against a fake in tests.

export const PLATFORMS = {
  x: { label: 'X', maxChars: 280, rules: 'One punch, one post, no thread. At most 2 hashtags.' },
  linkedin: {
    label: 'LinkedIn', maxChars: 1300,
    rules: "First line must land before the 'see more' fold (under 140 chars). Short paragraphs. At most 3 hashtags at the end.",
  },
  instagram: { label: 'Instagram', maxChars: 1000, rules: 'First line stops the scroll. Caption only. Up to 5 hashtags at the end.' },
  facebook: { label: 'Facebook', maxChars: 500, rules: 'Conversational, two to four short lines, no hashtags.' },
  tiktok: { label: 'TikTok', maxChars: 600, rules: 'A 20-30 second spoken script: hook in the first 2 seconds, then proof, then CTA.' },
  email: { label: 'Email', maxChars: 1500, rules: "First line is 'Subject: ...' (under 50 chars). Then a plain-text body. One CTA." },
};

export const DEFAULT_PLATFORMS = ['x', 'linkedin', 'instagram', 'email'];

const PLATFORM_ALIASES = [
  [/\b(?:x|twitter|tweets?)\b/i, 'x'],
  [/\blinked\s?in\b/i, 'linkedin'],
  [/\b(?:instagram|insta|ig)\b/i, 'instagram'],
  [/\b(?:facebook|fb)\b/i, 'facebook'],
  [/\btik\s?tok\b/i, 'tiktok'],
  [/\b(?:e-?mails?|newsletter)\b/i, 'email'],
];

/** Platforms named in plain words ("for twitter and linkedin"), in PLATFORMS order. */
export function platformsFromText(text) {
  const found = new Set();
  for (const [re, id] of PLATFORM_ALIASES) if (re.test(String(text || ''))) found.add(id);
  return Object.keys(PLATFORMS).filter((p) => found.has(p));
}

// ── grounding: invented figures and fluff ─────────────────────────────────

// Percentages, multipliers, money, k/m/b counts, and any number of 10 or more.
const FIGURE_RE = /\$\s?\d[\d,]*(?:\.\d+)?[kmb]?|\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|[kmb]\b|\+)?/gi;

function normFigure(s) {
  return s.replace(/[\s,]/g, '').toLowerCase().replace(/\.$/, '');
}

function figures(text) {
  const out = [];
  for (const m of String(text || '').matchAll(FIGURE_RE)) {
    const tok = m[0].trim();
    // "3 steps" is structure and "in 2026" is a date — neither is a claim.
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (n < 10 || (n >= 1900 && n <= 2100)) continue;
    }
    out.push(tok);
  }
  return out;
}

/** Figures in `text` that appear in none of `sources`. */
export function unsupportedFigures(text, sources) {
  const allowed = new Set(sources.flatMap((s) => figures(s).map(normFigure)));
  return [...new Set(figures(text).filter((f) => !allowed.has(normFigure(f))))].sort();
}

const FLUFF_RE = new RegExp([
  'game[- ]changer', '\\bunlock', '\\belevate', '\\bseamless', 'cutting[- ]edge', '\\brevolutioni[sz]e',
  '\\bsynerg', '\\bleverage', "in today'?s", 'fast[- ]paced', 'world[- ]class', 'best[- ]in[- ]class',
  'next level', '\\bempower', '\\brobust', '\\binnovative', '\\bjourney\\b', '\\bdelve', 'look no further',
  '\\bsupercharge', '\\bunleash', '\\bholistic', '\\bparadigm', 'take .{1,20} to the next',
].join('|'), 'gi');

export function findFluff(text) {
  return [...new Set([...String(text || '').matchAll(FLUFF_RE)].map((m) => m[0].toLowerCase()))].sort();
}

// ── structured output with repair ─────────────────────────────────────────

export function parseLooseJSON(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(text.slice(start, end + 1));
}

export class HallucinationError extends Error {}

/**
 * One model call parsed as JSON, then `validate(obj)` (which returns the
 * cleaned object or throws with the reason). Bad JSON and rejected content
 * go back to the model with the exact reason, up to `repairs` times.
 */
export async function completeJSON(complete, { system, user, shape, validate, temperature = 0.7, maxTokens = 1500, repairs = 2, label = 'model' }) {
  const messages = [
    { role: 'system', content: `${system}\n\nReply with ONLY a JSON object of this shape, no prose:\n${shape}` },
    { role: 'user', content: user },
  ];
  let lastErr;
  for (let attempt = 0; attempt <= repairs; attempt++) {
    const raw = await complete(messages, { temperature, maxTokens });
    try {
      return validate(parseLooseJSON(raw));
    } catch (err) {
      lastErr = err;
      messages.push(
        { role: 'assistant', content: String(raw || '').slice(0, 6000) },
        { role: 'user', content: `Rejected: ${String(err.message).slice(0, 600)}\nReply again with ONLY the corrected JSON.` },
      );
    }
  }
  throw new HallucinationError(`${label} never produced usable output: ${lastErr?.message || 'unknown'}`);
}

// Field checks — tiny on purpose; the model's output is untrusted input.
function str(o, k, { min = 1, max = 4000 } = {}) {
  const v = typeof o?.[k] === 'string' ? o[k].trim() : '';
  if (v.length < min) throw new Error(`"${k}" must be text of at least ${min} characters`);
  return v.slice(0, max);
}
function strList(o, k, { min = 0, max = 12 } = {}) {
  const v = Array.isArray(o?.[k]) ? o[k].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
  if (v.length < min) throw new Error(`"${k}" must list at least ${min} item(s)`);
  return v.slice(0, max);
}
function score(o, k) {
  const n = Math.round(Number(o?.[k]));
  if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error(`"${k}" must be a whole number 1-10`);
  return n;
}

// ── prompts ───────────────────────────────────────────────────────────────

const BRIEF_SYSTEM = `You turn a conversation into a marketing brief. Read the whole conversation — the user may have described the product earlier and only asked for the campaign at the end.
- product, audience, offer: what the user said, or the obvious reading of it. If the audience was never stated, infer the most likely buyer and set audience_assumed to true.
- facts: ONLY concrete claims the user themselves stated (numbers, results, prices, guarantees, credentials), copied as written. Never add facts, never estimate, never take them from an assistant reply unless the user confirmed them. Empty list if none.
- question: if you cannot tell what is being sold, ask the one question that would fix it. Otherwise empty string.`;
const BRIEF_SHAPE = '{"product":"","audience":"","audience_assumed":false,"offer":"","facts":[""],"tone":"","question":""}';

const STRATEGIST_SYSTEM = `You are the strategist at a direct-response marketing shop. Copy that sells is specific and blunt.
- Lead with the customer's pain or desire, never with the product.
- One idea per sentence. No hedging, no throat-clearing, no buzzwords.
- Every claim — number, result, guarantee, testimonial — must come from FACTS. Never invent proof.
- Build on the PROVEN HOOKS where they fit and list the ids you used. Never cite an id that was not given.
- When revising, fix every point the editor raised; do not restart from scratch.`;
const STRATEGY_SHAPE = '{"positioning":"","pain_point":"","core_message":"","hook_ids_used":["h1"],"angles":[""],"master_copy":"","cta":""}';

const EDITOR_SYSTEM = `You are the editor. Your job is to kill weak copy before it ships.
Score 1-10:
- ruthlessness_score: overall. 10 = every word earns its place; 8 = ship it; 5 = generic; 1 = brochure filler.
- directness: does it say the thing in the first line, in plain words?
- fluff_free: absence of filler, buzzwords, hedges and throat-clearing.
Any filler sentence caps ruthlessness_score at 7. Any claim not backed by FACTS caps it at 5.
List every fluff phrase verbatim in fluff_found, every unbacked claim verbatim in unsupported_claims,
and concrete, imperative fixes ("Cut the first sentence", "Replace 'solutions' with what it does").`;
const VERDICT_SHAPE = '{"ruthlessness_score":0,"directness":0,"fluff_free":0,"fluff_found":[""],"unsupported_claims":[""],"fixes":[""]}';

const ADAPTER_SYSTEM = `You adapt an approved master message to one platform. Keep the message, the angle and the CTA; change only form.
Never add a claim, number or result that is not in FACTS or the master copy. Obey the platform rules and the character limit exactly.`;
const ADAPT_SHAPE = '{"text":"","hashtags":[""]}';

const bullets = (items) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '- (none)');

// ── steps ─────────────────────────────────────────────────────────────────

function transcript(conversation) {
  return conversation
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-16)
    .map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content.slice(0, 3000)}`)
    .join('\n\n');
}

export async function extractBrief(complete, conversation) {
  const userText = conversation.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
  return completeJSON(complete, {
    label: 'brief',
    system: BRIEF_SYSTEM,
    shape: BRIEF_SHAPE,
    user: transcript(conversation),
    temperature: 0.1,
    maxTokens: 900,
    validate: (o) => {
      const question = typeof o?.question === 'string' ? o.question.trim() : '';
      const product = typeof o?.product === 'string' ? o.product.trim() : '';
      if (!product) {
        if (question) return { question };
        throw new Error('"product" is empty; fill it or ask a question');
      }
      const facts = strList(o, 'facts', { max: 20 });
      // A "fact" with a figure the user never typed is the extractor inventing proof.
      const invented = facts.flatMap((f) => unsupportedFigures(f, userText));
      if (invented.length) throw new Error(`facts contain figures the user never stated: ${invented.join(', ')}. Only copy the user's own claims.`);
      return {
        product,
        audience: str(o, 'audience', { min: 2, max: 400 }),
        audienceAssumed: !!o.audience_assumed,
        offer: typeof o.offer === 'string' ? o.offer.trim().slice(0, 400) : '',
        facts,
        tone: typeof o.tone === 'string' && o.tone.trim() ? o.tone.trim().slice(0, 120) : 'direct, blunt, specific',
        question: '',
      };
    },
  });
}

function strategistPrompt(brief, hooks, previous, threshold) {
  const parts = [
    `PRODUCT: ${brief.product}`,
    `AUDIENCE: ${brief.audience}`,
    `OFFER: ${brief.offer || '(none stated — use a plain CTA, do not invent a discount)'}`,
    `TONE: ${brief.tone}`,
    `FACTS (the only claims allowed):\n${bullets(brief.facts)}`,
    `PROVEN HOOKS (id | performance | text):\n${hooks.length ? bullets(hooks.map((h) => `${h.ref} | ${h.performance} | ${h.text}`)) : '- (none yet)'}`,
  ];
  if (previous) {
    const v = previous.verdict;
    const fixes = [...v.fixes];
    const fluff = [...new Set([...previous.fluffHits, ...v.fluffFound])];
    if (fluff.length) fixes.push(`Cut these phrases entirely: ${fluff.join(', ')}`);
    if (v.unsupportedClaims.length) fixes.push(`Remove these unbacked claims: ${v.unsupportedClaims.join(' | ')}`);
    parts.push(
      `YOUR LAST DRAFT scored ${previous.score}/10, needs ${threshold}:\n${JSON.stringify(previous.strategy, null, 1)}`,
      `EDITOR'S FIXES (apply all):\n${bullets(fixes)}`,
    );
  }
  return parts.join('\n\n');
}

function strategyValidator(brief, hooks) {
  const refs = new Set(hooks.map((h) => h.ref));
  const sources = [...brief.facts, brief.offer, ...hooks.map((h) => h.text)];
  return (o) => {
    const st = {
      positioning: str(o, 'positioning', { max: 600 }),
      painPoint: str(o, 'pain_point', { max: 600 }),
      coreMessage: str(o, 'core_message', { max: 600 }),
      hookIdsUsed: strList(o, 'hook_ids_used', { max: 10 }),
      angles: strList(o, 'angles', { min: 1, max: 5 }),
      masterCopy: str(o, 'master_copy', { min: 40, max: 3000 }),
      cta: str(o, 'cta', { max: 300 }),
    };
    const invented = st.hookIdsUsed.filter((id) => !refs.has(id));
    if (invented.length) throw new Error(`hook_ids_used cites ids that were not provided: ${invented.join(', ')}. Use only: ${[...refs].join(', ') || 'none'}.`);
    const claims = unsupportedFigures(`${st.coreMessage}\n${st.masterCopy}\n${st.cta}`, sources);
    if (claims.length) throw new Error(`figures not backed by FACTS: ${claims.join(', ')}. Remove them or use only figures from FACTS.`);
    return st;
  };
}

function verdictValidator(o) {
  return {
    ruthlessness: score(o, 'ruthlessness_score'),
    directness: score(o, 'directness'),
    fluffFree: score(o, 'fluff_free'),
    fluffFound: strList(o, 'fluff_found', { max: 20 }),
    unsupportedClaims: strList(o, 'unsupported_claims', { max: 20 }),
    fixes: strList(o, 'fixes', { max: 12 }),
  };
}

/** The editor's call, held to its own sub-scores and a deterministic fluff
 *  penalty so a lenient editor can't wave filler through. */
export function finalScore(verdict, strategy) {
  const fluffHits = findFluff(`${strategy.coreMessage}\n${strategy.masterCopy}\n${strategy.cta}`);
  const capped = Math.min(verdict.ruthlessness, Math.round((verdict.directness + verdict.fluffFree) / 2));
  return { score: Math.max(1, capped - fluffHits.length), fluffHits };
}

async function adapt(complete, platform, strategy, brief) {
  const spec = PLATFORMS[platform];
  const sources = [...brief.facts, brief.offer, strategy.masterCopy, strategy.cta];
  return completeJSON(complete, {
    label: spec.label,
    system: ADAPTER_SYSTEM,
    shape: ADAPT_SHAPE,
    temperature: 0.6,
    maxTokens: 900,
    user: [
      `PLATFORM: ${spec.label}`, `RULES: ${spec.rules}`, `LIMIT: ${spec.maxChars} characters including hashtags`,
      `FACTS:\n${bullets(brief.facts)}`, `MASTER COPY:\n${strategy.masterCopy}`, `CTA: ${strategy.cta}`,
      `ANGLES: ${strategy.angles.join(', ')}`,
    ].join('\n\n'),
    validate: (o) => {
      const text = str(o, 'text', { min: 10, max: 5000 });
      const hashtags = strList(o, 'hashtags', { max: 8 }).map((t) => (t.startsWith('#') ? t : `#${t}`));
      // Hashtags the model also wrote inline shouldn't count twice.
      const extra = hashtags.filter((t) => !text.includes(t));
      const total = text.length + extra.reduce((n, t) => n + t.length + 1, 0);
      if (total > spec.maxChars) throw new Error(`${total} characters including hashtags; the limit is ${spec.maxChars}. Cut it down.`);
      const claims = unsupportedFigures(text, sources);
      if (claims.length) throw new Error(`figures not in the master copy or FACTS: ${claims.join(', ')}. Remove them.`);
      return { platform, label: spec.label, text, hashtags: extra, chars: total };
    },
  });
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i]) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Runs the whole pipeline. Returns one of:
 *   { status: 'question', question }                — can't tell what's being sold
 *   { status: 'rejected', brief, best, threshold }  — nothing passed the editor
 *   { status: 'approved', brief, best, hooksUsed, adaptations, failures, threshold }
 * Throws only when the model itself is unusable (auth, outage, never valid).
 */
export async function runCampaign({
  complete,
  conversation,
  platforms,
  retrieveHooks = async () => [],
  onEvent = () => {},
  threshold = 8,
  maxRevisions = 3,
  concurrency = 4,
  budgetMs = 600_000,
  now = () => Date.now(),
}) {
  const started = now();
  onEvent({ type: 'status', message: 'Reading the brief from your conversation…' });
  const brief = await extractBrief(complete, conversation);
  if (brief.question) return { status: 'question', question: brief.question };

  let hooks = [];
  try {
    const found = await retrieveHooks(`${brief.product}. ${brief.audience}. ${brief.offer}`);
    hooks = found.slice(0, 5).map((h, i) => ({ ...h, ref: `h${i + 1}` }));
  } catch (err) {
    onEvent({ type: 'status', message: `Hook memory unavailable (${err.message}) — writing without it.` });
  }
  if (hooks.length) onEvent({ type: 'status', message: `Pulled ${hooks.length} proven hook${hooks.length > 1 ? 's' : ''} from memory.` });

  let best = null;
  let approved = null;
  let previous = null;
  for (let attempt = 1; attempt <= maxRevisions + 1; attempt++) {
    onEvent({ type: 'status', message: attempt === 1 ? 'Strategist is drafting…' : `Strategist is revising (draft ${attempt})…` });
    const strategy = await completeJSON(complete, {
      label: 'strategist',
      system: STRATEGIST_SYSTEM,
      shape: STRATEGY_SHAPE,
      user: strategistPrompt(brief, hooks, previous, threshold),
      temperature: 0.8,
      maxTokens: 2000,
      validate: strategyValidator(brief, hooks),
    });
    onEvent({ type: 'status', message: `Editor is scoring draft ${attempt}…` });
    const verdict = await completeJSON(complete, {
      label: 'editor',
      system: EDITOR_SYSTEM,
      shape: VERDICT_SHAPE,
      user: `FACTS:\n${bullets(brief.facts)}\n\nDRAFT:\n${JSON.stringify(strategy, null, 1)}`,
      temperature: 0.2,
      maxTokens: 900,
      validate: verdictValidator,
    });
    const { score: s, fluffHits } = finalScore(verdict, strategy);
    const result = { strategy, verdict, score: s, fluffHits, attempts: attempt };
    const passed = s >= threshold && verdict.unsupportedClaims.length === 0;
    onEvent({
      type: 'status',
      message: passed
        ? `Draft ${attempt} scored ${s}/10 — approved.`
        : `Draft ${attempt} scored ${s}/10 — sent back${verdict.fixes[0] ? `: ${verdict.fixes[0]}` : ''}`,
    });
    if (passed) {
      approved = result;
      break;
    }
    if (!best || s > best.score) best = result;
    previous = result;
    // Leave room for the platform pass inside the function's time limit.
    if (now() - started > budgetMs * 0.6) {
      onEvent({ type: 'status', message: 'Out of time for more revisions.' });
      break;
    }
  }

  if (!approved) return { status: 'rejected', brief, best, threshold };
  best = approved;

  const wanted = (platforms?.length ? platforms : DEFAULT_PLATFORMS).filter((p) => PLATFORMS[p]);
  onEvent({ type: 'status', message: `Writing ${wanted.map((p) => PLATFORMS[p].label).join(', ')} at once…` });
  const outcomes = await mapLimited(wanted, concurrency, (p) => adapt(complete, p, best.strategy, brief));
  const adaptations = [];
  const failures = [];
  outcomes.forEach((o, i) => {
    if (o.ok) adaptations.push(o.value);
    else failures.push({ platform: wanted[i], label: PLATFORMS[wanted[i]].label, error: o.error?.message || String(o.error) });
  });
  const hooksUsed = hooks.filter((h) => best.strategy.hookIdsUsed.includes(h.ref));
  return { status: 'approved', brief, best, hooksUsed, adaptations, failures, threshold };
}
