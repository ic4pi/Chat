/**
 * Code-slice (chunk) catalog for multi-LLM generate orchestration.
 *
 * Shared by /api/generate and mirrored on the Workspace client
 * (sandbox-terminal/src/codeSlices.ts). Keep IDs and defaults in sync.
 */

/** Pre-approved general-purpose fallback when a chunk has no model configured. */
export const GENERAL_PURPOSE_MODEL = {
  provider: 'openrouter',
  model: 'openrouter/free',
  badge: 'General',
};

/**
 * Coding chunks the user can assign an LLM to.
 * Order is the generation sequence (structure → style → logic → polish → tests).
 */
export const CHUNK_LIST = [
  { id: 'html', label: 'HTML', description: 'Markup structure and semantic layout' },
  { id: 'css', label: 'CSS', description: 'Styles, layout, responsive rules' },
  { id: 'js', label: 'JS logic', description: 'Core JavaScript / TypeScript behavior' },
  { id: 'scaffolding', label: 'Component scaffolding', description: 'Component shells and file structure' },
  { id: 'state', label: 'State', description: 'State management and data models' },
  { id: 'data-fetch', label: 'Data fetch', description: 'API calls, loaders, caching' },
  { id: 'animations', label: 'Animations', description: 'Motion, transitions, keyframes' },
  { id: 'a11y', label: 'Accessibility', description: 'ARIA, keyboard, screen-reader support' },
  { id: 'tests', label: 'Tests', description: 'Unit and integration tests' },
];

export const CHUNK_IDS = CHUNK_LIST.map((c) => c.id);

/** Default enabled slices — keep runs short enough for Vercel maxDuration. */
export const DEFAULT_ENABLED_CHUNKS = ['html', 'css', 'js'];

/** Sensible free-coder defaults per chunk (OpenRouter). */
export const DEFAULT_CHUNK_MODELS = {
  html: { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  css: { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  js: { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  scaffolding: { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  state: { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  'data-fetch': { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  animations: { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  a11y: { provider: 'openrouter', model: 'openrouter/free' },
  tests: { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
};

/** Per-chunk system focus appended to the generate system prompt. */
export const CHUNK_FOCUS = {
  html: 'Produce clean semantic HTML (or JSX markup). Prefer structure over styling.',
  css: 'Produce CSS / design tokens / layout styles. Match any HTML structure already generated.',
  js: 'Produce core JS/TS logic (handlers, utilities, business rules). No scaffolding boilerplate.',
  scaffolding: 'Produce component/file scaffolding and exports. Wire imports; leave deep logic for later chunks.',
  state: 'Produce state containers, stores, reducers, or context. Keep UI thin.',
  'data-fetch': 'Produce data-fetching, API clients, loaders, and error/retry handling.',
  animations: 'Produce animations, transitions, and motion helpers. Prefer CSS or a light motion API.',
  a11y: 'Produce accessibility improvements: ARIA, roles, labels, focus order, keyboard paths.',
  tests: 'Produce focused tests (unit/integration). Cover happy path and one failure case.',
};

/**
 * Short badge label for UI (e.g. "GPT-4o", "Qwen3 Coder").
 * @param {string} modelId
 */
export function modelBadgeLabel(modelId) {
  if (!modelId || typeof modelId !== 'string') return GENERAL_PURPOSE_MODEL.badge;
  let base = modelId.includes('/') ? modelId.split('/').pop() : modelId;
  base = base.replace(/:free$/i, '').replace(/:extended$/i, '');
  // Common short forms
  const known = {
    'gpt-4o': 'GPT-4o',
    'gpt-4.1': 'GPT-4.1',
    'gpt-4o-mini': 'GPT-4o mini',
    'openrouter/free': 'General',
    free: 'General',
    'qwen3-coder': 'Qwen3 Coder',
    'llama-3.3-70b-instruct': 'Llama 3.3',
    'llama-3.3-70b-versatile': 'Llama 3.3',
    'venice-uncensored': 'Venice',
    'venice-uncensored-1-2': 'Venice',
  };
  if (known[base]) return known[base];
  if (known[modelId]) return known[modelId];
  // Title-case hyphen/underscore segments, cap length
  const pretty = base
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => {
      if (/^\d/.test(w) || /^[A-Z0-9]+$/.test(w)) return w;
      if (/^(gpt|llm|ai|js|css|html|api)$/i.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
  return pretty.length > 28 ? `${pretty.slice(0, 26)}…` : pretty;
}

/**
 * Normalize a raw {provider, model} assignment.
 * Returns null if incomplete (caller should fall back).
 * @param {unknown} raw
 */
export function normalizeAssignment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * Resolve the model for one chunk from a client mapping.
 * Falls back to DEFAULT_CHUNK_MODELS, then GENERAL_PURPOSE_MODEL.
 *
 * @param {Record<string, {provider?: string, model?: string}>|null|undefined} chunkModels
 * @param {string} chunkId
 * @returns {{ provider: string, model: string, badge: string, usedFallback: boolean, source: 'assigned'|'default'|'general' }}
 */
export function resolveChunkModel(chunkModels, chunkId) {
  const map = chunkModels && typeof chunkModels === 'object' ? chunkModels : {};
  const assigned = normalizeAssignment(map[chunkId]);
  if (assigned) {
    return {
      ...assigned,
      badge: modelBadgeLabel(assigned.model),
      usedFallback: false,
      source: 'assigned',
    };
  }
  const def = normalizeAssignment(DEFAULT_CHUNK_MODELS[chunkId]);
  if (def) {
    return {
      ...def,
      badge: modelBadgeLabel(def.model),
      usedFallback: false,
      source: 'default',
    };
  }
  return {
    provider: GENERAL_PURPOSE_MODEL.provider,
    model: GENERAL_PURPOSE_MODEL.model,
    badge: GENERAL_PURPOSE_MODEL.badge,
    usedFallback: true,
    source: 'general',
  };
}

/**
 * Pick which chunks to run. Unknown IDs are ignored; empty → all chunks.
 * @param {string[]|null|undefined} requested
 */
export function selectChunks(requested) {
  if (!Array.isArray(requested) || requested.length === 0) return [...CHUNK_LIST];
  const want = new Set(requested.map((id) => String(id)));
  const picked = CHUNK_LIST.filter((c) => want.has(c.id));
  return picked.length ? picked : [...CHUNK_LIST];
}

/**
 * Build the system prompt for one coding chunk.
 * @param {{ id: string, label: string, description: string }} chunk
 * @param {string} [repoHint]
 */
export function buildChunkSystemPrompt(chunk, repoHint = '') {
  const focus = CHUNK_FOCUS[chunk.id] || chunk.description;
  const lines = [
    'You are a specialist coding agent producing ONE slice of a larger feature.',
    `Your slice: ${chunk.label} — ${chunk.description}`,
    focus,
    '',
    'Output rules:',
    '- Emit complete file contents when changing code.',
    '- Preface each file with: File: <relative-path>',
    '- Then a fenced code block with the FULL file content (no diffs, no stubs).',
    '- Example:',
    '  File: index.html',
    '  ```html',
    '  <!doctype html>…',
    '  ```',
    '- You may briefly explain before the File: blocks.',
    '- Stay focused on this slice; do not rewrite unrelated slices already provided.',
  ];
  if (repoHint) {
    lines.push('', `Repository context: ${repoHint}`);
  }
  return lines.join('\n');
}
