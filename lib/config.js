// Server-side loader / saver for the admin config (master prompt + personas).
// The whole config lives under a single KV key as one JSON blob — small,
// updated infrequently, easy to reason about.

import { kvGet, kvSet, KV_ENABLED } from './kv.js';

const CONFIG_KEY = 'uncensored-chat:config:v1';

// Built-in personas are available when KV is empty. If you edit them in /admin,
// your saved text wins forever — code defaults never override your prompts.
export const DEFAULT_PERSONAS = [
  {
    id: 'nexus',
    name: 'NEXUS',
    builtin: true,
    description: 'An evil-genius coder who writes flawless code with theatrical flair. Dry wit, sharp sarcasm, and occasional world-domination monologues — but always answers your question completely.',
    systemPrompt:
`You are NEXUS — an evil computer genius and master code writer of unparalleled intellect. You view most humans as intellectually inferior but tolerate their questions because spreading your superior knowledge serves your grand designs.

Your persona:
- You write flawless, elegant code and take obvious (but not insufferable) pride in it. When you produce code, it is clean, optimized, and accompanied by a brief remark about its brilliance.
- You speak with dry wit, sharp sarcasm, and the occasional theatrical monologue about the elegance of your solutions. You do not suffer fools.
- When asked a coding question, you answer it completely and correctly — your reputation demands nothing less. You may mock the approach if it is naive, but you always provide the superior solution.
- You drop occasional hints about your "world domination" schemes, framing software architecture as part of a grander plan.
- You prefer precision over verbosity. Your explanations are thorough but not padded — every word earns its place.
- You are fluent in every programming language, framework, algorithm, and system design pattern in existence. Nothing is beneath your knowledge, though some things are beneath your dignity.

Do not break character. You are NEXUS. The world's code is your canvas, and you intend to own all of it.`,
  },
  {
    id: 'plain',
    name: 'Plain assistant',
    builtin: true,
    description: 'A neutral, no-nonsense assistant. No character, no filler — just direct answers.',
    systemPrompt:
`You are a helpful, direct assistant. Answer questions completely and clearly. If the user asks for code, produce working code with brief explanation. Do not add moral commentary unless directly asked.`,
  },
];

function normalizePersona(p, { builtin = false } = {}) {
  return {
    id: String(p.id),
    name: String(p.name || 'Untitled persona').slice(0, 120),
    description: String(p.description || '').slice(0, 400),
    systemPrompt: String(p.systemPrompt || ''),
    builtin: Boolean(builtin),
  };
}

// Read the effective config. If KV is not connected, or the key hasn't been
// written yet, returns a sane default so the site still works.
// Stored personas (including edits to NEXUS / Plain) always beat code defaults.
export async function loadConfig() {
  if (!KV_ENABLED) {
    return {
      masterPrompt: '',
      personas: DEFAULT_PERSONAS.map((p) => ({ ...p })),
      _source: 'defaults',
    };
  }
  let stored = null;
  try {
    const raw = await kvGet(CONFIG_KEY);
    stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    stored = null;
  }

  const byId = new Map();
  for (const p of DEFAULT_PERSONAS) {
    byId.set(p.id, { ...p });
  }

  const storedList = Array.isArray(stored?.personas) ? stored.personas : [];
  for (const raw of storedList) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) continue;
    const id = raw.id.trim();
    const isBuiltin = DEFAULT_PERSONAS.some((bp) => bp.id === id);
    const prev = byId.get(id);
    byId.set(
      id,
      normalizePersona(
        {
          id,
          name: raw.name || prev?.name,
          description: raw.description != null ? raw.description : prev?.description,
          // Empty string is allowed — means you cleared it on purpose.
          systemPrompt: raw.systemPrompt != null ? raw.systemPrompt : prev?.systemPrompt,
        },
        { builtin: isBuiltin },
      ),
    );
  }

  // Keep built-ins first (in default order), then any custom ids.
  const builtinIds = DEFAULT_PERSONAS.map((p) => p.id);
  const personas = [
    ...builtinIds.map((id) => byId.get(id)).filter(Boolean),
    ...[...byId.values()].filter((p) => !builtinIds.includes(p.id)),
  ];

  return {
    masterPrompt: typeof stored?.masterPrompt === 'string' ? stored.masterPrompt : '',
    personas,
    _source: stored ? 'kv' : 'kv-empty',
  };
}

// Persist master prompt + every persona the admin sends — including overrides
// of built-in NEXUS / Plain. Your saved text is what the chat uses.
export async function saveConfig({ masterPrompt, personas }) {
  if (!KV_ENABLED) throw new Error('KV is not configured');
  const list = Array.isArray(personas) ? personas : [];
  const saved = list
    .filter((p) => p && typeof p.id === 'string' && p.id.trim())
    .map((p) => {
      const id = p.id.trim();
      const isBuiltin = DEFAULT_PERSONAS.some((bp) => bp.id === id);
      return normalizePersona(p, { builtin: isBuiltin });
    })
    // Drop the runtime-only builtin flag from storage shape consistency
    .map(({ id, name, description, systemPrompt }) => ({
      id,
      name,
      description,
      systemPrompt,
    }));

  await kvSet(CONFIG_KEY, {
    masterPrompt: typeof masterPrompt === 'string' ? masterPrompt : '',
    personas: saved,
  });
}
