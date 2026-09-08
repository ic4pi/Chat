/**
 * POST /api/media-generate
 *
 * Body:
 *   {
 *     kind: 'image' | 'video',
 *     provider: 'modal' | 'venice' | 'cloudflare',
 *                             // image: any of the three
 *                             // video: 'modal' only — nothing else is accepted
 *     model?: string,
 *     prompt: string,
 *     negativePrompt?: string,
 *     size?: string,          // image: 1024x1024 | video: 832x480 / 480x832
 *     seconds?: number,       // video length
 *     imageBase64?: string,   // Venice Edit / Wan i2v only (do NOT send on text-to-image)
 *     mimeType?: string,
 *     count?: number,         // image: how many to generate in one batch (modal, max 4)
 *     mode?: string,          // image (modal): text | img2img | expand | pose
 *     strength?: number,      // img2img: 0.05-1.0, how far from the source
 *     expand?: object,        // expand: {left,right,top,bottom} in pixels
 *     controlScale?: number,  // pose: how strictly to follow the skeleton
 *     detectPose?: boolean,   // pose: extract a skeleton from a photo (else
 *                             //       the image IS the skeleton)
 *     accessKey?: string,     // required for provider:'modal' only if VIDEO_ACCESS_KEYS is set
 *   }
 *
 * GET/POST /api/media-generate?op=credit  — admin-only (Basic auth), manage
 * per-person prepaid balances for provider:'modal'. See lib/video-billing.js.
 *   GET  -> { people: [{ name, key, markupPct, balanceUsd }, ...] }
 *   POST { key, usd } -> add usd dollars of credit to that access key
 *                        (usd may be negative to correct a mistake)
 *
 * Env (Vercel → Settings → Environment Variables):
 *   VENICE_API_KEY         — uncensored images + Edit (safe_mode:false)
 *   CLOUDFLARE_ACCOUNT_ID  — Workers AI account id (filtered images)
 *   CLOUDFLARE_API_TOKEN   — API token with Workers AI permission
 *   SUPABASE_URL           — generated video is uploaded here and returned as a
 *   SUPABASE_SERVICE_ROLE_KEY  URL; without these, any clip over ~3MB is
 *                            rejected rather than dying as an opaque 413
 *   MODAL_WAN_ENDPOINT     — self-hosted Wan 2.2 5B video on Modal, scale-to-zero,
 *                            no external content filter (kind:'video', provider:'modal', model:'wan2.2-5b')
 *   MODAL_LTX_ENDPOINT     — self-hosted LTX-Video on Modal, same deal
 *                            (kind:'video', provider:'modal', model:'ltx-video')
 *   MODAL_SDXL_ENDPOINT    — self-hosted SDXL images on Modal (lustify / wai-illustrious),
 *                            same deal (kind:'image', provider:'modal')
 *   VIDEO_ACCESS_KEYS      — JSON array turning on per-person billing for both
 *                            Modal providers: [{"key","name","markupPct"}, ...]
 *                            Unset = Modal image/video stays open/unmetered.
 *   MODAL_L4_RATE_PER_HOUR — override the assumed Modal L4 $/hr used to
 *                            compute cost (default 0.80; check modal.com/pricing)
 *   ADMIN_USERNAME / ADMIN_PASSWORD — gates ?op=credit (see lib/auth.js)
 *   Also requires a Vercel KV / Upstash Redis store attached (lib/kv.js) to
 *   persist balances — without it, everyone reads as $0 balance and gets
 *   rejected (fails closed, not open).
 *
 * Vercel Functions hard-limit request/response bodies at 4.5MB (HTTP 413).
 * Never attach reference images to text-to-image. Prefer webp for Venice.
 */

import { requireAdminAuth } from '../lib/auth.js';
import { storeMediaAsset, decodeDataUrl } from '../lib/hub.js';
import {
  billingEnabled,
  findPerson,
  assertHasCredit,
  chargeForGeneration,
  addCreditUsd,
  listAllBalances,
} from '../lib/video-billing.js';

/** Endpoints get pasted from a browser or a phone, which readily appends a
 *  trailing slash. Modal treats ".../generate/" as a different route and 404s,
 *  so normalise rather than make a slash a config error. */
function cleanEndpoint(url, fallback) {
  return String(url || fallback).trim().replace(/\/+$/, '');
}

/** Stay under Vercel’s 4.5MB JSON body limit (request + response). */
const SAFE_JSON_BYTES = 3_200_000;

const CLOUDFLARE_IMAGE_MODELS = {
  'flux-schnell': '@cf/black-forest-labs/flux-1-schnell',
  'flux-1-schnell': '@cf/black-forest-labs/flux-1-schnell',
  '@cf/black-forest-labs/flux-1-schnell': '@cf/black-forest-labs/flux-1-schnell',
  'sdxl-lightning': '@cf/bytedance/stable-diffusion-xl-lightning',
  '@cf/bytedance/stable-diffusion-xl-lightning': '@cf/bytedance/stable-diffusion-xl-lightning',
  'sdxl': '@cf/stabilityai/stable-diffusion-xl-base-1.0',
  '@cf/stabilityai/stable-diffusion-xl-base-1.0': '@cf/stabilityai/stable-diffusion-xl-base-1.0',
};

/** Venice image models — uncensored when safe_mode is false (native /image/generate). */
const VENICE_IMAGE_MODELS = {
  'z-image-turbo': 'z-image-turbo',
  'lustify-sdxl': 'lustify-sdxl',
  'lustify-v7': 'lustify-v7',
  'lustify-v8': 'lustify-v8',
  'wai-Illustrious': 'wai-Illustrious',
  'wai-illustrious': 'wai-Illustrious',
  chroma: 'chroma',
  'venice-sd35': 'venice-sd35',
  'flux-2-pro': 'flux-2-pro',
  'flux-2-max': 'flux-2-max',
  'qwen-image': 'qwen-image',
  'qwen-image-2': 'qwen-image-2',
};

/** Venice image→image (POST /image/edit). */
const VENICE_EDIT_MODELS = {
  'qwen-edit': 'qwen-edit',
  edit: 'qwen-edit',
  'venice-edit': 'qwen-edit',
  'gpt-image-2-edit': 'gpt-image-2-edit',
};









function stripDataUrl(input) {
  const s = String(input || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (m) return { mime: m[1], b64: m[2] };
  return { mime: null, b64: s.replace(/\s+/g, '') };
}

function approxJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** True when a media JSON payload would trip Vercel’s 4.5MB limit. */
function payloadTooLarge(payload) {
  return approxJsonBytes(payload) > SAFE_JSON_BYTES;
}

function imageResultTooLarge(out) {
  if (!out || out.kind !== 'image' || !Array.isArray(out.images)) return false;
  const hasOnlyUrls = out.images.every((img) => img?.url && !img?.base64);
  if (hasOnlyUrls) return false;
  return payloadTooLarge(out);
}

function oversizeError(kind = 'image') {
  const err = new Error(
    `Generated ${kind} is too large to return through Vercel (4.5MB limit / HTTP 413). ` +
      `Use Venice · Edit with a smaller JPEG, or pick a smaller size.`,
  );
  err.status = 413;
  err.code = 'PAYLOAD_TOO_LARGE';
  return err;
}

/**
 * Upload each generated image and swap its bytes for a URL.
 *
 * Batching makes this necessary rather than merely tidy: one 1024px image
 * survives the response body, four do not. Images that already carry a URL,
 * and every image if storage is unconfigured, are left exactly as they were —
 * the existing oversize guard still catches those.
 */
async function persistImageResult(out) {
  if (out?.kind !== 'image' || !Array.isArray(out.images) || !out.images.length) return out;
  if (!out.images.some((img) => img?.base64)) return out; // already hosted

  const uploaded = await Promise.all(
    out.images.map(async (img) => {
      if (!img?.base64) return img;
      const mimeType = img.mimeType || 'image/webp';
      const bytes = decodeDataUrl(img.base64)?.bytes || Buffer.from(img.base64, 'base64');
      const url = await storeMediaAsset(bytes, mimeType, 'image');
      return url ? { url, mimeType } : img;
    }),
  );

  const stored = uploaded.every((img) => img.url);
  return { ...out, images: uploaded, stored };
}

/**
 * Move a generated video out of the JSON response and into object storage.
 *
 * Vercel's 4.5MB cap applies to the response this function sends the browser,
 * NOT to what it fetches from Modal — so a 20MB clip arrives here fine and
 * then dies on the way out, as an opaque 413 with no error text. Any video
 * beyond a few seconds crosses that line, which is why self-hosted video
 * looked broken while images worked.
 *
 * Uploading here means the browser gets a URL and the bytes never transit
 * Vercel's response path. Modal is unchanged — this works with the apps as
 * they are already deployed.
 *
 * Falls back to leaving the data URL in place when storage is unconfigured
 * AND the clip is small enough to survive, so a short generation still works
 * on a bare install.
 */
async function persistVideoResult(out) {
  const src = out?.videoUrl;
  if (!src || !src.startsWith('data:')) return out; // already a hosted URL

  const decoded = decodeDataUrl(src);
  if (!decoded) return out;

  const url = await storeMediaAsset(decoded.bytes, decoded.mimeType, 'video');
  if (url) {
    return { ...out, videoUrl: url, bytes: decoded.bytes.length, stored: true };
  }

  // No storage. Only inline what will actually fit through the response.
  if (payloadTooLarge(out)) {
    const mb = (decoded.bytes.length / 1_048_576).toFixed(1);
    const err = new Error(
      `Generated video is ${mb}MB — too large to return through Vercel (4.5MB limit / HTTP 413). ` +
        `Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY so video can be stored and returned as a URL, ` +
        `or request a shorter clip.`,
    );
    err.status = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }
  return { ...out, stored: false };
}


function parseSize(size, fallbackW = 1024, fallbackH = 1024) {
  const m = String(size || '').match(/(\d+)\s*[x×*]\s*(\d+)/i);
  if (!m) return { width: fallbackW, height: fallbackH };
  return {
    width: Math.max(256, Math.min(1920, Number(m[1]) || fallbackW)),
    height: Math.max(256, Math.min(1920, Number(m[2]) || fallbackH)),
  };
}


function extractErrorDetail(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    data.error?.message,
    data.error?.detail,
    data.detail,
    data.message,
    data.title,
    Array.isArray(data.errors) ? data.errors.map((e) => e?.message || e).join('; ') : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (c && typeof c !== 'string') {
      try { return JSON.stringify(c); } catch { /* ignore */ }
    }
  }
  return null;
}



function veniceImageKey() {
  return (process.env.VENICE_API_KEY || '').trim();
}

/**
 * Uncensored Venice images — native POST /image/generate with safe_mode:false.
 * Cloudflare keeps its own filter; use Venice or Modal for unrestricted.
 */
async function generateVeniceImage({ prompt, model, size, negativePrompt }) {
  const key = veniceImageKey();
  if (!key) {
    const err = new Error(
      'Missing VENICE_API_KEY in Vercel env. Uncensored images need Venice — same key as chat.',
    );
    err.status = 503;
    throw err;
  }

  const modelId = VENICE_IMAGE_MODELS[model] || model || 'z-image-turbo';
  const { width, height } = parseSize(size, 1024, 1024);
  // Venice caps some models around 1280 on a side — keep requests sane.
  const w = Math.min(1280, Math.max(256, width));
  const h = Math.min(1280, Math.max(256, height));

  const body = {
    model: modelId,
    prompt,
    width: w,
    height: h,
    // webp stays small — PNG base64 often trips Vercel’s 4.5MB (HTTP 413).
    format: 'webp',
    return_binary: false,
    // Critical: default Venice safe_mode blurs adult content. Off = uncensored.
    safe_mode: false,
    hide_watermark: true,
  };
  if (negativePrompt) body.negative_prompt = negativePrompt;

  const upstream = await fetch('https://api.venice.ai/api/v1/image/generate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const rawText = await upstream.text();
  let data;
  try { data = JSON.parse(rawText); } catch { data = { error: rawText }; }

  if (!upstream.ok) {
    const detail =
      extractErrorDetail(data) ||
      (typeof data?.error === 'string' ? data.error : null) ||
      `Venice HTTP ${upstream.status}`;
    const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    err.status = upstream.status || 502;
    throw err;
  }

  const images = [];
  const imagesArr = data?.images || data?.data || [];
  if (Array.isArray(imagesArr)) {
    for (const item of imagesArr) {
      if (typeof item === 'string') {
        const { mime, b64 } = stripDataUrl(item);
        if (b64) images.push({ mimeType: mime || 'image/png', base64: b64 });
        else if (/^https?:\/\//i.test(item)) images.push({ mimeType: 'image/png', url: item });
      } else if (item && typeof item === 'object') {
        const b64 = item.b64_json || item.base64 || item.image || item.url;
        if (typeof b64 === 'string' && /^https?:\/\//i.test(b64)) {
          images.push({ mimeType: item.mimeType || 'image/png', url: b64 });
        } else if (typeof b64 === 'string') {
          const stripped = stripDataUrl(b64);
          images.push({ mimeType: item.mimeType || stripped.mime || 'image/png', base64: stripped.b64 });
        }
      }
    }
  }
  // Some Venice responses: { image: "base64..." } or { images: ["data:image/..."] }
  if (!images.length && typeof data?.image === 'string') {
    const stripped = stripDataUrl(data.image);
    images.push({ mimeType: stripped.mime || 'image/png', base64: stripped.b64 });
  }

  if (!images.length) {
    const err = new Error('Venice returned no image data.');
    err.status = 502;
    throw err;
  }

  // Prefer webp mime when we asked for webp (responses may omit mime).
  for (const img of images) {
    if (img.base64 && (!img.mimeType || img.mimeType === 'image/png')) {
      img.mimeType = 'image/webp';
    }
  }

  if (images.some((img) => img.base64 && String(img.base64).length > 3_000_000)) {
    throw oversizeError('image');
  }

  const blurred = String(upstream.headers.get('x-venice-is-blurred') || '').toLowerCase() === 'true';
  const out = {
    kind: 'image',
    provider: 'venice',
    model: modelId,
    uncensored: !blurred,
    safeMode: false,
    images,
    note: blurred
      ? 'Venice marked this result blurred — try another Venice model (Lustify / WAI / Chroma).'
      : 'Venice · safe_mode off (uncensored).',
  };
  if (imageResultTooLarge(out)) throw oversizeError('image');
  return out;
}

/**
 * Image→image via Venice POST /image/edit (qwen-edit).
 * safe_mode:false keeps edits uncensored like text-to-image.
 */
async function generateVeniceEdit({ prompt, model, imageBase64 }) {
  const key = veniceImageKey();
  if (!key) {
    const err = new Error(
      'Missing VENICE_API_KEY in Vercel env (needed for Venice · Edit).',
    );
    err.status = 503;
    throw err;
  }
  if (!imageBase64) {
    const err = new Error('Venice · Edit needs an uploaded image.');
    err.status = 400;
    throw err;
  }

  const modelId = VENICE_EDIT_MODELS[model] || VENICE_EDIT_MODELS['qwen-edit'];
  const { b64 } = stripDataUrl(imageBase64);

  const upstream = await fetch('https://api.venice.ai/api/v1/image/edit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'image/*,application/json',
    },
    body: JSON.stringify({
      model: modelId,
      prompt,
      image: b64,
      output_format: 'webp',
      safe_mode: false,
    }),
  });

  const ctype = (upstream.headers.get('content-type') || '').toLowerCase();
  if (upstream.ok && ctype.startsWith('image/')) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > 2_400_000) throw oversizeError('image');
    const out = {
      kind: 'image',
      provider: 'venice',
      model: modelId,
      uncensored: true,
      safeMode: false,
      images: [{
        mimeType: ctype.split(';')[0] || 'image/webp',
        base64: buf.toString('base64'),
      }],
      note: 'Venice · Edit (safe_mode off).',
    };
    if (imageResultTooLarge(out)) throw oversizeError('image');
    return out;
  }

  const rawText = await upstream.text();
  let data;
  try { data = JSON.parse(rawText); } catch { data = { error: rawText }; }

  if (!upstream.ok) {
    const detail =
      extractErrorDetail(data) ||
      (typeof data?.error === 'string' ? data.error : null) ||
      `Venice edit HTTP ${upstream.status}`;
    const err = new Error(cleanMediaError(detail));
    err.status = upstream.status || 502;
    throw err;
  }

  const raw =
    (Array.isArray(data.images) && data.images[0]) ||
    data.image ||
    data.result?.image;
  if (!raw || typeof raw !== 'string') {
    const err = new Error('Venice edit returned no image.');
    err.status = 502;
    throw err;
  }
  const clean = String(raw).replace(/^data:image\/\w+;base64,/, '');
  if (clean.length > 3_000_000) throw oversizeError('image');
  const out = {
    kind: 'image',
    provider: 'venice',
    model: modelId,
    uncensored: true,
    safeMode: false,
    images: [{ mimeType: 'image/webp', base64: clean }],
    note: 'Venice · Edit (safe_mode off).',
  };
  if (imageResultTooLarge(out)) throw oversizeError('image');
  return out;
}

function cleanMediaError(msg) {
  return String(msg || '')
    .replace(/^(AIError:\s*)+/gi, '')
    .replace(/\s*\([0-9a-f-]{20,}\)\s*$/i, '')
    .trim();
}






async function generateCloudflareImage({ prompt, model, size, negativePrompt }) {
  const { accountId, token } = cloudflareCreds();
  if (!accountId || !token) {
    const err = new Error(
      'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in Vercel env. ' +
        'Create a token with Workers AI permissions: https://developers.cloudflare.com/workers-ai/get-started/rest-api/'
    );
    err.status = 503;
    throw err;
  }

  const modelId = CLOUDFLARE_IMAGE_MODELS[model] || CLOUDFLARE_IMAGE_MODELS['flux-schnell'];
  const { width, height } = parseSize(size, 1024, 1024);
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${modelId}`;

  const body = { prompt };
  if (/flux-1-schnell/i.test(modelId)) {
    body.steps = 4;
  } else {
    body.width = width;
    body.height = height;
    if (negativePrompt) body.negative_prompt = negativePrompt;
  }

  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const ctype = (upstream.headers.get('content-type') || '').toLowerCase();
  if (upstream.ok && ctype.startsWith('image/')) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    return {
      kind: 'image',
      provider: 'cloudflare',
      model: modelId,
      images: [{ mimeType: ctype.split(';')[0] || 'image/png', base64: buf.toString('base64') }],
    };
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || data.success === false) {
    const detail =
      extractErrorDetail(data) ||
      (Array.isArray(data.errors) && data.errors[0]?.message) ||
      `Cloudflare Workers AI HTTP ${upstream.status}`;
    const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    err.status = upstream.status || 502;
    throw err;
  }

  const result = data.result ?? data;
  let b64 = null;
  let mime = 'image/jpeg';
  if (typeof result?.image === 'string') {
    b64 = result.image;
    mime = 'image/jpeg';
  } else if (typeof result === 'string') {
    b64 = result;
  } else if (result?.image_base64) {
    b64 = result.image_base64;
  }

  if (!b64) {
    const err = new Error('Cloudflare Workers AI returned no image bytes.');
    err.status = 502;
    throw err;
  }

  return {
    kind: 'image',
    provider: 'cloudflare',
    model: modelId,
    images: [{
      mimeType: mime,
      base64: String(b64).replace(/^data:image\/\w+;base64,/, ''),
    }],
  };
}












/**
 * Self-hosted SDXL images on Modal (scale-to-zero, no external content filter).
 * Two checkpoints: lustify (realistic) and wai-illustrious (anime/illustration).
 * Env: MODAL_SDXL_ENDPOINT (defaults to the deployed endpoint below).
 */
const MODAL_SDXL_ENDPOINT = cleanEndpoint(
  process.env.MODAL_SDXL_ENDPOINT,
  'https://ic4pi--sdxl-nsfw-v2-generate.modal.run',
);

const MODAL_IMAGE_MODELS = {
  lustify: 'lustify',
  'wai-illustrious': 'wai-illustrious',
  'wai-Illustrious': 'wai-illustrious',
};

/**
 * The warm endpoint for a given model.
 *
 * Modal derives a web endpoint's URL from the app name plus the function name,
 * so the `warm` function on app `wan-video` is reachable at
 * ic4pi--wan-video-warm.modal.run — the same URL as `generate` with the
 * trailing function name swapped. Deriving it keeps one endpoint env var per
 * app instead of two that can drift apart.
 */
/**
 * Swap the function name on a Modal generate URL for another endpoint on the
 * same app. Modal derives a web endpoint's URL from app name + function name,
 * so `generate`, `warm`, `submit` and `result` differ only in that last
 * segment. Deriving them keeps one env var per app rather than four that can
 * drift apart.
 */
function modalEndpoint(model, fn) {
  const base = /ltx/i.test(model)
    ? MODAL_LTX_ENDPOINT
    : /wan/i.test(model)
      ? MODAL_WAN_ENDPOINT
      : MODAL_SDXL_ENDPOINT;
  return base.replace(/-generate(\.modal\.run)$/, `-${fn}$1`);
}

function warmEndpointFor(model) {
  return modalEndpoint(model, 'warm');
}

/** Clip count for a requested length. Each clip is ~5s; apps re-clamp at 6. */
function clipsForSeconds(seconds) {
  return Math.min(6, Math.max(1, Math.round((Number(seconds) || 5) / 5)));
}

/** Per-model video geometry, matching what each app is built around. */
function videoGeometry(model, size) {
  const isLtx = /ltx/i.test(String(model || ''));
  const fallback = isLtx ? '704x480' : '832x480';
  const dims = String(size || fallback).split(/[x*]/i).map(Number);
  return {
    width: dims[0] || (isLtx ? 704 : 832),
    height: dims[1] || 480,
    fps: isLtx ? 24 : 16,
    num_frames: isLtx ? 121 : 81,
  };
}

/**
 * Modes the self-hosted image app supports beyond plain text-to-image.
 * Each maps to a pipeline built over the same checkpoint, so switching mode
 * costs no extra VRAM or load time.
 */
const MODAL_IMAGE_MODES = new Set(['text', 'img2img', 'expand', 'outpaint', 'pose']);

async function generateModalSdxlImage({
  prompt, negativePrompt, model, size, count,
  mode, imageBase64, strength, expand, controlScale, detectPose,
}) {
  const dims = String(size || '1024x1024').split(/[x*]/i).map(Number);
  const width = dims[0] || 1024;
  const height = dims[1] || 1024;
  const modalModel = MODAL_IMAGE_MODELS[model] || 'lustify';
  const imageMode = MODAL_IMAGE_MODES.has(String(mode || '')) ? String(mode) : 'text';
  if (imageMode !== 'text' && !imageBase64) {
    const err = new Error(`Mode "${imageMode}" needs a source image.`);
    err.status = 400;
    throw err;
  }

  const resp = await fetch(MODAL_SDXL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: negativePrompt || undefined,
      model: modalModel,
      width,
      height,
      n: Math.max(1, Math.min(4, Number(count) || 1)),
      ...(imageMode !== 'text'
        ? {
            mode: imageMode,
            image: imageBase64,
            ...(strength != null ? { strength: Number(strength) } : {}),
            ...(expand ? { expand } : {}),
            ...(controlScale != null ? { control_scale: Number(controlScale) } : {}),
            ...(detectPose != null ? { detect_pose: !!detectPose } : {}),
          }
        : {}),
    }),
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !(body.images_base64?.length || body.image_base64)) {
    // Naming the URL matters more than it looks: a 404 here means the site is
    // pointed at an app that does not exist, and the only way to tell which is
    // to say which one was called. Endpoints are public URLs, not secrets.
    const err = new Error(
      body.error || `Modal SDXL HTTP ${resp.status} calling ${MODAL_SDXL_ENDPOINT}`,
    );
    err.status = resp.status || 502;
    throw err;
  }

  // images_base64 is the batch shape; image_base64 is the older singular key,
  // still sent so a stale app version keeps working.
  const batch = body.images_base64?.length ? body.images_base64 : [body.image_base64];
  const mimeType = body.mime_type || 'image/webp';

  return {
    kind: 'image',
    provider: 'modal',
    model: modalModel,
    images: batch.map((base64) => ({ base64, mimeType })),
    uncensored: true,
    elapsedSeconds: body.elapsed_seconds,
    mode: imageMode,
    note: `Self-hosted SDXL on Modal${imageMode !== 'text' ? ` · ${imageMode}` : ''}${batch.length > 1 ? ` · ${batch.length} images` : ''} (scale-to-zero, no external content filter).`,
  };
}

/**
 * Self-hosted Wan 2.2 5B on Modal (scale-to-zero, no external content filter -
 * nothing here moderates the prompt).
 * Env: MODAL_WAN_ENDPOINT (defaults to the deployed endpoint below).
 */
const MODAL_WAN_ENDPOINT = cleanEndpoint(
  process.env.MODAL_WAN_ENDPOINT,
  'https://ic4pi--wan-video-a14b-generate.modal.run',
);

async function generateModalWanVideo({
  prompt,
  negativePrompt,
  size,
  seconds,
}) {
  const dims = String(size || '832x480').split(/[x*]/i).map(Number);
  const width = dims[0] || 832;
  const height = dims[1] || 480;
  const fps = 16;
  const num_frames = 81; // ~5s per clip at 16fps

  // Longer requests chain multiple 5s clips inside Modal (last frame of each
  // clip feeds the next as its starting frame) instead of one giant single
  // generation - keeps quality/speed per clip consistent. Server-side cap of
  // 6 clips (~30s) is enforced again inside wan_app.py regardless of what's
  // sent here.
  const num_clips = Math.min(6, Math.max(1, Math.round((Number(seconds) || 5) / 5)));

  const resp = await fetch(MODAL_WAN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // fetch follows 303 redirects automatically (and correctly switches to GET,
    // unlike curl -X POST -L which forces POST on the redirect too).
    body: JSON.stringify({
      prompt,
      negative_prompt: negativePrompt || undefined,
      width,
      height,
      num_frames,
      fps,
      num_clips,
    }),
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.video_base64) {
    const err = new Error(
      body.error || `Modal Wan HTTP ${resp.status} calling ${MODAL_WAN_ENDPOINT}`,
    );
    err.status = resp.status || 502;
    throw err;
  }

  return {
    kind: 'video',
    provider: 'modal',
    model: 'wan2.2-5b',
    videoUrl: `data:video/mp4;base64,${body.video_base64}`,
    mime: 'video/mp4',
    uncensored: true,
    elapsedSeconds: body.elapsed_seconds,
    numClips: body.num_clips,
    note: 'Self-hosted Wan 2.2 on Modal (scale-to-zero, no external content filter).',
  };
}

/**
 * Self-hosted LTX-Video on Modal (scale-to-zero, no external content filter).
 * Second video model alongside Wan - faster/lighter, different look. Same
 * request/response shape and clip-chaining approach as generateModalWanVideo.
 * Env: MODAL_LTX_ENDPOINT (defaults to the deployed endpoint below).
 */
const MODAL_LTX_ENDPOINT = cleanEndpoint(
  process.env.MODAL_LTX_ENDPOINT,
  'https://ic4pi--ltx-video-generate.modal.run',
);

async function generateModalLtxVideo({ prompt, negativePrompt, size, seconds }) {
  const dims = String(size || '704x480').split(/[x*]/i).map(Number);
  const width = dims[0] || 704;
  const height = dims[1] || 480;
  const fps = 24;
  const num_frames = 121; // ~5s per clip at 24fps

  const num_clips = Math.min(6, Math.max(1, Math.round((Number(seconds) || 5) / 5)));

  const resp = await fetch(MODAL_LTX_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: negativePrompt || undefined,
      width,
      height,
      num_frames,
      fps,
      num_clips,
    }),
  });

  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.video_base64) {
    const err = new Error(
      body.error || `Modal LTX HTTP ${resp.status} calling ${MODAL_LTX_ENDPOINT}`,
    );
    err.status = resp.status || 502;
    throw err;
  }

  return {
    kind: 'video',
    provider: 'modal',
    model: 'ltx-video',
    videoUrl: `data:video/mp4;base64,${body.video_base64}`,
    mime: 'video/mp4',
    uncensored: true,
    elapsedSeconds: body.elapsed_seconds,
    numClips: body.num_clips,
    note: 'Self-hosted LTX-Video on Modal (scale-to-zero, no external content filter).',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Cold-start warmup. The browser fires this when someone focuses the prompt
  // box, so the ~60s of weight loading overlaps the time they spend typing
  // instead of being tacked onto the generate click.
  //
  // Proxied rather than called from the browser because the Modal endpoints
  // send no CORS headers. Deliberately fire-and-forget: the response is not
  // awaited past dispatch, no error is surfaced, and a failed warm just means
  // the generation pays the cold start it would have paid anyway.
  if (String(req.query?.op || '') === 'warm') {
    const target = String(req.query?.model || req.body?.model || '');
    const endpoint = warmEndpointFor(target);

    try {
      // 5s ceiling: spawn() returns almost immediately, and nothing downstream
      // needs the answer.
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Warming is best-effort by design.
    }
    return res.status(202).json({ warming: true, target: target || 'sdxl' });
  }

  // Async video jobs.
  //   POST ?op=submit  {model, prompt, ...}  -> { jobId, model }
  //   POST ?op=result  {jobId, model}        -> { status: running|done|... }
  //
  // The synchronous path is bounded by this function's own 800s timeout, which
  // is what caps clip length — not the models. Splitting submit from result
  // keeps every request short, so length is bounded by the Modal app's own
  // hour-long timeout instead. A finished clip goes through the same storage
  // path as the sync route, so the bytes still never reach the response.
  if (String(req.query?.op || '') === 'submit') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const {
      model: jm, prompt: jp, negativePrompt: jn, size: js, seconds: jsec, accessKey: jk,
      video: jv, strength: jstr, keyframes: jkf,
    } = req.body || {};
    if (!jp || !String(jp).trim()) return res.status(400).json({ error: 'prompt is required' });

    // Billing is checked at submit: a job that cannot be paid for should never
    // occupy a GPU. The charge itself lands at collection, when the real
    // elapsed time is known.
    if (billingEnabled()) {
      const person = findPerson(jk);
      if (!person) return res.status(401).json({ error: 'Invalid or missing access key.' });
      try {
        await assertHasCredit(person);
      } catch (creditErr) {
        return res.status(creditErr.status || 402).json({ error: creditErr.message });
      }
    }

    const geo = videoGeometry(jm, js);
    const upstream = await fetch(modalEndpoint(jm, 'submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: String(jp).trim(),
        negative_prompt: jn || undefined,
        ...geo,
        num_clips: clipsForSeconds(jsec),
        // Restyling an existing clip (Wan) and pinning keyframes to timestamps
        // (LTX) both replace the clip chain rather than adding to it, so
        // num_clips is ignored downstream when either is present.
        ...(jv ? { video: jv, strength: Number(jstr) || 0.6 } : {}),
        ...(Array.isArray(jkf) && jkf.length ? { keyframes: jkf } : {}),
      }),
    });
    const sub = await upstream.json().catch(() => ({}));

    // A 404 means this Modal app predates the submit/result endpoints — the
    // deployed apps only expose `generate`. That is the expected state until
    // modal/ is deployed, and it must not read as a broken generator: the
    // caller falls back to the synchronous route, which those apps do serve.
    if (upstream.status === 404) {
      return res.status(501).json({
        code: 'ASYNC_UNAVAILABLE',
        error:
          'This Modal app has no submit endpoint yet — deploy modal/ to enable ' +
          'long video. Falling back to a single blocking request.',
      });
    }

    if (!upstream.ok || sub.error || !sub.job_id) {
      return res
        .status(upstream.ok ? 502 : upstream.status)
        .json({
          error:
            sub.error || `Modal submit HTTP ${upstream.status} calling ${modalEndpoint(jm, 'submit')}`,
        });
    }
    return res.status(202).json({ jobId: sub.job_id, model: jm, status: 'running' });
  }

  if (String(req.query?.op || '') === 'result') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    const { jobId, model: rm, accessKey: rk } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });

    const upstream = await fetch(modalEndpoint(rm, 'result'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    });
    const job = await upstream.json().catch(() => ({}));

    if (job.status !== 'done') {
      // running | expired | error — passed through as-is so the client can
      // tell "still working" from "this will never finish".
      return res.status(job.status === 'running' ? 200 : 502).json({
        status: job.status || 'error',
        ...(job.error ? { error: job.error } : {}),
      });
    }

    let out = {
      kind: 'video',
      provider: 'modal',
      model: rm,
      videoUrl: `data:video/mp4;base64,${job.video_base64}`,
      mime: 'video/mp4',
      uncensored: true,
      elapsedSeconds: job.elapsed_seconds,
      numClips: job.num_clips,
    };

    try {
      out = await persistVideoResult(out);
    } catch (persistErr) {
      return res
        .status(persistErr.status || 502)
        .json({ status: 'error', error: persistErr.message });
    }

    if (billingEnabled()) {
      const person = findPerson(rk);
      if (person) {
        const billing = await chargeForGeneration(person, {
          elapsedSeconds: out.elapsedSeconds,
          prompt: 'async video job',
        });
        out.billing = { name: person.name, markupPct: person.markupPct, ...billing };
      }
    }

    return res.status(200).json({ status: 'done', ...out });
  }

  // Admin-only balance management for the Modal video access keys:
  //   GET  /api/media-generate?op=credit             -> list everyone's balance
  //   POST /api/media-generate?op=credit {key, usd}   -> add (or subtract) credit
  // Basic-auth protected, same ADMIN_USERNAME/ADMIN_PASSWORD as /admin.
  if (String(req.query?.op || '') === 'credit') {
    if (!requireAdminAuth(req, res)) return;
    if (req.method === 'GET') {
      return res.status(200).json({ people: await listAllBalances() });
    }
    if (req.method === 'POST') {
      const { key, usd } = req.body || {};
      if (!key || !Number.isFinite(Number(usd))) {
        return res.status(400).json({ error: 'Body must be { key, usd }' });
      }
      const person = findPerson(key);
      if (!person) return res.status(404).json({ error: 'No access key matches that key.' });
      const balanceUsd = await addCreditUsd(key, Number(usd));
      return res.status(200).json({ ok: true, name: person.name, balanceUsd });
    }
    return res.status(405).json({ error: 'GET or POST only' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    kind = 'image',
    provider,
    model,
    prompt,
    negativePrompt,
    size,
    seconds,
    count,
    mode,
    strength,
    expand,
    controlScale,
    detectPose,
    imageBase64,
    mimeType,
    accessKey,
  } = req.body || {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // Reject huge reference images early — Vercel returns opaque 413 otherwise.
  if (imageBase64 && approxJsonBytes({ imageBase64 }) > SAFE_JSON_BYTES) {
    return res.status(413).json({
      error:
        'Reference image is too large for Vercel (max ~3MB after encode). ' +
        'Use a smaller JPEG (Media Studio compresses uploads automatically).',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }

  const respondImage = async (rawOut) => {
    // Storage first: with it, size stops being a constraint at all and the
    // fallbacks below never run.
    const out = await persistImageResult(rawOut);
    if (imageResultTooLarge(out)) {
      if (veniceImageKey() && out.provider !== 'venice') {
        console.warn('image payload too large for Vercel; falling back to Venice webp');
        const veniceOut = await generateVeniceImage({
          prompt: prompt.trim(),
          model: 'z-image-turbo',
          size,
          negativePrompt,
        });
        veniceOut.fallbackFrom = out.provider;
        veniceOut.fallbackNote =
          `Primary ${out.provider} image was too large for Vercel (would 413); used Venice · ${veniceOut.model}.`;
        return res.status(200).json(veniceOut);
      }
      throw oversizeError('image');
    }
    return res.status(200).json(out);
  };

  try {
    if (kind === 'image') {
      // Self-hosted, explicit opt-in only - shares the same prepaid billing
      // ledger as Modal video (lib/video-billing.js), keyed by the same
      // access keys.
      if (provider === 'modal') {
        let person = null;
        if (billingEnabled()) {
          person = findPerson(accessKey);
          if (!person) {
            return res.status(401).json({ error: 'Invalid or missing access key for image generation.' });
          }
          try {
            await assertHasCredit(person);
          } catch (creditErr) {
            return res.status(creditErr.status || 402).json({ error: creditErr.message });
          }
        }

        const out = await generateModalSdxlImage({
          prompt: prompt.trim(),
          negativePrompt,
          model,
          size,
          count,
          mode,
          imageBase64,
          strength,
          expand,
          controlScale,
          detectPose,
        });

        if (person) {
          const billing = await chargeForGeneration(person, {
            elapsedSeconds: out.elapsedSeconds,
            prompt: prompt.trim(),
          });
          out.billing = { name: person.name, markupPct: person.markupPct, ...billing };
        }

        return respondImage(out);
      }

      // Venice Edit = image→image. Only path that consumes imageBase64 for images.
      const isEdit =
        provider === 'venice' &&
        (VENICE_EDIT_MODELS[model] || /edit/i.test(String(model || '')));
      if (isEdit) {
        const out = await generateVeniceEdit({
          prompt: prompt.trim(),
          model: model || 'qwen-edit',
          imageBase64,
        });
        return respondImage(out);
      }

      // Venice = uncensored path (safe_mode:false). Cloudflare keeps its filter.
      if (provider === 'venice') {
        const out = await generateVeniceImage({
          prompt: prompt.trim(),
          model,
          size,
          negativePrompt,
        });
        return respondImage(out);
      }

      // NVIDIA and fal are not image providers here — both bill per generation
      // and filter output. Rejected rather than quietly redirected, so a stale
      // client sees why instead of getting a different model's picture back.
      if (provider === 'nvidia' || provider === 'fal') {
        return res.status(400).json({
          error:
            `Unsupported image provider "${provider}". ` +
            `Use "modal" (lustify / wai-illustrious), "venice", or "cloudflare".`,
        });
      }

      // Default / cloudflare. No cross-provider fallback: a failure here used
      // to land on fal or NVIDIA, which is exactly what must not happen.
      const out = await generateCloudflareImage({
        prompt: prompt.trim(),
        model: model || 'flux-schnell',
        size,
        negativePrompt,
      });
      return respondImage(out);
    }

    if (kind === 'video') {
      // Self-hosted only, and no external content filter.
      if (provider === 'modal') {
        // Billing only kicks in once VIDEO_ACCESS_KEYS is set in Vercel env.
        // Until then this stays open/unmetered (single-owner use).
        let person = null;
        if (billingEnabled()) {
          person = findPerson(accessKey);
          if (!person) {
            return res.status(401).json({ error: 'Invalid or missing access key for video generation.' });
          }
          try {
            await assertHasCredit(person);
          } catch (creditErr) {
            return res.status(creditErr.status || 402).json({ error: creditErr.message });
          }
        }

        const isLtx = /ltx/i.test(String(model || ''));
        const out = isLtx
          ? await generateModalLtxVideo({
              prompt: prompt.trim(),
              negativePrompt,
              size: size || '704x480',
              seconds,
            })
          : await generateModalWanVideo({
              prompt: prompt.trim(),
              negativePrompt,
              size: size || '832x480',
              seconds,
            });

        // Off to storage before billing. If this throws, storage is
        // misconfigured — an owner problem, not the requester's, so they are
        // not charged for a clip they cannot receive.
        const stored = await persistVideoResult(out);

        if (person) {
          const billing = await chargeForGeneration(person, {
            elapsedSeconds: stored.elapsedSeconds,
            prompt: prompt.trim(),
          });
          stored.billing = { name: person.name, markupPct: person.markupPct, ...billing };
        }

        return res.status(200).json(stored);
      }

      // Video is self-hosted only. fal and NVIDIA both bill per generation and
      // apply their own moderation, and Cloudflare's Seedance models are a
      // third-party pass-through outside the Workers AI free tier — none of
      // them are the cheap, unfiltered path this exists to provide. The picker
      // has offered nothing but the two Modal models for a while; this makes
      // the backend agree rather than silently routing elsewhere.
      return res.status(400).json({
        error:
          `Unsupported video provider "${provider || 'none'}". ` +
          `Video is self-hosted only: use provider "modal" with model ` +
          `"ltx-video" or "wan2.2-5b".`,
      });
    }

    return res.status(400).json({ error: `Unknown kind: ${kind}` });
  } catch (err) {
    console.error('media-generate error:', err);
    const status = err.status || 502;
    const payload = {
      error: cleanMediaError(err.message) || 'Media generation failed',
    };
    if (err.code) payload.code = err.code;
    return res.status(status).json(payload);
  }
}

// Exposed for scripts/check-video-persist.mjs — same convention as
// lib/animate/providers.js. Not part of the HTTP surface.
export const __test = {
  persistVideoResult, persistImageResult, payloadTooLarge, SAFE_JSON_BYTES,
  warmEndpointFor, modalEndpoint, clipsForSeconds, videoGeometry,
};
