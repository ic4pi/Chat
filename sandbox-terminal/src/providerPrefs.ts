/**
 * Shared client prefs: BYOK keys + per-role model assignments.
 * Same localStorage keys as main chat (public/app.js) so prefs carry over.
 */

export const PROVIDER_LIST = [
  { id: 'venice', label: 'Venice' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'groq', label: 'Groq (Llama/Kimi host)' },
  // xAI, i.e. Grok — a different company from Groq above, one letter apart.
  { id: 'xai', label: 'xAI (Grok)' },
  { id: 'nvidia', label: 'NVIDIA' },
] as const;

export type ProviderId = (typeof PROVIDER_LIST)[number]['id'];

export const ROLE_LIST = [
  { id: 'write', label: 'Write' },
  { id: 'review', label: 'Review' },
  { id: 'plan', label: 'Plan' },
] as const;

export type RoleId = (typeof ROLE_LIST)[number]['id'];

export interface RoleModel {
  provider: string;
  model: string;
}

const KEYS_STORAGE = 'uncensored_provider_keys_v1';
const ROLES_STORAGE = 'uncensored_role_models_v1';
const PAID_PASS_STORAGE = 'uncensored_paid_password_v1';

/**
 * Persist paid unlock in localStorage (same as BYOK keys) so Chat ↔ Workspace
 * navigation and tab closes do not force re-entry. Migrates any leftover
 * sessionStorage value once.
 */
export function loadPaidPassword(): string {
  try {
    const fromLocal = localStorage.getItem(PAID_PASS_STORAGE);
    if (fromLocal) return fromLocal;
    const fromSession = sessionStorage.getItem(PAID_PASS_STORAGE);
    if (fromSession) {
      localStorage.setItem(PAID_PASS_STORAGE, fromSession);
      sessionStorage.removeItem(PAID_PASS_STORAGE);
      return fromSession;
    }
    return '';
  } catch {
    return '';
  }
}

export function savePaidPassword(pw: string): void {
  try {
    if (pw) {
      localStorage.setItem(PAID_PASS_STORAGE, pw);
      try { sessionStorage.removeItem(PAID_PASS_STORAGE); } catch { /* ignore */ }
    } else {
      localStorage.removeItem(PAID_PASS_STORAGE);
      try { sessionStorage.removeItem(PAID_PASS_STORAGE); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

export function paidUnlocked(): boolean {
  return !!loadPaidPassword();
}

export function inferFree(providerId: string, model: { id?: string; name?: string; free?: boolean } = {}): boolean {
  if (model.free === true) return true;
  if (model.free === false) return false;
  const id = String(model.id || '');
  // Venice burns credits — never free.
  if (providerId === 'venice') return false;
  if (providerId === 'openrouter') {
    if (id === 'openrouter/free' || /:free$/i.test(id)) return true;
    if (/\(free\)/i.test(String(model.name || ''))) return true;
  }
  return false;
}

const DEFAULT_ROLE_MODELS: Record<RoleId, RoleModel> = {
  // Free OpenRouter coder — Venice coder is paid/locked without unlock.
  write:  { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  review: { provider: 'openrouter', model: 'openrouter/free' },
  plan:   { provider: 'openrouter', model: 'openrouter/free' },
};

export const FALLBACK_MODELS: Record<string, Array<{ id: string; name: string }>> = {
  venice: [
    { id: 'venice-uncensored', name: 'Venice Uncensored (Dolphin 24B)' },
    { id: 'olafangensan-glm-4.7-flash-heretic', name: 'GLM 4.7 Flash Heretic (200k)' },
    { id: 'dolphin-2.9.2-qwen2-72b', name: 'Dolphin 2.9.2 Qwen2 72B' },
    { id: 'hermes-3-llama-3.1-405b', name: 'Hermes 3 Llama 3.1 405B' },
    { id: 'qwen3-235b-a22b-instruct-2507', name: 'Qwen3 235B Instruct' },
    { id: 'qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B' },
    { id: 'qwen3-next-80b', name: 'Qwen3 Next 80B' },
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    { id: 'mistral-31-24b', name: 'Mistral 3.1 24B' },
  ],
  openrouter: [
    { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', name: 'Dolphin-Venice 24B (free)' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Hermes 3 405B (free)' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)' },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)' },
    { id: 'openrouter/free', name: 'Free Models Router' },
  ],
  cerebras: [
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    { id: 'qwen-3-32b', name: 'Qwen 3 32B' },
    { id: 'llama3.1-8b', name: 'Llama 3.1 8B' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
    { id: 'qwen/qwen3-32b', name: 'Qwen3 32B' },
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct' },
  ],
  xai: [
    { id: 'grok-4', name: 'Grok 4' },
    { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast (reasoning)' },
    { id: 'grok-3', name: 'Grok 3' },
    { id: 'grok-3-mini', name: 'Grok 3 Mini' },
    { id: 'grok-code-fast-1', name: 'Grok Code Fast' },
  ],
  nvidia: [
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct' },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B Instruct' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron 3 Nano 30B' },
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
  ],
};

export const DEFAULT_MODELS: Record<string, string> = {
  venice: 'venice-uncensored',
  openrouter: 'qwen/qwen3-coder:free',
  cerebras: 'llama-3.3-70b',
  groq: 'llama-3.3-70b-versatile',
  xai: 'grok-4',
  nvidia: 'meta/llama-3.3-70b-instruct',
};

export type ProviderKeys = Record<string, string>;

export function loadProviderKeys(): ProviderKeys {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ProviderKeys;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveProviderKeys(keys: ProviderKeys): void {
  try {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));
  } catch { /* ignore */ }
}

export function getProviderKey(providerId: string): string {
  const keys = loadProviderKeys();
  return (keys[providerId] || '').trim();
}

export function loadRoleModels(): Record<RoleId, RoleModel> {
  try {
    const raw = localStorage.getItem(ROLES_STORAGE);
    if (!raw) return { ...DEFAULT_ROLE_MODELS };
    const parsed = JSON.parse(raw) as Partial<Record<RoleId, RoleModel>>;
    return {
      write:  { ...DEFAULT_ROLE_MODELS.write,  ...parsed.write },
      review: { ...DEFAULT_ROLE_MODELS.review, ...parsed.review },
      plan:   { ...DEFAULT_ROLE_MODELS.plan,   ...parsed.plan },
    };
  } catch {
    return { ...DEFAULT_ROLE_MODELS };
  }
}

export function saveRoleModels(roles: Record<RoleId, RoleModel>): void {
  try {
    localStorage.setItem(ROLES_STORAGE, JSON.stringify(roles));
  } catch { /* ignore */ }
}

export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
  uncensored?: boolean;
  free?: boolean;
  paid?: boolean;
  categories?: string[];
  provider?: string;
}

const modelCache = new Map<string, CatalogModel[]>();

export async function fetchModels(providerId: string, apiKey?: string): Promise<CatalogModel[]> {
  const cacheKey = `${providerId}:${apiKey ? 'byok' : 'env'}`;
  if (modelCache.has(cacheKey) && !apiKey) return modelCache.get(cacheKey)!;

  const headers: Record<string, string> = {};
  if (apiKey) headers['X-Provider-Key'] = apiKey;

  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(providerId)}`, { headers });
    const data = await res.json() as { models?: CatalogModel[] };
    const raw = Array.isArray(data.models) && data.models.length
      ? data.models
      : (FALLBACK_MODELS[providerId] || []);
    const models = raw.map((m) => {
      const free = inferFree(providerId, m);
      return { ...m, provider: providerId, free, paid: !free };
    });
    if (!apiKey) modelCache.set(cacheKey, models);
    return models;
  } catch {
    return (FALLBACK_MODELS[providerId] || []).map((m) => {
      const free = inferFree(providerId, m);
      return { ...m, provider: providerId, free, paid: !free };
    });
  }
}

/** Read a File as text (for code/docs) or data URL (for images). */
export function readUpload(file: File): Promise<{ kind: 'text' | 'image'; name: string; content: string }> {
  return new Promise((resolve, reject) => {
    const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      const result = String(reader.result || '');
      if (isImage) {
        resolve({ kind: 'image', name: file.name, content: result });
      } else {
        // FileReader as text
        resolve({ kind: 'text', name: file.name, content: result });
      }
    };
    if (isImage) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}
