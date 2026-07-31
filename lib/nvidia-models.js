/**
 * NVIDIA NIM model discovery.
 *
 * Correct sources (in order):
 *   1. NVCF account functions (api.nvcf.nvidia.com) — what THIS key can invoke
 *   2. integrate.api.nvidia.com/v1/models — OpenAI-compatible catalog
 *
 * Never invent model IDs. Curated FALLBACK_MODELS.nvidia is last resort only.
 */

const INTEGRATE_MODELS = 'https://integrate.api.nvidia.com/v1/models';
const NVCF_FUNCTIONS =
  'https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=authorized&visibility=private&visibility=public';

/** Non-chat / broken-for-chat junk that still appears in NVIDIA's public list. */
const DROP_RE =
  /embed|rerank|retrieval|whisper|tts|nv-embed|neva|cosmos|sdxl|diffusion|guard|safety|ocr|deplot|kosmos|fuyu|vision|(?:^|[\/-])vl(?:$|[\/-])|reward|parse|asr|transcri|image|video|flux|stable-diffusion|nvclip|vila|riva-translate|ising-calibration|nemotron-4-340b/i;

function prettyName(id) {
  const leaf = String(id || '').split('/').pop() || id;
  return String(leaf)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isNvidiaChatModelId(id) {
  const s = String(id || '');
  if (!s || DROP_RE.test(s)) return false;
  if (/instruct|chat|coder|nemotron|llama|qwen|gemma|mistral|mixtral|deepseek|kimi|glm|jamba|dbrx|phi-|granite|codestral|minimax|starcoder|yi-|palmyra|gpt-oss|step-|laguna|zamba|inkling|nemo-minitron|chatqa|super-|ultra-|nano-|flash|pro|medium|large|scout|maverick/i.test(s)) {
    return true;
  }
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

function modelIdsFromNvcfFunctions(data) {
  const functions = Array.isArray(data?.functions) ? data.functions : [];
  const ids = [];
  const seen = new Set();

  for (const fn of functions) {
    const status = String(fn?.status || '').toUpperCase();
    if (status && status !== 'ACTIVE') continue;

    const models = Array.isArray(fn?.models) ? fn.models : [];
    let added = false;
    for (const mod of models) {
      const name = mod?.name;
      if (!name || seen.has(name)) continue;
      const uris = mod?.llmConfig?.uris || [];
      const looksChat =
        uris.some((u) => /chat\/completions/i.test(String(u))) ||
        isNvidiaChatModelId(name);
      if (!looksChat) continue;
      seen.add(name);
      ids.push({
        id: name,
        name: prettyName(name),
        description: fn.description || '',
        functionId: fn.id || null,
        status: fn.status || null,
      });
      added = true;
    }

    if (!added && fn?.name && !seen.has(fn.name) && isNvidiaChatModelId(fn.name)) {
      const llmUris = fn?.llmInvocationConfig?.uris || [];
      const ok =
        !llmUris.length ||
        llmUris.some((u) => /chat\/completions/i.test(String(u)));
      if (ok) {
        seen.add(fn.name);
        ids.push({
          id: fn.name,
          name: prettyName(fn.name),
          description: fn.description || '',
          functionId: fn.id || null,
          status: fn.status || null,
        });
      }
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
 * Resolve the NVIDIA chat model list for this request.
 * @returns {Promise<{ models: Array, source: string, warning?: string, note?: string }>}
 */
export async function resolveNvidiaModels({ apiKey } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  let nvcfWarn;

  if (key) {
    try {
      const nvcf = await fetchJson(NVCF_FUNCTIONS, key);
      if (nvcf.ok) {
        const fromAccount = filterNvidiaChatModels(modelIdsFromNvcfFunctions(nvcf.data));
        if (fromAccount.length) {
          return {
            models: fromAccount,
            source: 'nvcf-account',
            note: 'Listed from your NVIDIA account functions (NVCF).',
          };
        }
        nvcfWarn = 'NVCF returned no ACTIVE chat functions for this key.';
      } else {
        nvcfWarn = nvcf.data?.detail || nvcf.data?.title || `NVCF HTTP ${nvcf.status}`;
      }
    } catch (err) {
      nvcfWarn = err.message || 'NVCF list failed';
    }
  }

  try {
    const cat = await fetchJson(INTEGRATE_MODELS, key || undefined);
    if (cat.ok) {
      const models = filterNvidiaChatModels(normalizeIntegrateCatalog(cat.data));
      if (models.length) {
        return {
          models,
          source: key ? 'integrate-live' : 'integrate-public',
          warning: nvcfWarn,
          note: key
            ? 'NVCF account list empty/unavailable — showing filtered integrate.api.nvidia.com catalog. Some IDs may still 404 if your org lacks Public API Endpoints.'
            : 'Add your NVIDIA key (Keys) for the account-authorized list. Public catalog can include models your account cannot call.',
        };
      }
    }
    return {
      models: [],
      source: 'empty',
      warning: cat.data?.detail || cat.data?.error || `integrate HTTP ${cat.status}`,
    };
  } catch (err) {
    return {
      models: [],
      source: 'empty',
      warning: err.message || 'NVIDIA catalog fetch failed',
    };
  }
}
