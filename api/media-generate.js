/**
 * POST /api/media-generate
 *
 * Body:
 *   {
 *     kind: 'image' | 'video',
 *     provider: 'cloudflare' | 'nvidia',
 *     model?: string,
 *     prompt: string,
 *     negativePrompt?: string,
 *     size?: string,          // image: 1024x1024 | video: 832x480 / 480x832
 *     seconds?: number,       // wan video length (1–12, default 4)
 *     imageBase64?: string,   // optional reference / i2v frame (data URL or raw b64)
 *     mimeType?: string
 *   }
 *
 * Env (Vercel → Settings → Environment Variables):
 *   CLOUDFLARE_ACCOUNT_ID  — Workers AI account id
 *   CLOUDFLARE_API_TOKEN   — API token with Workers AI permission
 *   NVIDIA_API_KEY         — Qwen Image + Wan 2.2 (build.nvidia.com → Get API Key)
 *   NVIDIA_MEDIA_BASE_URL  — optional override for self-hosted NIM (OpenAI-compatible)
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

/** Hosted on ai.api.nvidia.com/v1/genai (401 without key). Qwen/Wan are NIM-download only → 404. */
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

const NVIDIA_GEN_BASE = 'https://ai.api.nvidia.com/v1';
const NVIDIA_NVCF_STATUS = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

function nvidiaSelfHostBase() {
  const raw = (process.env.NVIDIA_MEDIA_BASE_URL || '').trim().replace(/\/$/, '');
  return raw || null;
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
    `Image/video models need a key from build.nvidia.com (open the model page → Get API Key) ` +
    `so “Public API Endpoints” is attached — NGC-only keys often fail here. ` +
    `For self-hosted NIM, set NVIDIA_MEDIA_BASE_URL. ` +
    `For free image gen without NVIDIA, use Cloudflare Workers AI (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN).`
  );
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
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '').trim();
  const token = (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim();
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
    // SDXL / lightning accept width/height + optional negative
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
  // Some SD models return raw image bytes
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
    // Some models return raw base64 string in result
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

function buildNvidiaImageBody(modelId, prompt, negativePrompt, size) {
  const { width, height } = parseSize(size, 1024, 1024);
  const aspect =
    Math.abs(width / height - 1) < 0.05 ? '1:1' : width > height ? '16:9' : '9:16';
  const seed = Math.floor(Math.random() * 1_000_000);

  // SDXL hosted schema uses text_prompts, not prompt.
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
    };
  }

  const body = {
    prompt,
    seed,
    steps: /flux\.1-schnell/i.test(modelId) ? 4 : 20,
    cfg_scale: /flux/i.test(modelId) ? 0 : 4.0,
    aspect_ratio: aspect,
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

  // Qwen Image (and friends) are downloadable NIMs — not on ai.api.nvidia.com.
  if (!hosted && !selfHost) {
    const err = new Error(
      `${modelId} is not on NVIDIA’s free hosted API (HTTP 404 at ai.api.nvidia.com/v1/genai/…). ` +
        `Use Cloudflare · FLUX / SDXL, or NVIDIA · FLUX.1 Schnell / SDXL. ` +
        `For Qwen Image you need a self-hosted NIM and NVIDIA_MEDIA_BASE_URL.`
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

    // Native NIM infer
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
  const msg =
    explainNvidiaAuth(result.status, detail, modelId) ||
    `${detail}. Hosted path: ai.api.nvidia.com/v1/genai/${modelId}. ` +
      `If this keeps failing, use Cloudflare Workers AI (already configured) or set NVIDIA_MEDIA_BASE_URL.`;
  const err = new Error(msg);
  err.status = result.status || 502;
  err.code = result.status === 404 ? 'NVIDIA_MODEL_NOT_HOSTED' : 'NVIDIA_IMAGE_FAILED';
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
  const key = (process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || '').trim();
  if (!key) {
    const err = new Error('Missing NVIDIA_API_KEY in Vercel env.');
    err.status = 503;
    throw err;
  }

  const modelId = NVIDIA_VIDEO_MODELS[model] || NVIDIA_VIDEO_MODELS['wan2.2'];
  const dims = (size || '832x480').includes('*')
    ? size.replace('*', 'x')
    : size || '832x480';
  const allowed = new Set(['832x480', '480x832']);
  const finalSize = allowed.has(dims) ? dims : '832x480';
  const [w, h] = finalSize.split('x').map(Number);
  const secs = Math.min(12, Math.max(1, Number(seconds) || 4));
  const selfHost = nvidiaSelfHostBase();

  // Wan is downloadable NIM only on the public catalog right now (hosted genai → 404).
  if (!selfHost) {
    const err = new Error(
      `Wan 2.2 (${modelId}) is not on NVIDIA’s free hosted API. ` +
        `Point NVIDIA_MEDIA_BASE_URL at a self-hosted Wan NIM (OpenAI-compatible /v1/videos/generations), ` +
        `or use Cloudflare for images.`
    );
    err.status = 404;
    throw err;
  }

  const genaiBody = {
    prompt,
    width: w || 832,
    height: h || 480,
    seconds: secs,
    num_frames: Math.min(201, Math.max(1, secs * 16 + 1)),
    fps: 16,
    seed: Math.floor(Math.random() * 1_000_000),
  };
  if (negativePrompt) genaiBody.negative_prompt = negativePrompt;
  if (imageBase64) {
    const { mime, b64 } = stripDataUrl(imageBase64);
    const mt = (mimeType || mime || 'image/png').replace('image/jpg', 'image/jpeg');
    genaiBody.image = asDataUrl(mt, b64);
    genaiBody.input_reference = genaiBody.image;
  }

  let result = { ok: false, status: 0, data: {} };
  let b64 = null;

  // Self-hosted OpenAI-compatible video endpoint
  if (!b64 && selfHost) {
    const body = {
      model: modelId,
      prompt,
      size: finalSize,
      seconds: secs,
    };
    if (imageBase64) {
      const { mime, b64: raw } = stripDataUrl(imageBase64);
      const mt = (mimeType || mime || 'image/png').replace('image/jpg', 'image/jpeg');
      body.input_reference = asDataUrl(mt, raw);
    }
    result = await nvidiaFetch(`${selfHost}/v1/videos/generations`, key, body);
    if (result.data?.__binary) {
      return {
        kind: 'video',
        provider: 'nvidia',
        model: modelId,
        videoUrl: `data:${result.data.__contentType || 'video/mp4'};base64,${result.data.__binary.toString('base64')}`,
        mime: result.data.__contentType || 'video/mp4',
      };
    }
    b64 = result.ok ? parseNvidiaVideoB64(result.data) : null;
  }

  if (!b64 && result.data?.__binary) {
    return {
      kind: 'video',
      provider: 'nvidia',
      model: modelId,
      videoUrl: `data:${result.data.__contentType || 'video/mp4'};base64,${result.data.__binary.toString('base64')}`,
      mime: result.data.__contentType || 'video/mp4',
    };
  }

  if (!b64) {
    const detail = extractErrorDetail(result.data) || `NVIDIA Wan 2.2 HTTP ${result.status || 'error'}`;
    const msg =
      explainNvidiaAuth(result.status, detail, modelId) ||
      `${detail}. Hosted path: ai.api.nvidia.com/v1/genai/${modelId}. ` +
      `Get a key from the Wan 2.2 page on build.nvidia.com, or set NVIDIA_MEDIA_BASE_URL to a self-hosted NIM.`;
    const err = new Error(msg);
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
      if (provider === 'nvidia') {
        try {
          const out = await generateNvidiaImage({
            prompt: prompt.trim(),
            model,
            size,
            negativePrompt,
          });
          return res.status(200).json(out);
        } catch (nvidiaErr) {
          // Auto-fallback so a dead NVIDIA catalog slug (e.g. qwen-image 404) still delivers.
          console.warn('nvidia image failed, falling back to Cloudflare:', nvidiaErr.message);
          const out = await generateCloudflareImage({
            prompt: prompt.trim(),
            model: 'flux-schnell',
            size,
            negativePrompt,
          });
          out.fallbackFrom = 'nvidia';
          out.fallbackNote =
            nvidiaErr.message ||
            'NVIDIA image failed; used Cloudflare · FLUX.1 Schnell instead.';
          return res.status(200).json(out);
        }
      }
      // Default + explicit cloudflare
      const out = await generateCloudflareImage({
        prompt: prompt.trim(),
        model: model || 'flux-schnell',
        size,
        negativePrompt,
      });
      return res.status(200).json(out);
    }

    if (kind === 'video') {
      try {
        const out = await generateNvidiaWanVideo({
          prompt: prompt.trim(),
          model: model || 'wan2.2',
          size: size || '832x480',
          seconds,
          imageBase64,
          mimeType,
          negativePrompt,
        });
        return res.status(200).json(out);
      } catch (err) {
        if (err.status === 404 || /404|not found|not on NVIDIA/i.test(err.message || '')) {
          err.message =
            (err.message || 'NVIDIA video failed.') +
            ' Wan 2.2 is not on the free hosted API — set NVIDIA_MEDIA_BASE_URL to a self-hosted Wan NIM, ' +
            'or generate images with Cloudflare meanwhile.';
        }
        throw err;
      }
    }

    return res.status(400).json({ error: `Unknown kind: ${kind}` });
  } catch (err) {
    console.error('media-generate error:', err);
    return res.status(err.status || 502).json({
      error: err.message || 'Media generation failed',
    });
  }
}
