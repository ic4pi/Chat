/**
 * Free vs paid + category tags for chat models.
 *
 * Free (no unlock): Venice curated catalog + OpenRouter free-tier (:free / $0).
 * Paid (password): everything else — OpenRouter paid, Cerebras, Groq, NVIDIA.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Normalize secrets from Vercel (trim, strip wrapping quotes / BOM). */
function cleanSecret(value) {
  let s = String(value ?? '').replace(/^\uFEFF/, '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function sha256buf(s) {
  return createHash('sha256').update(String(s), 'utf8').digest();
}

/** Constant-time string compare that works for unequal lengths. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a || !b) return false;
  try {
    return timingSafeEqual(sha256buf(a), sha256buf(b));
  } catch {
    return false;
  }
}

/** All accepted unlock secrets (PAID_MODELS_PASSWORD and/or ADMIN_PASSWORD). */
export function paidUnlockSecrets() {
  const paid = cleanSecret(process.env.PAID_MODELS_PASSWORD);
  const admin = cleanSecret(process.env.ADMIN_PASSWORD);
  const user = cleanSecret(process.env.ADMIN_USERNAME);
  const out = [];
  if (paid) out.push(paid);
  if (admin && !out.some((s) => safeEqual(s, admin))) out.push(admin);
  // People sometimes paste "user:pass" from Basic auth muscle memory.
  if (user && admin) {
    const combo = `${user}:${admin}`;
    if (!out.some((s) => safeEqual(s, combo))) out.push(combo);
  }
  return out;
}

/** @deprecated use paidUnlockSecrets — kept for call sites that want "a" password. */
export function paidModelsPassword() {
  return paidUnlockSecrets()[0] || '';
}

export function paidUnlockConfigured() {
  return paidUnlockSecrets().length > 0;
}

/**
 * True if submitted matches PAID_MODELS_PASSWORD or ADMIN_PASSWORD
 * (or username:password).
 */
export function verifyPaidPassword(submitted) {
  const raw = cleanSecret(submitted);
  if (!raw) return false;
  const secrets = paidUnlockSecrets();
  if (!secrets.length) return false;
  for (const expected of secrets) {
    if (safeEqual(raw, expected)) return true;
  }
  return false;
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
 * Body: paidPassword | password
 */
export function paidPasswordFromRequest(req) {
  const header = req.headers?.['x-paid-password'];
  if (typeof header === 'string' && header.trim()) return header.trim();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }
  body = body || {};
  for (const key of ['paidPassword', 'password', 'pass']) {
    if (typeof body[key] === 'string' && body[key].trim()) return body[key].trim();
  }
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
