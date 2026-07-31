/**
 * POST /api/media-generate
 *
 * Body:
 *   {
 *     kind: 'image' | 'video',
 *     provider: 'cloudflare' | 'nvidia' | 'fal' | 'venice',
 *     model?: string,
 *     prompt: string,
 *     negativePrompt?: string,
 *     size?: string,          // image: 1024x1024 | video: 832x480 / 480x832
 *     seconds?: number,       // video length
 *     imageBase64?: string,   // optional reference / i2v frame (data URL or raw b64)
 *     mimeType?: string
 *   }
 *
 * Env (Vercel → Settings → Environment Variables):
 *   VENICE_API_KEY         — uncensored images (safe_mode:false) via Venice
 *   CLOUDFLARE_ACCOUNT_ID  — Workers AI account id (images + Seedance video)
 *   CLOUDFLARE_API_TOKEN   — API token with Workers AI permission
 *   FAL_KEY                — Wan 2.2 video via fal.ai (recommended)
 *   NVIDIA_API_KEY         — hosted FLUX/SDXL image (optional; safety-filtered)
 *   NVIDIA_MEDIA_BASE_URL  — self-hosted Wan NIM only (OpenAI-compatible base URL)
 */

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

const CLOUDFLARE_VIDEO_MODELS = {
  'seedance-mini': 'bytedance/seedance-2.0-mini',
  'seedance-2.0-mini': 'bytedance/seedance-2.0-mini',
  'bytedance/seedance-2.0-mini': 'bytedance/seedance-2.0-mini',
  'seedance-fast': 'bytedance/seedance-2.0-fast',
  'seedance-2.0-fast': 'bytedance/seedance-2.0-fast',
  'bytedance/seedance-2.0-fast': 'bytedance/seedance-2.0-fast',
  'seedance': 'bytedance/seedance-2.0',
  'seedance-2.0': 'bytedance/seedance-2.0',
  'bytedance/seedance-2.0': 'bytedance/seedance-2.0',
};

/** Hosted on ai.api.nvidia.com/v1/genai (401 without key). Qwen needs a self-hosted NIM base URL. */
const NVIDIA_IMAGE_MODELS = {
  'flux-schnell': 'black-forest-labs/flux.1-schnell',
  'black-forest-labs/flux.1-schnell': 'black-forest-labs/flux.1-schnell',
  'flux-dev': 'black-forest-labs/flux.1-dev',
  'black-forest-labs/flux.1-dev': 'black-forest-labs/flux.1-dev',
  'sdxl': 'stabilityai/stable-diffusion-xl',
  'stable-diffusion-xl': 'stabilityai/stable-diffusion-xl',
  'stabilityai/stable-diffusion-xl': 'stabilityai/stable-diffusion-xl',
  // Legacy aliases — not on the hosted catalog; handler falls back to Cloudflare.
  'qwen-image': 'qwen/qwen-image',
  'qwen/qwen-image': 'qwen/qwen-image',
};

const NVIDIA_HOSTED_IMAGE = new Set([
  'black-forest-labs/flux.1-schnell',
  'black-forest-labs/flux.1-dev',
  'stabilityai/stable-diffusion-xl',
  'stabilityai/stable-diffusion-3-medium',
]);

const NVIDIA_VIDEO_MODELS = {
  'wan2.2': 'wan-ai/wan2.2',
  'wan-ai/wan2.2': 'wan-ai/wan2.2',
  'wan2.2-t2v': 'wan-ai/wan2.2',
  'wan2.2-i2v': 'wan-ai/wan2.2',
};

/** Hosted Wan 2.2 on fal.ai (NVIDIA’s free genai host 404s for Wan). */
const FAL_VIDEO_MODELS = {
  'wan2.2': 'fal-ai/wan/v2.2-5b/text-to-video',
  'wan2.2-t2v': 'fal-ai/wan/v2.2-5b/text-to-video',
  'wan2.2-5b': 'fal-ai/wan/v2.2-5b/text-to-video',
  'wan2.2-a14b': 'fal-ai/wan/v2.2-a14b/text-to-video',
  'wan2.2-i2v': 'fal-ai/wan/v2.2-5b/image-to-video',
  'fal-wan-t2v': 'fal-ai/wan/v2.2-5b/text-to-video',
  'fal-wan-i2v': 'fal-ai/wan/v2.2-5b/image-to-video',
  'fal-ai/wan/v2.2-5b/text-to-video': 'fal-ai/wan/v2.2-5b/text-to-video',
  'fal-ai/wan/v2.2-a14b/text-to-video': 'fal-ai/wan/v2.2-a14b/text-to-video',
  'fal-ai/wan/v2.2-5b/image-to-video': 'fal-ai/wan/v2.2-5b/image-to-video',
};


const NVIDIA_GEN_BASE = 'https://ai.api.nvidia.com/v1';
const NVIDIA_NVCF_STATUS = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

function cloudflareCreds() {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '').trim();
  const token = (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim();
  return { accountId, token };
}

function nvidiaSelfHostBase() {
  const raw = (process.env.NVIDIA_MEDIA_BASE_URL || '').trim().replace(/\/$/, '');
  // Guard: people sometimes paste the public NVIDIA host here — that is NOT a Wan NIM.
  if (!raw) return null;
  if (/ai\.api\.nvidia\.com|integrate\.api\.nvidia\.com/i.test(raw)) return null;
  return raw;
}

function stripDataUrl(input) {
  const s = String(input || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (m) return { mime: m[1], b64: m[2] };
  return { mime: null, b64: s.replace(/\s+/g, '') };
}

function asDataUrl(mime, b64OrDataUrl) {
  const s = String(b64OrDataUrl || '');
  if (s.startsWith('data:')) return s;
  return `data:${mime};base64,${s}`;
}

function parseSize(size, fallbackW = 1024, fallbackH = 1024) {
  const m = String(size || '').match(/(\d+)\s*[x×*]\s*(\d+)/i);
  if (!m) return { width: fallbackW, height: fallbackH };
  return {
    width: Math.max(256, Math.min(1920, Number(m[1]) || fallbackW)),
    height: Math.max(256, Math.min(1920, Number(m[2]) || fallbackH)),
  };
}

function videoAspectFromSize(size) {
  const dims = String(size || '832x480').replace('*', 'x');
  if (dims === '480x832') return '9:16';
  if (dims === '832x480') return '16:9';
  const { width, height } = parseSize(dims, 832, 480);
  return width >= height ? '16:9' : '9:16';
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

function explainNvidiaAuth(status, detail, modelId) {
  const text = String(detail || '');
  if (status !== 401 && status !== 403 && !/permission|forbidden|unauthorized|not authorized|auth_failure|public api/i.test(text)) {
    return null;
  }
  return (
    `NVIDIA denied access to ${modelId} (${status}${text ? `: ${text}` : ''}). ` +
    `Image models need a key from build.nvidia.com (model page → Get API Key). ` +
    `For video, use Cloudflare · Seedance (CLOUDFLARE_* keys) — Wan is self-hosted NIM only.`
  );
}

function isNvidiaSafetyBlock(detail) {
  return /nsfw|safety|content.?filter|blocked|moderated|inappropriate/i.test(String(detail || ''));
}

function veniceImageKey() {
  return (process.env.VENICE_API_KEY || '').trim();
}

/**
 * Uncensored Venice images — native POST /image/generate with safe_mode:false.
 * Cloudflare / NVIDIA / fal hosts keep their own filters; use Venice for unrestricted.
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
    format: 'png',
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

  const blurred = String(upstream.headers.get('x-venice-is-blurred') || '').toLowerCase() === 'true';
  return {
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
}

function cleanMediaError(msg) {
  return String(msg || '')
    .replace(/^(AIError:\s*)+/gi, '')
    .replace(/\s*\([0-9a-f-]{20,}\)\s*$/i, '')
    .trim();
}

function parseNvidiaImages(data) {
  const fromOpenAi = (data?.data || [])
    .map((d) => {
      if (d.b64_json) {
        return {
          mimeType: 'image/png',
          base64: String(d.b64_json).replace(/^data:image\/\w+;base64,/, ''),
        };
      }
      if (d.url) return { mimeType: 'image/png', url: d.url };
      return null;
    })
    .filter(Boolean);
  if (fromOpenAi.length) return fromOpenAi;

  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
  const fromArts = artifacts
    .map((a) => {
      const b64 = a?.base64 || a?.b64_json;
      if (!b64) return null;
      return {
        mimeType: a?.mime_type || a?.mimeType || 'image/png',
        base64: String(b64).replace(/^data:image\/\w+;base64,/, ''),
      };
    })
    .filter(Boolean);
  if (fromArts.length) return fromArts;

  if (typeof data?.image === 'string' && data.image) {
    return [{
      mimeType: 'image/png',
      base64: String(data.image).replace(/^data:image\/\w+;base64,/, ''),
    }];
  }
  return [];
}

function parseNvidiaVideoB64(data) {
  if (!data || typeof data !== 'object') return null;
  const direct =
    data?.data?.b64_json ||
    data?.data?.[0]?.b64_json ||
    data?.b64_json ||
    data?.video ||
    data?.artifacts?.[0]?.base64;
  if (typeof direct === 'string' && direct) return direct;
  return null;
}

async function nvidiaFetch(url, key, body, { accept = 'application/json' } = {}) {
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      Accept: accept,
    },
    body: JSON.stringify(body),
  });
  const headers = Object.fromEntries(upstream.headers.entries());
  const ctype = (upstream.headers.get('content-type') || '').toLowerCase();
  let data = {};
  if (ctype.includes('application/json') || ctype.includes('text/')) {
    data = await upstream.json().catch(() => ({}));
  } else if (upstream.ok) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    data = { __binary: buf, __contentType: ctype || 'application/octet-stream' };
  } else {
    const text = await upstream.text().catch(() => '');
    data = { message: text };
  }
  return { ok: upstream.ok, status: upstream.status, data, headers, url };
}

async function waitNvcf(reqId, key, timeoutMs = 240_000) {
  const start = Date.now();
  let delay = 1500;
  while (Date.now() - start < timeoutMs) {
    const upstream = await fetch(`${NVIDIA_NVCF_STATUS}/${encodeURIComponent(reqId)}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    });
    if (upstream.status === 200) {
      const data = await upstream.json().catch(() => ({}));
      return { ok: true, status: 200, data };
    }
    if (upstream.status !== 202) {
      const data = await upstream.json().catch(() => ({}));
      return { ok: false, status: upstream.status, data };
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(8000, Math.floor(delay * 1.35));
  }
  const err = new Error(`NVIDIA job ${reqId} timed out waiting for NVCF completion.`);
  err.status = 504;
  throw err;
}

async function nvidiaGenai(modelId, body, key) {
  const url = `${NVIDIA_GEN_BASE}/genai/${modelId}`;
  let result = await nvidiaFetch(url, key, body);
  if (result.status === 202) {
    const reqId = result.headers['nvcf-reqid'] || result.headers['NVCF-REQID'];
    if (!reqId) {
      const err = new Error('NVIDIA returned 202 without NVCF-REQID — cannot poll.');
      err.status = 502;
      throw err;
    }
    result = await waitNvcf(String(reqId), key);
  }
  return result;
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

function extractCloudflareVideoUrl(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.result?.video,
    payload.result?.result?.video,
    payload.result?.video_url,
    payload.result?.output?.video,
    payload.result?.output?.url,
    payload.result?.outputs?.[0]?.url,
    payload.result?.outputs?.[0]?.video,
    payload.video,
    payload.video_url,
    payload.result?.url,
    payload.url,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c.trim())) return c.trim();
    if (typeof c === 'string' && c.trim().startsWith('data:video')) return c.trim();
  }
  // Nested { video: { url } }
  const nested = payload.result?.video?.url || payload.video?.url;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  return null;
}

function extractCloudflareRequestId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const id =
    payload.result?.request_id ||
    payload.result?.id ||
    payload.request_id ||
    payload.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function cloudflareAiDetail(data, status) {
  return (
    extractErrorDetail(data) ||
    (Array.isArray(data?.errors) && data.errors[0]?.message) ||
    `Cloudflare video HTTP ${status || 'error'}`
  );
}

async function cloudflareAiPost(url, token, body) {
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await upstream.json().catch(() => ({}));
  return { ok: upstream.ok, status: upstream.status, data };
}

/**
 * Seedance is a Cloudflare AI partner model.
 * Official REST shape: POST /accounts/{id}/ai/run/{model_name} with flat params
 * (model_name keeps the slash: bytedance/seedance-2.0-mini — do NOT encode it).
 * Docs also show envelope POST /ai/run { model, input } for some partner UIs.
 */
async function generateCloudflareVideo({
  prompt,
  model,
  size,
  seconds,
  imageBase64,
  mimeType,
}) {
  const { accountId, token } = cloudflareCreds();
  if (!accountId || !token) {
    const err = new Error(
      'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN in Vercel env (needed for Seedance video).'
    );
    err.status = 503;
    throw err;
  }
  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    const err = new Error(
      `CLOUDFLARE_ACCOUNT_ID looks invalid (${accountId.slice(0, 8)}…). ` +
        `It must be the 32-character hex Account ID from the Cloudflare dashboard. ` +
        `Wrong IDs return Cloudflare error 7003 “No route for that URI”.`
    );
    err.status = 503;
    throw err;
  }

  const modelId = CLOUDFLARE_VIDEO_MODELS[model] || CLOUDFLARE_VIDEO_MODELS['seedance-mini'];
  const duration = Math.min(12, Math.max(4, Number(seconds) || 5));
  const aspect_ratio = videoAspectFromSize(size);
  const resolution = '720p';

  const input = {
    prompt,
    aspect_ratio,
    duration,
    resolution,
  };
  if (imageBase64) {
    const { mime, b64 } = stripDataUrl(imageBase64);
    const mt = (mimeType || mime || 'image/png').replace('image/jpg', 'image/jpeg');
    input.image = asDataUrl(mt, b64);
  }

  const runBase = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run`;
  // Keep slash in model path — Cloudflare routes /ai/run/bytedance/seedance-2.0-mini
  const modelUrl = `${runBase}/${modelId}`;

  const attempts = [
    { label: 'path+flat', url: modelUrl, body: input },
    { label: 'path+envelope', url: modelUrl, body: { model: modelId, input } },
    { label: 'root+envelope', url: runBase, body: { model: modelId, input } },
  ];

  let lastDetail = 'Cloudflare video failed';
  let lastStatus = 502;
  let accepted = null;

  for (const attempt of attempts) {
    const res = await cloudflareAiPost(attempt.url, token, attempt.body);
    const videoUrl = extractCloudflareVideoUrl(res.data);
    if (res.ok && videoUrl) {
      return {
        kind: 'video',
        provider: 'cloudflare',
        model: modelId,
        videoUrl,
        mime: 'video/mp4',
      };
    }

    const reqId = extractCloudflareRequestId(res.data);
    const statusText = String(
      res.data?.result?.status || res.data?.status || ''
    ).toLowerCase();
    if (res.ok && reqId && (statusText.includes('queue') || statusText.includes('run') || !videoUrl)) {
      accepted = { url: attempt.url, requestId: reqId, label: attempt.label };
      break;
    }

    lastStatus = res.status || lastStatus;
    lastDetail = cloudflareAiDetail(res.data, res.status);
    // Path route exists but model/token problem — stop guessing other URLs.
    if (res.status === 400 || res.status === 401 || res.status === 403) break;
    if (attempt.label === 'path+flat' && res.status !== 404 && !/no route/i.test(lastDetail)) break;
  }

  if (accepted) {
    const started = Date.now();
    let delay = 2500;
    while (Date.now() - started < 280_000) {
      await new Promise((r) => setTimeout(r, delay));
      const poll = await cloudflareAiPost(accepted.url, token, {
        request_id: accepted.requestId,
      });
      const videoUrl = extractCloudflareVideoUrl(poll.data);
      if (poll.ok && videoUrl) {
        return {
          kind: 'video',
          provider: 'cloudflare',
          model: modelId,
          videoUrl,
          mime: 'video/mp4',
        };
      }
      const st = String(poll.data?.result?.status || poll.data?.status || '').toLowerCase();
      if (st.includes('fail') || st.includes('error') || poll.status >= 400) {
        lastStatus = poll.status || 502;
        lastDetail = cloudflareAiDetail(poll.data, poll.status);
        break;
      }
      delay = Math.min(10_000, Math.floor(delay * 1.25));
    }
    if (!/timed out|fail/i.test(lastDetail)) {
      lastDetail = `Seedance job ${accepted.requestId} timed out waiting for video.`;
      lastStatus = 504;
    }
  }

  const noRoute = /no route|7003/i.test(String(lastDetail));
  const hint = noRoute
    ? ` Check CLOUDFLARE_ACCOUNT_ID is the 32-char hex Account ID. ` +
      `Then enable ${modelId} under Cloudflare AI → Models, and use a token with Workers AI permissions. ` +
      `Or switch Media → Video to Wan 2.2 (fal.ai) if FAL_KEY is set.`
    : /not found|404|does not exist|unknown model|not enabled|not available/i.test(String(lastDetail))
      ? ` Enable ${modelId} in the Cloudflare dashboard (AI → Models), ` +
        `or use Wan 2.2 · fal.ai for video.`
      : '';

  const err = new Error(`${lastDetail}.${hint}`);
  err.status = lastStatus;
  throw err;
}

function buildNvidiaImageBody(modelId, prompt, negativePrompt, size) {
  const { width, height } = parseSize(size, 1024, 1024);
  const aspect =
    Math.abs(width / height - 1) < 0.05 ? '1:1' : width > height ? '16:9' : '9:16';
  const seed = Math.floor(Math.random() * 1_000_000);

  if (/stable-diffusion-xl/i.test(modelId)) {
    const text_prompts = [{ text: prompt, weight: 1.0 }];
    if (negativePrompt) text_prompts.push({ text: negativePrompt, weight: -1.0 });
    return {
      text_prompts,
      seed,
      steps: 20,
      cfg_scale: 5,
      width: Math.min(1024, width),
      height: Math.min(1024, height),
      // Hosted NVIDIA often ignores this, but some NIM builds honor it.
      enable_safety_checker: false,
    };
  }

  const body = {
    prompt,
    seed,
    steps: /flux\.1-schnell/i.test(modelId) ? 4 : 20,
    cfg_scale: /flux/i.test(modelId) ? 0 : 4.0,
    aspect_ratio: aspect,
    enable_safety_checker: false,
  };
  if (negativePrompt) body.negative_prompt = negativePrompt;
  return body;
}

async function generateNvidiaImage({ prompt, model, size, negativePrompt }) {
  const key = (process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || '').trim();
  if (!key) {
    const err = new Error('Missing NVIDIA_API_KEY in Vercel env.');
    err.status = 503;
    throw err;
  }

  const modelId = NVIDIA_IMAGE_MODELS[model] || NVIDIA_IMAGE_MODELS['flux-schnell'];
  const selfHost = nvidiaSelfHostBase();
  const hosted = NVIDIA_HOSTED_IMAGE.has(modelId);

  if (!hosted && !selfHost) {
    const err = new Error(
      `${modelId} is not on NVIDIA’s free hosted genai catalog. ` +
        `Set NVIDIA_NIM_BASE_URL (or WAN_NIM_BASE_URL) to your self-hosted NIM, ` +
        `or pick NVIDIA · FLUX.1 Schnell / SDXL which are hosted.`
    );
    err.status = 404;
    err.code = 'NVIDIA_MODEL_NOT_HOSTED';
    throw err;
  }

  const genaiBody = buildNvidiaImageBody(modelId, prompt, negativePrompt, size);
  const attempts = [];

  if (hosted) {
    const result = await nvidiaGenai(modelId, genaiBody, key);
    attempts.push(result);
    const images = result.ok ? parseNvidiaImages(result.data) : [];
    if (images.length) {
      return { kind: 'image', provider: 'nvidia', model: modelId, images };
    }
  }

  if (selfHost) {
    const { width, height } = parseSize(size, 1024, 1024);
    const openaiBody = {
      model: modelId,
      prompt,
      n: 1,
      response_format: 'b64_json',
      size: `${width}x${height}`,
    };
    if (negativePrompt) openaiBody.negative_prompt = negativePrompt;
    const result = await nvidiaFetch(`${selfHost}/v1/images/generations`, key, openaiBody);
    attempts.push(result);
    const images = result.ok ? parseNvidiaImages(result.data) : [];
    if (images.length) {
      return { kind: 'image', provider: 'nvidia', model: modelId, images };
    }

    const infer = await nvidiaFetch(`${selfHost}/v1/infer`, key, genaiBody);
    attempts.push(infer);
    const inferImages = infer.ok ? parseNvidiaImages(infer.data) : [];
    if (inferImages.length) {
      return { kind: 'image', provider: 'nvidia', model: modelId, images: inferImages };
    }
  }

  const result = attempts[attempts.length - 1] || { status: 502, data: {} };
  const detail =
    attempts.map((a) => extractErrorDetail(a.data) || `HTTP ${a.status}`).filter(Boolean).join(' · ') ||
    `NVIDIA image HTTP ${result.status || 'error'}`;
  const cleaned = cleanMediaError(detail);
  const msg =
    explainNvidiaAuth(result.status, cleaned, modelId) ||
    (isNvidiaSafetyBlock(cleaned)
      ? `NVIDIA returned a safety/content error (${cleaned}).`
      : cleaned);
  const err = new Error(msg);
  err.status = result.status || 502;
  err.code = isNvidiaSafetyBlock(cleaned) ? 'NVIDIA_NSFW' : undefined;
  throw err;
}

async function generateFalFluxImage({ prompt, size, negativePrompt }) {
  const key = (process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim();
  if (!key) {
    const err = new Error('Missing FAL_KEY for fal.ai image fallback.');
    err.status = 503;
    throw err;
  }

  const { width, height } = parseSize(size, 1024, 1024);
  const modelId = 'fal-ai/flux/schnell';
  const input = {
    prompt,
    image_size: {
      width: Math.min(1536, width),
      height: Math.min(1536, height),
    },
    num_images: 1,
  };
  if (negativePrompt) input.negative_prompt = negativePrompt;

  const submitUrl = `https://queue.fal.run/${modelId}`;
  const submit = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const submitted = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    const detail = extractErrorDetail(submitted) || `fal.ai HTTP ${submit.status}`;
    const err = new Error(cleanMediaError(detail));
    err.status = submit.status || 502;
    throw err;
  }

  let imageUrl =
    submitted?.images?.[0]?.url ||
    submitted?.data?.images?.[0]?.url ||
    submitted?.output?.images?.[0]?.url;

  if (!imageUrl) {
    const requestId = submitted.request_id || submitted.requestId;
    const statusUrl = submitted.status_url || (requestId ? `https://queue.fal.run/${modelId}/requests/${requestId}/status` : null);
    const resultUrl = submitted.response_url || (requestId ? `https://queue.fal.run/${modelId}/requests/${requestId}` : null);
    if (!statusUrl || !resultUrl) {
      const err = new Error('fal.ai Flux did not return a request id.');
      err.status = 502;
      throw err;
    }
    const started = Date.now();
    let delay = 1200;
    while (Date.now() - started < 120_000) {
      const st = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
      const statusBody = await st.json().catch(() => ({}));
      const status = String(statusBody.status || statusBody.state || '').toUpperCase();
      if (status === 'COMPLETED' || status === 'OK') {
        const done = await fetch(resultUrl, { headers: { Authorization: `Key ${key}` } });
        const result = await done.json().catch(() => ({}));
        imageUrl =
          result?.images?.[0]?.url ||
          result?.data?.images?.[0]?.url ||
          result?.output?.images?.[0]?.url;
        break;
      }
      if (status === 'FAILED' || status === 'ERROR') {
        const detail = extractErrorDetail(statusBody) || 'fal.ai Flux job failed';
        const err = new Error(cleanMediaError(detail));
        err.status = 502;
        throw err;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(6000, Math.floor(delay * 1.25));
    }
  }

  if (!imageUrl) {
    const err = new Error('fal.ai Flux finished without an image URL.');
    err.status = 502;
    throw err;
  }

  return {
    kind: 'image',
    provider: 'fal',
    model: modelId,
    images: [{ mimeType: 'image/jpeg', url: imageUrl }],
  };
}

/** Optional Cloudflare/fal chain — only used when those providers are selected. */
async function generateImageWithFallbacks({ prompt, size, negativePrompt, preferredCfModel = 'flux-schnell' }) {
  const cfModels = [
    preferredCfModel,
    'flux-schnell',
    'sdxl-lightning',
    'sdxl',
  ].filter((m, i, arr) => arr.indexOf(m) === i);

  const errors = [];
  for (const model of cfModels) {
    try {
      return await generateCloudflareImage({
        prompt,
        model,
        size,
        negativePrompt,
      });
    } catch (err) {
      errors.push(`Cloudflare ${model}: ${cleanMediaError(err.message)}`);
    }
  }

  if ((process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim()) {
    try {
      return await generateFalFluxImage({ prompt, size, negativePrompt });
    } catch (err) {
      errors.push(`fal Flux: ${cleanMediaError(err.message)}`);
    }
  }

  const err = new Error(errors.join(' · ') || 'All image backends failed.');
  err.status = 502;
  throw err;
}

async function generateFalWanVideo({
  prompt,
  model,
  imageBase64,
  mimeType,
}) {
  const key = (process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim();
  if (!key) {
    const err = new Error(
      'Missing FAL_KEY in Vercel env. Hosted Wan 2.2 runs on fal.ai — get a key at https://fal.ai/dashboard/keys'
    );
    err.status = 503;
    throw err;
  }

  const wantsI2v = /i2v|image-to-video/i.test(String(model || ''));
  let modelId = FAL_VIDEO_MODELS[model] || FAL_VIDEO_MODELS['wan2.2-t2v'];
  if (wantsI2v || imageBase64) {
    modelId = FAL_VIDEO_MODELS['wan2.2-i2v'] || 'fal-ai/wan/v2.2-5b/image-to-video';
  }

  const input = { prompt };
  if (imageBase64) {
    const { mime, b64 } = stripDataUrl(imageBase64);
    const mt = (mimeType || mime || 'image/png').replace('image/jpg', 'image/jpeg');
    input.image_url = asDataUrl(mt, b64);
  } else if (wantsI2v) {
    const err = new Error('Wan image→video needs a reference image.');
    err.status = 400;
    throw err;
  }

  // Queue submit
  const submitUrl = `https://queue.fal.run/${modelId}`;
  const submit = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const submitted = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    const detail = extractErrorDetail(submitted) || `fal.ai HTTP ${submit.status}`;
    const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    err.status = submit.status || 502;
    throw err;
  }

  // Sync-ish: some endpoints return the result immediately
  let videoUrl =
    submitted?.video?.url ||
    submitted?.data?.video?.url ||
    submitted?.output?.video?.url;
  if (videoUrl) {
    return {
      kind: 'video',
      provider: 'fal',
      model: modelId,
      videoUrl,
      mime: 'video/mp4',
    };
  }

  const requestId = submitted.request_id || submitted.requestId;
  const statusUrl = submitted.status_url || (requestId ? `https://queue.fal.run/${modelId}/requests/${requestId}/status` : null);
  const resultUrl = submitted.response_url || (requestId ? `https://queue.fal.run/${modelId}/requests/${requestId}` : null);
  if (!statusUrl || !resultUrl) {
    const err = new Error('fal.ai did not return a request id for Wan video.');
    err.status = 502;
    throw err;
  }

  const started = Date.now();
  let delay = 2000;
  while (Date.now() - started < 280_000) {
    const st = await fetch(statusUrl, {
      headers: { Authorization: `Key ${key}` },
    });
    const statusBody = await st.json().catch(() => ({}));
    const status = String(statusBody.status || statusBody.state || '').toUpperCase();
    if (status === 'COMPLETED' || status === 'OK') {
      const done = await fetch(resultUrl, {
        headers: { Authorization: `Key ${key}` },
      });
      const result = await done.json().catch(() => ({}));
      videoUrl =
        result?.video?.url ||
        result?.data?.video?.url ||
        result?.output?.video?.url;
      if (!videoUrl) {
        const err = new Error('fal.ai Wan finished but returned no video URL.');
        err.status = 502;
        throw err;
      }
      return {
        kind: 'video',
        provider: 'fal',
        model: modelId,
        videoUrl,
        mime: 'video/mp4',
      };
    }
    if (status === 'FAILED' || status === 'ERROR') {
      const detail = extractErrorDetail(statusBody) || 'fal.ai Wan job failed';
      const err = new Error(detail);
      err.status = 502;
      throw err;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(8000, Math.floor(delay * 1.25));
  }

  const err = new Error('fal.ai Wan video timed out waiting for the queue.');
  err.status = 504;
  throw err;
}

async function generateNvidiaWanVideo({
  prompt,
  model,
  size,
  seconds,
  imageBase64,
  mimeType,
  negativePrompt,
}) {
  // Prefer fal hosted Wan when FAL_KEY is set (NVIDIA hosted genai 404s).
  if ((process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim()) {
    return generateFalWanVideo({ prompt, model, imageBase64, mimeType });
  }

  const key = (process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || '').trim();
  if (!key) {
    const err = new Error(
      'Wan 2.2 needs FAL_KEY (hosted on fal.ai) or NVIDIA_MEDIA_BASE_URL (self-hosted NIM). ' +
        'NVIDIA’s free ai.api.nvidia.com host returns 404 for Wan.'
    );
    err.status = 503;
    throw err;
  }

  const modelId = NVIDIA_VIDEO_MODELS[model] || NVIDIA_VIDEO_MODELS['wan2.2'];
  const dims = (size || '832x480').includes('*')
    ? size.replace('*', 'x')
    : size || '832x480';
  const allowed = new Set(['832x480', '480x832']);
  const finalSize = allowed.has(dims) ? dims : '832x480';
  const secs = Math.min(12, Math.max(1, Number(seconds) || 4));
  const selfHost = nvidiaSelfHostBase();

  if (!selfHost) {
    const err = new Error(
      'Wan 2.2 is not on NVIDIA’s free hosted API. Add FAL_KEY for hosted Wan on fal.ai, ' +
        'or set NVIDIA_MEDIA_BASE_URL to your own Wan NIM (not ai.api.nvidia.com).'
    );
    err.status = 404;
    throw err;
  }

  const body = {
    model: modelId,
    prompt,
    size: finalSize,
    seconds: secs,
  };
  if (negativePrompt) body.negative_prompt = negativePrompt;
  if (imageBase64) {
    const { mime, b64: raw } = stripDataUrl(imageBase64);
    const mt = (mimeType || mime || 'image/png').replace('image/jpg', 'image/jpeg');
    body.input_reference = asDataUrl(mt, raw);
  }

  const result = await nvidiaFetch(`${selfHost}/v1/videos/generations`, key, body);
  if (result.data?.__binary) {
    return {
      kind: 'video',
      provider: 'nvidia',
      model: modelId,
      videoUrl: `data:${result.data.__contentType || 'video/mp4'};base64,${result.data.__binary.toString('base64')}`,
      mime: result.data.__contentType || 'video/mp4',
    };
  }

  const b64 = result.ok ? parseNvidiaVideoB64(result.data) : null;
  if (!b64) {
    const detail = extractErrorDetail(result.data) || `Wan NIM HTTP ${result.status || 'error'}`;
    const err = new Error(
      `${detail}. Or add FAL_KEY for hosted Wan 2.2 on fal.ai.`
    );
    err.status = result.status || 502;
    throw err;
  }

  const clean = String(b64).replace(/^data:video\/\w+;base64,/, '');
  return {
    kind: 'video',
    provider: 'nvidia',
    model: modelId,
    videoUrl: `data:video/mp4;base64,${clean}`,
    mime: 'video/mp4',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    kind = 'image',
    provider,
    model,
    prompt,
    negativePrompt,
    size,
    seconds,
    imageBase64,
    mimeType,
  } = req.body || {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  try {
    if (kind === 'image') {
      // Venice = uncensored path (safe_mode:false). CF/NVIDIA/fal keep host filters.
      if (provider === 'venice') {
        const out = await generateVeniceImage({
          prompt: prompt.trim(),
          model,
          size,
          negativePrompt,
        });
        return res.status(200).json(out);
      }

      // Honor the user's selected provider. Never silently skip NVIDIA or swap models.
      if (provider === 'nvidia') {
        const out = await generateNvidiaImage({
          prompt: prompt.trim(),
          model,
          size,
          negativePrompt,
        });
        return res.status(200).json(out);
      }

      if (provider === 'fal') {
        const out = await generateFalFluxImage({
          prompt: prompt.trim(),
          size,
          negativePrompt,
        });
        return res.status(200).json(out);
      }

      // Default / cloudflare
      const preferredCf = model || 'flux-schnell';
      try {
        const out = await generateCloudflareImage({
          prompt: prompt.trim(),
          model: preferredCf,
          size,
          negativePrompt,
        });
        return res.status(200).json(out);
      } catch (cfPrimaryErr) {
        console.warn('cloudflare primary failed:', cfPrimaryErr.message);
        const out = await generateImageWithFallbacks({
          prompt: prompt.trim(),
          size,
          negativePrompt,
          preferredCfModel: preferredCf,
        });
        out.fallbackFrom = 'cloudflare';
        out.fallbackNote = `Primary Cloudflare model failed; used ${out.provider} · ${out.model}.`;
        return res.status(200).json(out);
      }
    }

    if (kind === 'video') {
      const isWan = provider === 'nvidia' || provider === 'fal' || /wan/i.test(String(model || ''));

      if (isWan) {
        try {
          const out = await generateNvidiaWanVideo({
            prompt: prompt.trim(),
            model: model || 'wan2.2-t2v',
            size: size || '832x480',
            seconds,
            imageBase64,
            mimeType,
            negativePrompt,
          });
          return res.status(200).json(out);
        } catch (wanErr) {
          // Fall through to Cloudflare Seedance if configured
          console.warn('Wan video failed, trying Cloudflare Seedance:', wanErr.message);
          try {
            const out = await generateCloudflareVideo({
              prompt: prompt.trim(),
              model: 'seedance-mini',
              size: size || '832x480',
              seconds,
              imageBase64,
              mimeType,
            });
            out.fallbackFrom = provider || 'nvidia';
            out.fallbackNote = wanErr.message || 'Wan unavailable; used Cloudflare · Seedance Mini.';
            return res.status(200).json(out);
          } catch (cfErr) {
            const err = new Error(
              `${wanErr.message} Also tried Cloudflare Seedance: ${cfErr.message}`
            );
            err.status = wanErr.status || cfErr.status || 502;
            throw err;
          }
        }
      }

      try {
        const out = await generateCloudflareVideo({
          prompt: prompt.trim(),
          model: model || 'seedance-mini',
          size: size || '832x480',
          seconds,
          imageBase64,
          mimeType,
        });
        return res.status(200).json(out);
      } catch (cfErr) {
        // Seedance often needs dashboard enablement — fall back to fal Wan if key exists.
        if ((process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim()) {
          console.warn('Cloudflare Seedance failed, falling back to fal Wan:', cfErr.message);
          try {
            const out = await generateFalWanVideo({
              prompt: prompt.trim(),
              model: imageBase64 ? 'wan2.2-i2v' : 'wan2.2-t2v',
              imageBase64,
              mimeType,
            });
            out.fallbackFrom = 'cloudflare';
            out.fallbackNote =
              cfErr.message || 'Cloudflare Seedance unavailable; used Wan 2.2 on fal.ai.';
            return res.status(200).json(out);
          } catch (falErr) {
            const err = new Error(
              `${cfErr.message} Also tried fal Wan: ${falErr.message}`
            );
            err.status = cfErr.status || falErr.status || 502;
            throw err;
          }
        }
        throw cfErr;
      }
    }

    return res.status(400).json({ error: `Unknown kind: ${kind}` });
  } catch (err) {
    console.error('media-generate error:', err);
    return res.status(err.status || 502).json({
      error: cleanMediaError(err.message) || 'Media generation failed',
    });
  }
}
