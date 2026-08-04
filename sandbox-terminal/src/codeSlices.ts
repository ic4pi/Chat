/**
 * Client-side code-slice prefs — mirrors lib/code-slices.js.
 * Selections persist in localStorage keyed by chunk id.
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
] as const;

export type ChunkId = (typeof CHUNK_LIST)[number]['id'];

export interface ChunkModel {
  provider: string;
  model: string;
}

export const GENERAL_PURPOSE_MODEL: ChunkModel & { badge: string } = {
  provider: 'openrouter',
  model: 'openrouter/free',
  badge: 'General',
};

export const DEFAULT_CHUNK_MODELS: Record<ChunkId, ChunkModel> = {
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

const CHUNK_STORAGE = 'uncensored_chunk_models_v1';

export function modelBadgeLabel(modelId: string): string {
  if (!modelId) return GENERAL_PURPOSE_MODEL.badge;
  let base = modelId.includes('/') ? modelId.split('/').pop()! : modelId;
  base = base.replace(/:free$/i, '').replace(/:extended$/i, '');
  const known: Record<string, string> = {
    'gpt-4o': 'GPT-4o',
    'gpt-4.1': 'GPT-4.1',
    'gpt-4o-mini': 'GPT-4o mini',
    free: 'General',
    'qwen3-coder': 'Qwen3 Coder',
    'llama-3.3-70b-instruct': 'Llama 3.3',
    'llama-3.3-70b-versatile': 'Llama 3.3',
    'venice-uncensored': 'Venice',
    'venice-uncensored-1-2': 'Venice',
  };
  if (known[base]) return known[base];
  if (modelId === 'openrouter/free') return 'General';
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

function emptyDefaults(): Record<ChunkId, ChunkModel> {
  const out = {} as Record<ChunkId, ChunkModel>;
  for (const c of CHUNK_LIST) {
    out[c.id] = { ...DEFAULT_CHUNK_MODELS[c.id] };
  }
  return out;
}

export function loadChunkModels(): Record<ChunkId, ChunkModel> {
  const defaults = emptyDefaults();
  try {
    const raw = localStorage.getItem(CHUNK_STORAGE);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<ChunkId, ChunkModel>>;
    if (!parsed || typeof parsed !== 'object') return defaults;
    const out = { ...defaults };
    for (const c of CHUNK_LIST) {
      const a = parsed[c.id];
      if (a && typeof a.provider === 'string' && typeof a.model === 'string' && a.provider && a.model) {
        out[c.id] = { provider: a.provider, model: a.model };
      }
    }
    return out;
  } catch {
    return defaults;
  }
}

export function saveChunkModels(map: Record<ChunkId, ChunkModel>): void {
  try {
    localStorage.setItem(CHUNK_STORAGE, JSON.stringify(map));
  } catch { /* ignore */ }
}

export function setChunkModel(
  map: Record<ChunkId, ChunkModel>,
  chunkId: ChunkId,
  provider: string,
  model: string,
): Record<ChunkId, ChunkModel> {
  if (!provider || !model) return map;
  return { ...map, [chunkId]: { provider, model } };
}

/** Resolve with general-purpose fallback when unset. */
export function resolveChunkModelClient(
  map: Record<ChunkId, ChunkModel>,
  chunkId: ChunkId,
): ChunkModel & { badge: string; usedFallback: boolean } {
  const assigned = map[chunkId];
  if (assigned?.provider && assigned?.model) {
    return {
      ...assigned,
      badge: modelBadgeLabel(assigned.model),
      usedFallback: false,
    };
  }
  const def = DEFAULT_CHUNK_MODELS[chunkId] || GENERAL_PURPOSE_MODEL;
  return {
    ...def,
    badge: modelBadgeLabel(def.model),
    usedFallback: !DEFAULT_CHUNK_MODELS[chunkId],
  };
}
