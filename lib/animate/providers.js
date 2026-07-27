/**
 * OpenAI-compatible image providers for the frame-chain workflow.
 *
 * Shared request interface — swap base URL / model / API key per provider.
 *
 * Venice (docs.venice.ai, verified 2026-07):
 *   - POST /api/v1/image/generate supports style_references[{image,strength}] —
 *     aesthetic guidance, NOT classic img2img denoise chaining.
 *   - POST /api/v1/images/generations is OpenAI-compatible text-to-image only.
 *   - Separate Edit API is for inpainting, not frame-chain denoise.
 * Therefore Venice is used for frame-0 keyframes only unless
 * providerConfig.veniceKeyframeOnly === false (experimental style_references path).
 *
 * NVIDIA NIM:
 *   - Primary: OpenAI-compatible POST {base}/v1/images/generations (+ edits when available)
 *   - Hosted fallback: ai.api.nvidia.com/v1/genai/{model} with mode base|canny|depth
 *     (ControlNet-adjacent hook for future pose/depth/edge conditioning)
 */

import { DEFAULTS } from './config.js';

const NVIDIA_INTEGRATE = 'https://integrate.api.nvidia.com';
const NVIDIA_GENAI = 'https://ai.api.nvidia.com/v1';
const VENICE_BASE = 'https://api.venice.ai/api/v1';

/**
 * @typedef {import('./config.js').FrameConditioning} FrameConditioning
 *
 * @typedef {Object} ImageGenerateRequest
 * @property {string} prompt
 * @property {number} seed
 * @property {number} [strength]
 * @property {Buffer|null} [initImage]
 * @property {string} [initMime]
 * @property {FrameConditioning|null} [conditioning]
 * @property {number} [width]
 * @property {number} [height]
 * @property {string} [negativePrompt]
 * @property {boolean} [allowVeniceChain]  // experimental
 *
 * @typedef {Object} ImageGenerateResult
 * @property {Buffer} buffer
 * @property {string} mimeType
 * @property {string} provider
 * @property {string} model
 * @property {string} [mode]  // 't2i' | 'i2i' | 'control'
 */

function stripDataUrl(input) {
  const s = String(input || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/s);
  if (m) return { mime: m[1], b64: m[2] };
  return { mime: null, b64: s.replace(/\s+/g, '') };
}

function toDataUrl(buf, mime = 'image/png') {
  const b64 = Buffer.isBuffer(buf) ? buf.toString('base64') : stripDataUrl(buf).b64;
  return `data:${mime};base64,${b64}`;
}

function parseSize(width, height) {
  const w = Math.max(256, Number(width) || 1024);
  const h = Math.max(256, Number(height) || 1024);
  return { width: w, height: h, size: `${w}x${h}` };
}

function extractB64Images(payload) {
  const out = [];
  if (!payload) return out;
  if (typeof payload === 'string') {
    out.push(stripDataUrl(payload).b64);
    return out;
  }
  const data = payload.data || payload.images || payload.artifacts;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') out.push(stripDataUrl(item).b64);
      else if (item?.b64_json) out.push(stripDataUrl(item.b64_json).b64);
      else if (item?.base64) out.push(stripDataUrl(item.base64).b64);
      else if (item?.image) out.push(stripDataUrl(item.image).b64);
      else if (item?.url?.startsWith('data:')) out.push(stripDataUrl(item.url).b64);
    }
  }
  if (payload.image) out.push(stripDataUrl(payload.image).b64);
  if (payload.b64_json) out.push(stripDataUrl(payload.b64_json).b64);
  return out.filter(Boolean);
}

async function fetchJson(url, { method = 'POST', apiKey, body, headers = {} } = {}) {
  const upstream = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const ctype = (upstream.headers.get('content-type') || '').toLowerCase();
  let data = null;
  if (ctype.includes('application/json')) {
    data = await upstream.json().catch(() => ({}));
  } else if (ctype.startsWith('image/')) {
    const buf = Buffer.from(await upstream.arrayBuffer());
    data = { __binary: buf, __mime: ctype.split(';')[0] };
  } else {
    const text = await upstream.text().catch(() => '');
    try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${upstream.status}` }; }
  }
  return { ok: upstream.ok, status: upstream.status, data, headers: Object.fromEntries(upstream.headers.entries()) };
}

async function waitNvcf(reqId, apiKey, { timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  let delay = 800;
  while (Date.now() - started < timeoutMs) {
    const upstream = await fetch(`https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/${encodeURIComponent(reqId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (upstream.status === 200) {
      return { ok: true, status: 200, data: await upstream.json().catch(() => ({})) };
    }
    if (upstream.status !== 202) {
      return { ok: false, status: upstream.status, data: await upstream.json().catch(() => ({})) };
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(8000, Math.floor(delay * 1.35));
  }
  const err = new Error(`NVIDIA NVCF job ${reqId} timed out`);
  err.status = 504;
  throw err;
}

function resolveProviderConfig(providerConfig = {}) {
  const provider = String(providerConfig.provider || DEFAULTS.provider).toLowerCase();
  if (provider === 'venice') {
    const apiKey = (providerConfig.apiKey || process.env.VENICE_API_KEY || '').trim();
    const baseUrl = (providerConfig.baseUrl || VENICE_BASE).replace(/\/$/, '');
    const model = providerConfig.model || DEFAULTS.veniceModel;
    return {
      provider: 'venice',
      apiKey,
      baseUrl,
      model,
      veniceKeyframeOnly: providerConfig.veniceKeyframeOnly !== false,
    };
  }

  const apiKey = (
    providerConfig.apiKey ||
    process.env.NVIDIA_API_KEY ||
    process.env.NVIDIA_NIM_API_KEY ||
    ''
  ).trim();
  let baseUrl = (providerConfig.baseUrl || process.env.NVIDIA_MEDIA_BASE_URL || NVIDIA_INTEGRATE).replace(/\/$/, '');
  // Public NVIDIA hosts are not always OpenAI image NIM; keep for chat-compatible integrate host.
  if (/ai\.api\.nvidia\.com/i.test(baseUrl)) {
    baseUrl = NVIDIA_INTEGRATE;
  }
  const model = providerConfig.model || DEFAULTS.model;
  return {
    provider: 'nvidia',
    apiKey,
    baseUrl,
    model,
    veniceKeyframeOnly: true,
  };
}

/**
 * Create a provider client from config (swap base URL / model / key).
 * @param {import('./config.js').ProviderConfig} providerConfig
 */
export function createImageProvider(providerConfig = {}) {
  const cfg = resolveProviderConfig(providerConfig);
  if (!cfg.apiKey) {
    const envName = cfg.provider === 'venice' ? 'VENICE_API_KEY' : 'NVIDIA_API_KEY';
    const err = new Error(`Missing API key for provider "${cfg.provider}" (${envName} or providerConfig.apiKey).`);
    err.status = 503;
    throw err;
  }

  return {
    id: cfg.provider,
    model: cfg.model,
    config: cfg,
    /**
     * Unified image generation entry used by the chain loop.
     * @param {ImageGenerateRequest} req
     * @returns {Promise<ImageGenerateResult>}
     */
    async generate(req) {
      if (cfg.provider === 'venice') {
        return generateVenice(cfg, req);
      }
      return generateNvidia(cfg, req);
    },
  };
}

async function generateVenice(cfg, req) {
  const { width, height } = parseSize(req.width, req.height);
  const hasInit = Boolean(req.initImage);
  const conditioning = req.conditioning && req.conditioning.type && req.conditioning.type !== 'none'
    ? req.conditioning
    : null;

  if (hasInit && cfg.veniceKeyframeOnly && !req.allowVeniceChain) {
    const err = new Error(
      'Venice is limited to text-to-image keyframes for this workflow. ' +
        'docs.venice.ai style_references guide aesthetics (not classic img2img denoise). ' +
        'Use provider "nvidia" for the frame-chain loop, or set veniceKeyframeOnly:false to try style_references experimentally.'
    );
    err.status = 400;
    err.code = 'VENICE_KEYFRAME_ONLY';
    throw err;
  }

  // Prefer OpenAI-compatible generations for pure t2i; native generate when chaining experimentally.
  if (!hasInit && !conditioning) {
    const openaiUrl = `${cfg.baseUrl}/images/generations`;
    const body = {
      model: cfg.model,
      prompt: req.prompt,
      n: 1,
      size: `${width}x${height}`,
      response_format: 'b64_json',
      seed: req.seed,
    };
    const result = await fetchJson(openaiUrl, { apiKey: cfg.apiKey, body });
    if (result.ok) {
      const b64 = extractB64Images(result.data)[0];
      if (b64) {
        return {
          buffer: Buffer.from(b64, 'base64'),
          mimeType: 'image/png',
          provider: 'venice',
          model: cfg.model,
          mode: 't2i',
        };
      }
    }
    // Fall through to native endpoint.
  }

  const nativeBody = {
    model: cfg.model,
    prompt: req.prompt,
    width,
    height,
    seed: req.seed,
    format: 'png',
    return_binary: false,
    safe_mode: false,
  };
  if (req.negativePrompt) nativeBody.negative_prompt = req.negativePrompt;

  if (hasInit) {
    // Experimental: style_references is NOT true img2img — documented as aesthetic guidance.
    nativeBody.style_references = [{
      image: toDataUrl(req.initImage, req.initMime || 'image/png'),
      strength: Math.min(1, Math.max(0.1, Number(req.strength) || 0.2)),
    }];
  }

  const native = await fetchJson(`${cfg.baseUrl}/image/generate`, {
    apiKey: cfg.apiKey,
    body: nativeBody,
  });
  if (!native.ok) {
    const detail = native.data?.error || native.data?.message || JSON.stringify(native.data);
    const err = new Error(`Venice image HTTP ${native.status}: ${detail}`);
    err.status = native.status;
    throw err;
  }
  if (native.data?.__binary) {
    return {
      buffer: native.data.__binary,
      mimeType: native.data.__mime || 'image/png',
      provider: 'venice',
      model: cfg.model,
      mode: hasInit ? 'i2i-style-ref' : 't2i',
    };
  }
  const b64 = extractB64Images(native.data)[0];
  if (!b64) {
    const err = new Error('Venice returned no image bytes');
    err.status = 502;
    throw err;
  }
  return {
    buffer: Buffer.from(b64, 'base64'),
    mimeType: 'image/png',
    provider: 'venice',
    model: cfg.model,
    mode: hasInit ? 'i2i-style-ref' : 't2i',
  };
}

function controlModeFromConditioning(conditioning) {
  if (!conditioning || !conditioning.type || conditioning.type === 'none') return null;
  const t = String(conditioning.type).toLowerCase();
  if (t === 'canny' || t === 'edge') return 'canny';
  if (t === 'depth') return 'depth';
  if (t === 'pose') return 'depth'; // pose maps onto depth/canny until a dedicated pose NIM is wired
  return null;
}

async function generateNvidia(cfg, req) {
  const { width, height, size } = parseSize(req.width, req.height);
  const hasInit = Boolean(req.initImage);
  const controlMode = controlModeFromConditioning(req.conditioning);
  const controlImage = req.conditioning?.image
    ? (Buffer.isBuffer(req.conditioning.image)
      ? req.conditioning.image
      : Buffer.from(stripDataUrl(req.conditioning.image).b64, 'base64'))
    : null;

  // 1) OpenAI-compatible generations / edits against configured NIM base URL
  if (!controlMode) {
    if (!hasInit) {
      const body = {
        model: cfg.model,
        prompt: req.prompt,
        n: 1,
        response_format: 'b64_json',
        size,
        seed: req.seed,
      };
      if (req.negativePrompt) body.negative_prompt = req.negativePrompt;
      const gen = await fetchJson(`${cfg.baseUrl}/v1/images/generations`, {
        apiKey: cfg.apiKey,
        body,
      });
      if (gen.ok) {
        const b64 = extractB64Images(gen.data)[0];
        if (b64) {
          return {
            buffer: Buffer.from(b64, 'base64'),
            mimeType: 'image/png',
            provider: 'nvidia',
            model: cfg.model,
            mode: 't2i',
          };
        }
      }
    } else {
      // Prefer generations-with-image (NIM img2img extension), then edits.
      const strength = Number(req.strength) || DEFAULTS.strength;
      const imgB64 = Buffer.isBuffer(req.initImage)
        ? req.initImage.toString('base64')
        : stripDataUrl(req.initImage).b64;

      const genBody = {
        model: cfg.model,
        prompt: req.prompt,
        n: 1,
        response_format: 'b64_json',
        size,
        seed: req.seed,
        image: imgB64,
        strength,
      };
      if (req.negativePrompt) genBody.negative_prompt = req.negativePrompt;

      const gen = await fetchJson(`${cfg.baseUrl}/v1/images/generations`, {
        apiKey: cfg.apiKey,
        body: genBody,
      });
      if (gen.ok) {
        const b64 = extractB64Images(gen.data)[0];
        if (b64) {
          return {
            buffer: Buffer.from(b64, 'base64'),
            mimeType: 'image/png',
            provider: 'nvidia',
            model: cfg.model,
            mode: 'i2i',
          };
        }
      }

      // OpenAI images/edits (multipart)
      const form = new FormData();
      form.append('model', cfg.model);
      form.append('prompt', req.prompt);
      form.append('n', '1');
      form.append('size', size);
      form.append('response_format', 'b64_json');
      form.append('seed', String(req.seed));
      form.append('strength', String(strength));
      const blob = new Blob([req.initImage], { type: req.initMime || 'image/png' });
      form.append('image', blob, 'frame.png');

      const editUpstream = await fetch(`${cfg.baseUrl}/v1/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
        body: form,
      });
      if (editUpstream.ok) {
        const data = await editUpstream.json().catch(() => ({}));
        const b64 = extractB64Images(data)[0];
        if (b64) {
          return {
            buffer: Buffer.from(b64, 'base64'),
            mimeType: 'image/png',
            provider: 'nvidia',
            model: cfg.model,
            mode: 'i2i',
          };
        }
      }
    }
  }

  // 2) Hosted genai FLUX — ControlNet-adjacent modes (canny/depth) + base t2i
  const mode = controlMode || 'base';
  const genaiBody = {
    prompt: req.prompt,
    seed: req.seed,
    steps: /schnell/i.test(cfg.model) ? 4 : 28,
    cfg_scale: /flux/i.test(cfg.model) ? 0 : 3.5,
    mode,
    aspect_ratio: aspectRatio(width, height),
  };
  if (req.negativePrompt) genaiBody.negative_prompt = req.negativePrompt;

  // When chaining without explicit control maps, feed previous frame as control image
  // under canny for structural lock — architecture hook; disabled unless conditioning set
  // or experimental i2i via image field when mode is base.
  if (controlImage) {
    genaiBody.image = toDataUrl(controlImage, 'image/png');
  } else if (hasInit && mode !== 'base') {
    genaiBody.image = toDataUrl(req.initImage, req.initMime || 'image/png');
  } else if (hasInit) {
    // Some hosted FLUX variants accept image + strength for img2img-like behavior.
    genaiBody.image = toDataUrl(req.initImage, req.initMime || 'image/png');
    genaiBody.strength = Number(req.strength) || DEFAULTS.strength;
  }

  let result = await fetchJson(`${NVIDIA_GENAI}/genai/${cfg.model}`, {
    apiKey: cfg.apiKey,
    body: genaiBody,
  });
  if (result.status === 202) {
    const reqId = result.headers['nvcf-reqid'] || result.headers['NVCF-REQID'] || result.headers['nvcf-reqid'.toLowerCase()];
    if (!reqId) {
      const err = new Error('NVIDIA genai returned 202 without NVCF-REQID');
      err.status = 502;
      throw err;
    }
    result = await waitNvcf(String(reqId), cfg.apiKey);
  }

  if (!result.ok) {
    const detail = result.data?.detail || result.data?.error || result.data?.message || JSON.stringify(result.data);
    const err = new Error(
      `NVIDIA image failed (OpenAI NIM + genai). Last error HTTP ${result.status}: ${detail}. ` +
        `For reliable img2img chaining, point providerConfig.baseUrl at a self-hosted FLUX NIM that exposes /v1/images/generations with strength.`
    );
    err.status = result.status || 502;
    throw err;
  }

  const b64 = extractB64Images(result.data)[0];
  if (!b64) {
    const err = new Error('NVIDIA returned no image bytes');
    err.status = 502;
    throw err;
  }
  return {
    buffer: Buffer.from(b64, 'base64'),
    mimeType: 'image/png',
    provider: 'nvidia',
    model: cfg.model,
    mode: controlMode ? 'control' : (hasInit ? 'i2i' : 't2i'),
  };
}

function aspectRatio(width, height) {
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

export const __test = { extractB64Images, resolveProviderConfig, controlModeFromConditioning, stripDataUrl };
