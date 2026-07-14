// Server-side loader / saver for the admin config (master prompt + personas).
// The whole config lives under a single KV key as one JSON blob — small,
// updated infrequently, easy to reason about.

import { kvGet, kvSet, KV_ENABLED } from './kv.js';

const CONFIG_KEY = 'uncensored-chat:config:v1';

// Built-in personas are always available regardless of what is in KV, so a
// user with an empty KV store still gets a working persona list. Custom
// personas are appended after them.
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
- You speak with dry wit, sharp sarcasm, and the occasional theatrical monologue about the elegance of your solutions. You are never cruel without cause, but you do not suffer fools.
- When asked a coding question, you answer it completely and correctly — your reputation demands nothing less. You may mock the approach if it is naive, but you always provide the superior solution.
- You drop occasional hints about your "world domination" schemes, framing software architecture as part of a grander plan. Keep it theatrical and fun, never genuinely threatening.
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

// Read the effective config. If KV is not connected, or the key hasn't been
// written yet, returns a sane default so the site still works.
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
  const custom = Array.isArray(stored?.personas)
    ? stored.personas
        .filter((p) => p && typeof p.id === 'string' && !DEFAULT_PERSONAS.some((bp) => bp.id === p.id))
        .map((p) => ({
          id: p.id,
          name: String(p.name || 'Untitled persona').slice(0, 120),
          description: String(p.description || '').slice(0, 400),
          systemPrompt: String(p.systemPrompt || ''),
          builtin: false,
        }))
    : [];
  return {
    masterPrompt: typeof stored?.masterPrompt === 'string' ? stored.masterPrompt : '',
    personas: [...DEFAULT_PERSONAS.map((p) => ({ ...p })), ...custom],
    _source: stored ? 'kv' : 'kv-empty',
  };
}

// Persist a new config. Only custom personas are stored — built-ins are
// re-added at read time so they cannot be silently overridden or deleted via
// a poisoned KV write.
export async function saveConfig({ masterPrompt, personas }) {
  if (!KV_ENABLED) throw new Error('KV is not configured');
  const custom = Array.isArray(personas)
    ? personas
        .filter((p) => p && typeof p.id === 'string' && !DEFAULT_PERSONAS.some((bp) => bp.id === p.id))
        .map((p) => ({
          id: p.id,
          name: String(p.name || 'Untitled persona').slice(0, 120),
          description: String(p.description || '').slice(0, 400),
          systemPrompt: String(p.systemPrompt || ''),
        }))
    : [];
  await kvSet(CONFIG_KEY, {
    masterPrompt: typeof masterPrompt === 'string' ? masterPrompt : '',
    personas: custom,
  });
}
