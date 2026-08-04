/**
 * Free vs paid + category tags for chat models.
 *
 * Free (no unlock): Venice curated catalog + OpenRouter free-tier (:free / $0).
 * Paid (password): everything else — OpenRouter paid, Cerebras, Groq, NVIDIA.
 */

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Password that unlocks paid models. Prefers PAID_MODELS_PASSWORD, else ADMIN_PASSWORD. */
export function paidModelsPassword() {
  return (
    (process.env.PAID_MODELS_PASSWORD || '').trim() ||
    (process.env.ADMIN_PASSWORD || '').trim() ||
    ''
  );
}

export function paidUnlockConfigured() {
  return !!paidModelsPassword();
}

export function verifyPaidPassword(submitted) {
  const expected = paidModelsPassword();
  if (!expected) return false;
  return safeEqual(String(submitted || ''), expected);
}

export function inferFree(providerId, model = {}) {
  if (model.free === true) return true;
  if (model.free === false) return false;
  const id = String(model.id || '');
  if (providerId === 'venice') return true;
  if (providerId === 'openrouter') {
    if (id === 'openrouter/free') return true;
    if (/:free$/i.test(id)) return true;
    if (model.pricing?.prompt === '0' || model.pricing?.prompt === 0) return true;
    if (/\(free\)/i.test(String(model.name || ''))) return true;
    return false;
  }
  // Cerebras / Groq / NVIDIA burn site (or BYOK) credits → paid gate.
  return false;
}

export function inferCategories(providerId, model = {}) {
  const hay = `${model.id || ''} ${model.name || ''} ${model.description || ''}`.toLowerCase();
  const cats = new Set();

  if (
    /coder|codestral|starcoder|codellama|deepseek-coder|qwen3?-coder|devstral|programming|\bcode\b/.test(
      hay,
    )
  ) {
    cats.add('coder');
  }
  if (
    /role.?play|mythomax|creative|story|novel|fiction|erotica|uncensored-role|hermes|mytho/.test(
      hay,
    )
  ) {
    cats.add('creative');
  }
  if (/uncensored|dolphin|heretic|abliterated|venice-uncensored/.test(hay)) {
    cats.add('uncensored');
  }
  if (/reason|thinking|\br1\b|qwq|orchestrat/.test(hay)) {
    cats.add('reasoning');
  }
  if (
    cats.size === 0 ||
    /instruct|chat|general|assistant|versatile|turbo|flash|nano|scout/.test(hay)
  ) {
    cats.add('general');
  }
  return [...cats];
}

/** Attach free + categories onto a model object (does not mutate if already set). */
export function enrichModel(providerId, model = {}) {
  const free = inferFree(providerId, model);
  const categories =
    Array.isArray(model.categories) && model.categories.length
      ? model.categories
      : inferCategories(providerId, model);
  return {
    ...model,
    provider: providerId,
    free,
    paid: !free,
    categories,
  };
}

export function enrichModels(providerId, models) {
  return (models || []).map((m) => enrichModel(providerId, m));
}

export function isPaidModel(providerId, modelId, modelMeta) {
  if (modelMeta && typeof modelMeta.free === 'boolean') return !modelMeta.free;
  return !inferFree(providerId, { id: modelId, ...(modelMeta || {}) });
}

/**
 * Read paid-unlock password from request (header or body).
 * Header: X-Paid-Password
 * Body: paidPassword
 */
export function paidPasswordFromRequest(req) {
  const header = req.headers?.['x-paid-password'];
  if (typeof header === 'string' && header) return header;
  const body = req.body || {};
  if (typeof body.paidPassword === 'string') return body.paidPassword;
  return '';
}

/**
 * Gate paid models. Returns null if allowed, or { status, error } to send.
 * Free models always pass. If no password is configured, paid models are locked
 * (fail closed) so the site cannot accidentally expose paid catalog.
 */
export function requirePaidAccess(req, providerId, modelId, modelMeta) {
  if (!isPaidModel(providerId, modelId, modelMeta)) return null;
  if (!paidUnlockConfigured()) {
    return {
      status: 403,
      error:
        'Paid models are locked. Set PAID_MODELS_PASSWORD (or ADMIN_PASSWORD) in Vercel, then unlock in the Model picker.',
    };
  }
  const submitted = paidPasswordFromRequest(req);
  if (!verifyPaidPassword(submitted)) {
    return {
      status: 403,
      error: 'Paid model locked. Enter the paid-models password in the Model picker to unlock.',
    };
  }
  return null;
}
