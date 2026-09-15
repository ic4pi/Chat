/**
 * Image attachments for chat models that cannot take them.
 *
 * Most of the uncensored text models this app ships (Venice's Gemma/Qwen
 * uncensored builds especially) reject an OpenAI-style `image_url` part with a
 * flat `400 Invalid request parameters` — the upload never gets read and the
 * turn is lost. Instead of forwarding a request we know will 400, the chat API
 * runs the images through a vision-capable sibling model on the SAME provider
 * and the SAME key, then hands the chosen model a plain-text description.
 *
 * When no vision model is reachable the images are still removed and replaced
 * with an honest note, so the reply arrives explaining what happened rather
 * than as a provider error.
 */

const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 12_000;
const DESCRIBE_TIMEOUT_MS = 90_000;
/** Reading more than this per turn costs more than it's worth. */
const MAX_IMAGES = 4;

/** Per-lambda catalog cache: providerId -> { at, vision: Map<id, boolean> }. */
const catalogCache = new Map();

/**
 * Last-resort guess when a catalog exposes no modality field. Only consulted
 * for providers whose model list says nothing either way.
 */
const VISION_ID_HINT =
  /vision|multimodal|(?:^|[/\-_])vl(?:$|[/\-_])|llava|pixtral|internvl|gemma-3|mistral-31|maverick|scout|gpt-4o|gpt-4\.1|gpt-5|claude-|gemini|grok-4|grok-2-vision/i;

/** Prefer the cheap, fast vision models when several qualify. */
const VISION_PREFERENCE = /small|mini|lite|flash|7b|8b|11b|12b|2\.5-vl|24b/i;

export function isImagePart(part) {
  return Boolean(part) && typeof part === 'object' && part.type === 'image_url';
}

/** True when any message carries an OpenAI-style image part. */
export function hasImageParts(messages) {
  return (Array.isArray(messages) ? messages : []).some(
    (m) => Array.isArray(m?.content) && m.content.some(isImagePart),
  );
}

function collectImageUrls(messages) {
  const urls = [];
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      if (!isImagePart(part)) continue;
      const url = part.image_url?.url || part.image_url;
      if (typeof url === 'string' && url) urls.push(url);
    }
  }
  return urls;
}

/**
 * Collapse every multimodal message down to a plain string, appending `note`
 * (the descriptions, or an explanation) to the last message that had images.
 */
export function flattenImageMessages(messages, note) {
  let lastWithImages = -1;
  messages.forEach((m, i) => {
    if (Array.isArray(m?.content) && m.content.some(isImagePart)) lastWithImages = i;
  });

  return messages.map((m, i) => {
    if (!Array.isArray(m?.content)) return { role: m.role, content: m.content };
    const text = m.content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim();
    const suffix = i === lastWithImages && note ? `${text ? '\n\n' : ''}${note}` : '';
    return { role: m.role, content: `${text}${suffix}` };
  });
}

async function fetchJson(url, { apiKey, extraHeaders, timeoutMs = CATALOG_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `id -> supportsVision` straight from the provider's own catalog. Venice
 * states it outright; OpenRouter lists input modalities. Anything else returns
 * an empty map and falls back to the id hint.
 */
async function loadVisionCatalog(providerId, { modelsUrl, apiKey, extraHeaders }) {
  const cached = catalogCache.get(providerId);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.vision;

  const vision = new Map();
  const data = modelsUrl ? await fetchJson(modelsUrl, { apiKey, extraHeaders }) : null;
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  for (const m of list) {
    if (!m?.id) continue;
    if (providerId === 'venice') {
      if (m.model_spec?.offline === true) continue;
      const caps = m.model_spec?.capabilities || {};
      if (typeof caps.supportsVision === 'boolean') vision.set(m.id, caps.supportsVision);
      continue;
    }
    const modalities = m.architecture?.input_modalities;
    if (Array.isArray(modalities)) {
      vision.set(m.id, modalities.includes('image'));
    }
  }

  // Don't cache an empty result from a failed fetch as though it were truth.
  if (vision.size) catalogCache.set(providerId, { at: Date.now(), vision });
  return vision;
}

function guessVision(modelId) {
  return VISION_ID_HINT.test(String(modelId || ''));
}

/**
 * Swap image parts for text the chosen model can actually read.
 *
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {string} opts.model            model the user picked
 * @param {object} opts.resolved         resolveProvider() result (url, key, headers)
 * @param {Array}  opts.messages
 * @param {(id: string) => boolean} [opts.canUseModel] gate so a helper model
 *        never reaches past what the caller is already allowed to run
 * @returns {Promise<{ messages: Array, notice?: string }>}
 */
export async function prepareImageMessages({
  providerId,
  model,
  resolved,
  messages,
  canUseModel = () => true,
}) {
  if (!hasImageParts(messages)) return { messages };

  const extraHeaders = typeof resolved?.extraHeaders === 'function' ? resolved.extraHeaders() : {};
  const catalog = await loadVisionCatalog(providerId, {
    modelsUrl: resolved?.modelsUrl || resolved?.publicModelsUrl,
    apiKey: resolved?.apiKey,
    extraHeaders,
  });

  // Catalog unreachable: don't strip an upload on a guess — let the provider
  // answer, and formatProviderError explains the 400 if it refuses.
  if (!catalog.size && !guessVision(model)) return { messages };

  const known = catalog.get(model);
  const supportsVision = typeof known === 'boolean' ? known : guessVision(model);
  if (supportsVision) return { messages };

  const urls = collectImageUrls(messages).slice(0, MAX_IMAGES);
  const helper = pickVisionModel(catalog, { exclude: model, canUseModel });

  if (helper && urls.length) {
    try {
      const descriptions = await describeImages({ resolved, providerId, helper, urls });
      if (descriptions.some((d) => d.trim())) {
        const body = descriptions
          .map((d, i) => `Image ${i + 1}: ${d.trim() || '(could not be read)'}`)
          .join('\n\n');
        return {
          messages: flattenImageMessages(
            messages,
            `[The attached image${urls.length > 1 ? 's were' : ' was'} read by ${helper}` +
              ` because ${model} cannot take images directly. Description follows.]\n\n${body}`,
          ),
          notice: `${model} can't read images — described ${urls.length} with ${helper}.`,
        };
      }
    } catch {
      // fall through to the honest note
    }
  }

  const why = helper
    ? `and reading ${urls.length > 1 ? 'them' : 'it'} with ${helper} failed`
    : 'and no vision-capable model is available on this provider key';
  return {
    messages: flattenImageMessages(
      messages,
      `[${urls.length} image${urls.length > 1 ? 's were' : ' was'} attached, but ${model} cannot` +
        ` take images ${why}. Say so plainly and ask for a description, or suggest switching models.]`,
    ),
    notice: `${model} can't read images — they were left out of this request.`,
  };
}

/** First catalog model that can see, preferring the cheap/small ones. */
export function pickVisionModel(catalog, { exclude, canUseModel = () => true } = {}) {
  const candidates = [];
  for (const [id, supports] of catalog.entries()) {
    if (!supports || id === exclude) continue;
    if (!canUseModel(id)) continue;
    candidates.push(id);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const pa = VISION_PREFERENCE.test(a) ? 0 : 1;
    const pb = VISION_PREFERENCE.test(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
  return candidates[0];
}

const DESCRIBE_PROMPT =
  'Describe this image for someone who cannot see it. Transcribe every piece of visible' +
  ' text verbatim (including error messages, code, labels and UI chrome), then describe the' +
  ' layout and anything else that matters. Be literal and complete. No preamble.';

async function describeImages({ resolved, providerId, helper, urls }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DESCRIBE_TIMEOUT_MS);
  try {
    const calls = urls.map(async (url) => {
      const body = {
        model: helper,
        stream: false,
        max_tokens: 1200,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: DESCRIBE_PROMPT },
              { type: 'image_url', image_url: { url } },
            ],
          },
        ],
      };
      if (providerId === 'venice') {
        body.venice_parameters = { include_venice_system_prompt: false };
      }
      const res = await fetch(resolved.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resolved.apiKey}`,
          ...(typeof resolved.extraHeaders === 'function' ? resolved.extraHeaders() : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return '';
      const data = await res.json().catch(() => null);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
      }
      return '';
    });
    return await Promise.all(calls);
  } finally {
    clearTimeout(timer);
  }
}
