/**
 * NVIDIA NIM model discovery — correct endpoints only.
 *
 * Chat always uses:
 *   POST https://integrate.api.nvidia.com/v1/chat/completions
 *
 * Model IDs must come from NVIDIA’s own lists, never hand-invented:
 *   1. NVCF account functions (api.nvcf.nvidia.com) — what THIS key can invoke
 *   2. Intersected with integrate.api.nvidia.com/v1/models — valid chat IDs
 *
 * If NVCF is empty/unavailable, fall back to the filtered integrate catalog
 * (still real IDs — may 404 if the org lacks Public API Endpoints).
 */

const INTEGRATE_BASE = 'https://integrate.api.nvidia.com/v1';
const INTEGRATE_MODELS = `${INTEGRATE_BASE}/models`;
const INTEGRATE_CHAT = `${INTEGRATE_BASE}/chat/completions`;

const NVCF_FUNCTIONS =
  'https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=authorized&visibility=private&visibility=public';

/** Non-chat / broken-for-chat junk that still appears in NVIDIA's public list. */
const DROP_RE =
  /embed|rerank|retrieval|whisper|tts|nv-embed|neva|cosmos|sdxl|diffusion|guard|safety|ocr|deplot|kosmos|fuyu|vision|(?:^|[\/-])vl(?:$|[\/-])|reward|parse|asr|transcri|image|video|flux|stable-diffusion|nvclip|vila|riva-translate|ising-calibration|nemotron-4-340b|content-safety/i;

/** Positive signal that this is a chat/completions-capable LLM id. */
const CHAT_RE =
  /instruct|chat|coder|nemotron|llama|qwen|gemma|mistral|mixtral|deepseek|kimi|glm|jamba|dbrx|phi-|granite|codestral|minimax|starcoder|yi-|palmyra|gpt-oss|step-|laguna|zamba|inkling|nemo-minitron|chatqa|super-|ultra-|nano-|flash|pro|medium|large|scout|maverick|omini|omni|reasoning/i;

function prettyName(id) {
  const leaf = String(id || '').split('/').pop() || id;
  return String(leaf)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function nvidiaChatCompletionsUrl() {
  return INTEGRATE_CHAT;
}

export function isNvidiaChatModelId(id) {
  const s = String(id || '');
  if (!s || DROP_RE.test(s)) return false;
  if (CHAT_RE.test(s)) return true;
  return false;
}

export function filterNvidiaChatModels(models) {
  const seen = new Set();
  const out = [];
  for (const m of models || []) {
    const id = m?.id;
    if (!id || seen.has(id) || !isNvidiaChatModelId(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: m.name && m.name !== id ? m.name : prettyName(id),
      description: m.description || '',
      contextTokens: m.contextTokens ?? m.context_length ?? null,
      uncensored: /uncensored|dolphin|hermes|heretic|abliterated/i.test(id),
    });
  }
  return out.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

async function fetchJson(url, apiKey) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const upstream = await fetch(url, { headers });
  const rawText = await upstream.text();
  let data;
  try { data = JSON.parse(rawText); } catch { data = { error: rawText }; }
  return { ok: upstream.ok, status: upstream.status, data };
}

/**
 * Pull candidate model IDs from an NVCF function record.
 * Prefer llmConfig / invocation URIs that point at chat/completions.
 */
function idsFromNvcfFunction(fn) {
  const out = [];
  const seen = new Set();
  const push = (id) => {
    const s = String(id || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  const models = Array.isArray(fn?.models) ? fn.models : [];
  for (const mod of models) {
    const uris = [
      ...(Array.isArray(mod?.llmConfig?.uris) ? mod.llmConfig.uris : []),
      ...(Array.isArray(mod?.apiEndpoints) ? mod.apiEndpoints : []),
    ].map(String);

    const hasChatUri = uris.some((u) => /chat\/completions/i.test(u));
    const name = mod?.name || mod?.id;
    if (name && (hasChatUri || isNvidiaChatModelId(name))) push(name);
  }

  // Some NVCF records put the OpenAI-compatible id on the function itself.
  const llmUris = [
    ...(Array.isArray(fn?.llmInvocationConfig?.uris) ? fn.llmInvocationConfig.uris : []),
    ...(Array.isArray(fn?.ncaConfig?.uris) ? fn.ncaConfig.uris : []),
  ].map(String);
  const fnHasChat = llmUris.some((u) => /chat\/completions/i.test(u));
  if (fn?.name && (fnHasChat || isNvidiaChatModelId(fn.name))) push(fn.name);

  // URIs sometimes embed the model path: .../meta/llama-3.3-70b-instruct/...
  for (const u of llmUris) {
    const m = String(u).match(
      /(?:models?|functions?)\/([a-z0-9_.-]+\/[a-z0-9_.:-]+)/i,
    );
    if (m?.[1] && isNvidiaChatModelId(m[1])) push(m[1]);
  }

  return out;
}

function modelIdsFromNvcfFunctions(data) {
  const functions = Array.isArray(data?.functions) ? data.functions : [];
  const ids = [];
  const seen = new Set();

  for (const fn of functions) {
    const status = String(fn?.status || '').toUpperCase();
    if (status && status !== 'ACTIVE' && status !== 'ACTIVE_ALERT') continue;

    for (const id of idsFromNvcfFunction(fn)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push({
        id,
        name: prettyName(id),
        description: fn.description || '',
        functionId: fn.id || null,
        status: fn.status || null,
      });
    }
  }
  return ids;
}

function normalizeIntegrateCatalog(data) {
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description || '',
      contextTokens: m.context_length || m.context_window || null,
    }))
    .filter((m) => m.id);
}

/**
 * Keep only account-authorized IDs that also exist on the integrate chat catalog.
 * That is the correct OpenAI-compatible endpoint surface.
 */
function intersectWithIntegrate(accountModels, integrateModels) {
  const byId = new Map(integrateModels.map((m) => [m.id, m]));
  const out = [];
  const seen = new Set();
  for (const m of accountModels) {
    const live = byId.get(m.id);
    if (!live || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: live.id,
      name: live.name && live.name !== live.id ? live.name : prettyName(live.id),
      description: live.description || m.description || '',
      contextTokens: live.contextTokens ?? m.contextTokens ?? null,
      uncensored: /uncensored|dolphin|hermes|heretic|abliterated/i.test(live.id),
    });
  }
  return out.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

/**
 * Resolve the NVIDIA chat model list for this request.
 * @returns {Promise<{ models: Array, source: string, warning?: string, note?: string, chatUrl: string }>}
 */
export async function resolveNvidiaModels({ apiKey } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  let nvcfWarn;
  let accountModels = [];

  // Always load the integrate catalog — this is the authoritative chat ID list.
  let integrateModels = [];
  let integrateWarn;
  try {
    const cat = await fetchJson(INTEGRATE_MODELS, key || undefined);
    if (cat.ok) {
      integrateModels = filterNvidiaChatModels(normalizeIntegrateCatalog(cat.data));
    } else {
      integrateWarn =
        cat.data?.detail || cat.data?.error || `integrate HTTP ${cat.status}`;
    }
  } catch (err) {
    integrateWarn = err.message || 'integrate catalog fetch failed';
  }

  if (key) {
    try {
      const nvcf = await fetchJson(NVCF_FUNCTIONS, key);
      if (nvcf.ok) {
        accountModels = filterNvidiaChatModels(modelIdsFromNvcfFunctions(nvcf.data));
        if (!accountModels.length) {
          nvcfWarn = 'NVCF returned no ACTIVE chat functions for this key.';
        }
      } else {
        nvcfWarn = nvcf.data?.detail || nvcf.data?.title || `NVCF HTTP ${nvcf.status}`;
      }
    } catch (err) {
      nvcfWarn = err.message || 'NVCF list failed';
    }
  }

  // Best path: account-authorized ∩ live integrate chat IDs.
  if (accountModels.length && integrateModels.length) {
    const models = intersectWithIntegrate(accountModels, integrateModels);
    if (models.length) {
      return {
        models,
        source: 'nvcf∩integrate',
        chatUrl: INTEGRATE_CHAT,
        note:
          `Listed from your NVIDIA account (NVCF), kept only IDs that exist on ` +
          `${INTEGRATE_CHAT.replace('/chat/completions', '')}/models.`,
        warning: nvcfWarn,
      };
    }
    nvcfWarn =
      (nvcfWarn ? `${nvcfWarn} ` : '') +
      'NVCF IDs did not match any integrate.api chat model — showing integrate catalog.';
  }

  if (integrateModels.length) {
    return {
      models: integrateModels,
      source: key ? 'integrate-live' : 'integrate-public',
      chatUrl: INTEGRATE_CHAT,
      warning: nvcfWarn || integrateWarn,
      note: key
        ? 'Showing filtered integrate.api.nvidia.com catalog. Enable Public API Endpoints on build.nvidia.com for models that 404.'
        : 'Add your NVIDIA key (Keys) so we can intersect with your NVCF-authorized functions.',
    };
  }

  return {
    models: [],
    source: 'empty',
    chatUrl: INTEGRATE_CHAT,
    warning: integrateWarn || nvcfWarn || 'NVIDIA catalog fetch failed',
  };
}
