// ============================================================================
// Model packages — the curated, novice-facing view of the catalog.
//
// The raw catalog is ~300 rows across five providers. That is the right list
// for someone who knows what "nemotron-super-49b-a12b" is, and the wrong one
// for everybody else. A *package* is a themed shelf of familiar brand names;
// only "General" ships enabled, so a first-run user sees five names they have
// heard of instead of a provider dump.
//
// Every brand group has the same shape — the General default is not special,
// it is just the one that ships on:
//
//   free  — one no-cost option (an OpenRouter `:free` slug), or null when the
//           brand has no free option anywhere. Brands with `free: null` still
//           render in their group, greyed out, until paid models are unlocked.
//   paid  — the real, credit-burning models for that brand.
//
// Ids here are *preferences, not promises*. Providers rename and retire slugs
// constantly (OpenRouter's free listings especially — they come and go with
// whichever inference provider is sponsoring them that week). So each entry
// carries a list of candidate ids, and resolvePackages() matches them against
// the live /api/models catalog: first candidate that exists wins, and if none
// do it falls back to discovering any catalog model matching the brand. A bad
// guess here degrades to "that one model is missing", never to a broken list.
// ============================================================================

/**
 * OpenRouter's free tier is rate-limited per *account*, not per model, and the
 * limit is shared across every `:free` slug. Worth showing in the UI, because
 * "free" here means "20 a minute", not "unlimited".
 *
 * Note the daily number is a floor: it lifts to 1,000/day once the OpenRouter
 * account has ever purchased $10 of credit. Both numbers are OpenRouter policy
 * and can change on their side — this constant is the one place to edit.
 */
export const OPENROUTER_FREE_LIMITS = {
  perMinute: 20,
  perDay: 50,
  perDayWithCredit: 1000,
  short: '20/min · 50/day',
  long:
    'OpenRouter free tier — 20 requests a minute and 50 a day, shared across ' +
    'every free model (1,000 a day once the account has bought $10 of credit).',
};

/**
 * Venice / Cerebras / Groq / NVIDIA all burn credits on the site's own key, so
 * none of them can back a free-tier entry — see the paid gate in
 * lib/model-meta.js. Free entries are OpenRouter `:free` slugs only; those are
 * rate-limited by OpenRouter rather than billed to us, which is what makes
 * them safe to hand an unauthenticated visitor.
 */
const FREE_PROVIDER = 'openrouter';

/** Shorthand for a free (OpenRouter `:free`) entry. */
function free(ids, name, blurb) {
  return {
    provider: FREE_PROVIDER,
    ids: Array.isArray(ids) ? ids : [ids],
    name,
    blurb,
    free: true,
    limits: OPENROUTER_FREE_LIMITS,
  };
}

/** Shorthand for a paid entry on any provider. */
function paid(provider, ids, name, blurb) {
  return {
    provider,
    ids: Array.isArray(ids) ? ids : [ids],
    name,
    blurb,
    free: false,
    limits: null,
  };
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

export const MODEL_PACKAGES = [
  {
    id: 'general',
    label: 'General',
    blurb: 'The assistants most people already know. On by default.',
    shipped: true,
    brands: [
      {
        id: 'claude',
        label: 'Claude',
        vendor: 'Anthropic',
        blurb: 'Careful long-form writing and code.',
        match: /^anthropic\/claude/i,
        // No free Claude exists anywhere — Anthropic does not publish free
        // weights and OpenRouter has never carried a `:free` Claude slug.
        free: null,
        paid: [
          paid('openrouter', ['anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4'], 'Claude Sonnet', 'The everyday flagship.'),
          paid('openrouter', ['anthropic/claude-haiku-4.5', 'anthropic/claude-3.5-haiku'], 'Claude Haiku', 'Faster and cheaper than Sonnet.'),
        ],
      },
      {
        id: 'openai',
        label: 'ChatGPT',
        vendor: 'OpenAI',
        blurb: 'The name everyone recognises.',
        match: /^openai\//i,
        // GPT-4o itself is never free. GPT-OSS-20B is OpenAI's open-weight
        // model — same vendor, not the same model, and the label says so.
        free: free(
          ['openai/gpt-oss-20b:free'],
          'GPT OSS 20B',
          "OpenAI's open-weight model — free, but not GPT-4o.",
        ),
        paid: [
          paid('openrouter', ['openai/gpt-4o'], 'GPT-4o', 'The full multimodal model.'),
          paid('openrouter', ['openai/gpt-4o-mini'], 'GPT-4o mini', 'Cheapest real GPT-4o-family option.'),
        ],
      },
      {
        id: 'grok',
        label: 'Grok',
        vendor: 'xAI',
        blurb: 'Blunt, current-events leaning.',
        match: /^x-ai\/grok/i,
        // xAI has run temporary free promos on `:free` Grok slugs; none of
        // them have stuck, so treat Grok as paid-only and let the resolver
        // surface a free one if OpenRouter happens to be running a promo.
        free: null,
        paid: [
          paid('openrouter', ['x-ai/grok-4-fast', 'x-ai/grok-3-mini'], 'Grok Fast', 'The cheap, quick Grok.'),
          paid('openrouter', ['x-ai/grok-4', 'x-ai/grok-3'], 'Grok', 'The full model.'),
        ],
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        vendor: 'DeepSeek',
        blurb: 'Strong reasoning, very cheap.',
        match: /deepseek/i,
        free: free(
          ['deepseek/deepseek-chat-v3.1:free', 'deepseek/deepseek-r1:free', 'deepseek/deepseek-chat:free'],
          'DeepSeek Chat',
          'Full-size DeepSeek at no cost.',
        ),
        paid: [
          paid('openrouter', ['deepseek/deepseek-chat-v3.1'], 'DeepSeek Chat', 'No rate limit; pennies per million tokens.'),
          paid('nvidia', ['deepseek-ai/deepseek-v4-flash'], 'DeepSeek Flash', 'Faster, on NVIDIA.'),
        ],
      },
      {
        id: 'kimi',
        label: 'Kimi',
        vendor: 'Moonshot',
        blurb: 'Huge context window.',
        match: /kimi/i,
        free: free(
          ['moonshotai/kimi-k2:free', 'moonshotai/kimi-k2-instruct:free'],
          'Kimi K2',
          'Moonshot’s flagship, free tier.',
        ),
        paid: [
          paid('openrouter', ['moonshotai/kimi-k2'], 'Kimi K2', 'No rate limit.'),
          paid('groq', ['moonshotai/kimi-k2-instruct'], 'Kimi K2 Instruct', 'Groq speed.'),
        ],
      },
    ],
  },

  {
    id: 'open',
    label: 'Open models',
    blurb: 'Open-weight models — Llama, Gemma, Qwen, Mistral.',
    brands: [
      {
        id: 'llama',
        label: 'Llama',
        vendor: 'Meta',
        blurb: 'The open-weight workhorse.',
        match: /llama/i,
        free: free(['meta-llama/llama-3.3-70b-instruct:free'], 'Llama 3.3 70B', 'Meta’s flagship open model.'),
        paid: [
          paid('openrouter', ['meta-llama/llama-3.3-70b-instruct'], 'Llama 3.3 70B', 'No rate limit.'),
          paid('groq', ['llama-3.3-70b-versatile'], 'Llama 3.3 70B', 'Groq speed.'),
        ],
      },
      {
        id: 'google',
        label: 'Gemini · Gemma',
        vendor: 'Google',
        blurb: 'Gemini is paid; Gemma is the free open sibling.',
        match: /^google\//i,
        free: free(['google/gemma-4-31b-it:free', 'google/gemma-3-27b-it:free'], 'Gemma', 'Google’s open-weight model.'),
        paid: [
          paid('openrouter', ['google/gemini-2.5-pro'], 'Gemini Pro', 'The full Google model.'),
        ],
      },
      {
        id: 'qwen',
        label: 'Qwen',
        vendor: 'Alibaba',
        blurb: 'Broad, capable, cheap.',
        match: /qwen/i,
        free: free(['qwen/qwen3-coder:free'], 'Qwen3', 'Free Qwen tier.'),
        paid: [
          paid('groq', ['qwen/qwen3-32b'], 'Qwen3 32B', 'Groq speed.'),
        ],
      },
      {
        id: 'mistral',
        label: 'Mistral',
        vendor: 'Mistral',
        blurb: 'European, efficient.',
        match: /mistral/i,
        free: free(['mistralai/mistral-small-3.2-24b-instruct:free'], 'Mistral Small', 'Free Mistral tier.'),
        paid: [
          paid('nvidia', ['mistralai/mistral-large-2-instruct'], 'Mistral Large', 'The full model.'),
        ],
      },
    ],
  },

  {
    id: 'coder',
    label: 'Coders',
    blurb: 'Tuned for writing and fixing code.',
    brands: [
      {
        id: 'qwen-coder',
        label: 'Qwen Coder',
        vendor: 'Alibaba',
        blurb: 'The strongest cheap coder.',
        match: /qwen.*coder/i,
        free: free(['qwen/qwen3-coder:free'], 'Qwen3 Coder', 'Free coding model.'),
        paid: [paid('openrouter', ['qwen/qwen3-coder'], 'Qwen3 Coder', 'No rate limit.')],
      },
      {
        id: 'deepseek-coder',
        label: 'DeepSeek Coder',
        vendor: 'DeepSeek',
        blurb: 'Reasoning-heavy code work.',
        match: /deepseek/i,
        free: free(['deepseek/deepseek-chat-v3.1:free'], 'DeepSeek Chat', 'Doubles as a coder.'),
        paid: [paid('nvidia', ['deepseek-ai/deepseek-v4-pro'], 'DeepSeek V4 Pro', 'The big one.')],
      },
      {
        id: 'gpt-oss',
        label: 'GPT OSS',
        vendor: 'OpenAI',
        blurb: 'Open-weight OpenAI, good at code.',
        match: /gpt-oss/i,
        free: free(['openai/gpt-oss-20b:free'], 'GPT OSS 20B', 'Free tier.'),
        paid: [paid('cerebras', ['gpt-oss-120b'], 'GPT OSS 120B', 'Cerebras speed.')],
      },
    ],
  },

  {
    id: 'creative',
    label: 'Creative',
    blurb: 'Story, roleplay, and character work.',
    brands: [
      {
        id: 'hermes',
        label: 'Hermes',
        vendor: 'Nous Research',
        blurb: 'Steerable, low-refusal generalist.',
        match: /hermes/i,
        free: null,
        paid: [
          paid('openrouter', ['nousresearch/hermes-4-70b'], 'Hermes 4 70B', 'The everyday size.'),
          paid('openrouter', ['nousresearch/hermes-4-405b'], 'Hermes 4 405B', 'The big one.'),
        ],
      },
      {
        id: 'mythomax',
        label: 'MythoMax',
        vendor: 'Gryphe',
        blurb: 'The classic roleplay model.',
        match: /mytho/i,
        free: null,
        paid: [paid('openrouter', ['gryphe/mythomax-l2-13b'], 'MythoMax 13B', 'Small and cheap.')],
      },
    ],
  },

  {
    id: 'reasoning',
    label: 'Reasoning',
    blurb: 'Models that think step by step before answering.',
    brands: [
      {
        id: 'deepseek-r1',
        label: 'DeepSeek R1',
        vendor: 'DeepSeek',
        blurb: 'The open reasoning model.',
        match: /deepseek.*(r1|reason)/i,
        free: free(['deepseek/deepseek-r1:free'], 'DeepSeek R1', 'Free reasoning tier.'),
        paid: [paid('nvidia', ['deepseek-ai/deepseek-v4-pro'], 'DeepSeek V4 Pro', 'No rate limit.')],
      },
      {
        id: 'nemotron',
        label: 'Nemotron',
        vendor: 'NVIDIA',
        blurb: 'NVIDIA’s reasoning-tuned Llamas.',
        match: /nemotron/i,
        free: free(['nvidia/nemotron-3-nano-30b-a3b:free'], 'Nemotron Nano', 'Free tier.'),
        paid: [paid('nvidia', ['nvidia/nemotron-3-super-120b-a12b'], 'Nemotron Super', 'The big one.')],
      },
    ],
  },

  {
    id: 'uncensored',
    label: 'Uncensored',
    blurb: 'Refusal-trained behaviour removed. Venice credits, no free tier.',
    brands: [
      {
        id: 'venice',
        label: 'Venice',
        vendor: 'Venice',
        blurb: 'Purpose-built uncensored models.',
        match: /venice/i,
        // Venice bills our key on every call — never free. The OpenRouter
        // `:free` mirror of Dolphin-Venice was retired (see MODEL_FALLBACKS).
        free: null,
        paid: [
          paid('venice', ['venice-uncensored-1-2'], 'Venice Uncensored', 'The current flagship.'),
          paid('venice', ['olafangensan-glm-4.7-flash-heretic'], 'GLM Flash Heretic', 'Cheapest uncensored option.'),
          paid('venice', ['venice-uncensored-role-play'], 'Venice Role Play', 'Tuned for character work.'),
        ],
      },
      {
        id: 'dolphin',
        label: 'Dolphin',
        vendor: 'Cognitive Computations',
        blurb: 'The community-standard uncensored tune.',
        match: /dolphin/i,
        free: null,
        paid: [
          paid('venice', ['venice-uncensored'], 'Dolphin Mistral 24B', 'Venice’s copy.'),
          paid('openrouter', ['cognitivecomputations/dolphin-mistral-24b-venice-edition'], 'Dolphin Mistral 24B', 'OpenRouter’s copy.'),
        ],
      },
    ],
  },
];

export const PACKAGE_IDS = MODEL_PACKAGES.map((p) => p.id);

/** Packages that ship enabled for a brand-new user. */
export const DEFAULT_PACKAGE_IDS = MODEL_PACKAGES.filter((p) => p.shipped).map((p) => p.id);

/**
 * What a fresh install starts on: the first free model of the first brand in
 * the shipped package. Only a hint — syncHiddenModelSelects() re-resolves
 * against the live catalog and moves on if this slug is gone.
 */
export const DEFAULT_PACKAGE_MODEL = {
  provider: FREE_PROVIDER,
  id: 'deepseek/deepseek-chat-v3.1:free',
};

export function getPackage(id) {
  return MODEL_PACKAGES.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------
// Resolution against the live catalog
// ---------------------------------------------------------------------------

/**
 * Find the first candidate id that the live catalog actually carries.
 * Returns the *catalog* row (authoritative name / free flag / pricing), merged
 * with our curated label and blurb — curated copy wins for the display name
 * because "Claude Haiku" reads better in a novice list than whatever marketing
 * string the provider shipped this month.
 */
function resolveEntry(entry, catalog) {
  if (!entry) return null;
  for (const id of entry.ids) {
    const hit = catalog.find((m) => m.provider === entry.provider && m.id === id);
    if (hit) {
      return {
        ...hit,
        name: entry.name || hit.name || hit.id,
        providerName: hit.name || hit.id,
        blurb: entry.blurb || '',
        limits: entry.limits || null,
        curated: true,
      };
    }
  }
  return null;
}

/**
 * Nothing curated survived, so go looking. Used for both halves of a brand:
 * a free slug OpenRouter renamed, or a paid model a provider moved. Keeps a
 * brand group populated instead of silently emptying it.
 */
function discover(brand, catalog, { wantFree }) {
  if (!brand.match) return null;
  const hit = catalog.find(
    (m) => !!m.free === wantFree && brand.match.test(String(m.id || '')),
  );
  if (!hit) return null;
  return {
    ...hit,
    name: hit.name || hit.id,
    providerName: hit.name || hit.id,
    blurb: '',
    limits: hit.free && hit.provider === FREE_PROVIDER ? OPENROUTER_FREE_LIMITS : null,
    curated: false,
  };
}

/**
 * Resolve one brand group against the live catalog.
 *
 * `free` is null when the brand genuinely has no free option — that is the
 * signal the picker uses to grey the whole group out for a locked (free-tier)
 * visitor, rather than hiding it. Hiding would leave a novice wondering why
 * Claude is missing; greying tells them it exists behind the unlock.
 */
export function resolveBrand(brand, catalog) {
  const list = Array.isArray(catalog) ? catalog : [];

  let freeModel = resolveEntry(brand.free, list);
  if (!freeModel && brand.free) freeModel = discover(brand, list, { wantFree: true });
  // A brand we declared paid-only can still pick up a free slug if a provider
  // starts running one (xAI's on-and-off free Grok promos, say).
  if (!freeModel && !brand.free) freeModel = discover(brand, list, { wantFree: true });

  const paidModels = [];
  for (const entry of brand.paid || []) {
    const hit = resolveEntry(entry, list);
    if (hit && !paidModels.some((m) => m.provider === hit.provider && m.id === hit.id)) {
      paidModels.push(hit);
    }
  }
  if (!paidModels.length) {
    const found = discover(brand, list, { wantFree: false });
    if (found) paidModels.push(found);
  }

  return {
    id: brand.id,
    label: brand.label,
    vendor: brand.vendor,
    blurb: brand.blurb,
    free: freeModel,
    paid: paidModels,
    /** True when a free-tier (locked) visitor can use nothing in this group. */
    paidOnly: !freeModel,
    get models() {
      return freeModel ? [freeModel, ...paidModels] : paidModels;
    },
  };
}

/**
 * Resolve the enabled packages into render-ready groups.
 * Empty groups (nothing in the catalog matched at all) are dropped; groups
 * that resolved to paid-only are kept so they can render greyed out.
 */
export function resolvePackages(catalog, enabledIds) {
  const enabled = new Set(
    Array.isArray(enabledIds) && enabledIds.length ? enabledIds : DEFAULT_PACKAGE_IDS,
  );
  return MODEL_PACKAGES.filter((p) => enabled.has(p.id)).map((pkg) => ({
    id: pkg.id,
    label: pkg.label,
    blurb: pkg.blurb,
    brands: pkg.brands
      .map((b) => resolveBrand(b, catalog))
      .filter((b) => b.free || b.paid.length),
  }));
}

/** Every model reachable from the enabled packages, de-duplicated. */
export function packageModels(catalog, enabledIds) {
  const out = [];
  const seen = new Set();
  for (const pkg of resolvePackages(catalog, enabledIds)) {
    for (const brand of pkg.brands) {
      for (const m of brand.models) {
        const key = `${m.provider}:${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(m);
      }
    }
  }
  return out;
}

/** Human-readable rate limit for a model row, or '' when it has none. */
export function rateLimitLabel(model) {
  if (!model || !model.free) return '';
  const limits = model.limits || (model.provider === FREE_PROVIDER ? OPENROUTER_FREE_LIMITS : null);
  return limits ? limits.short : '';
}
