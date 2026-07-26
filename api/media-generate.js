/**
 * POST /api/media-generate
 *
 * Body:
 *   {
 *     kind: 'image' | 'video',
 *     provider: 'gemini' | 'nvidia',
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
 *   GEMINI_API_KEY         — Gemini Nano Banana image gen
 *   NVIDIA_API_KEY         — Qwen Image + Wan 2.2 video (build.nvidia.com)
 *   NVIDIA_MEDIA_BASE_URL  — optional; default https://integrate.api.nvidia.com
 *                            point at a self-hosted Wan/Qwen NIM if needed
 */

const GEMINI_IMAGE_MODELS = {
  'nano-banana': 'gemini-2.5-flash-image',
  'gemini-2.5-flash-image': 'gemini-2.5-flash-image',
};

const NVIDIA_IMAGE_MODELS = {
  'qwen-image': 'qwen/qwen-image',
  'qwen/qwen-image': 'qwen/qwen-image',
};

const NVIDIA_VIDEO_MODELS = {
  'wan2.2': 'wan-ai/wan2.2',
  'wan-ai/wan2.2': 'wan-ai/wan2.2',
  'wan2.2-t2v': 'wan-ai/wan2.2',
  'wan2.2-i2v': 'wan-ai/wan2.2',
};

function nvidiaBase() {
  return (process.env.NVIDIA_MEDIA_BASE_URL || 'https://integrate.api.nvidia.com').replace(/\/$/, '');
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

async function generateGeminiImage({ prompt, model, imageBase64, mimeType }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const err = new Error('Missing GEMINI_API_KEY in Vercel env.');
    err.status = 503;
    throw err;
  }
  const modelId = GEMINI_IMAGE_MODELS[model] || GEMINI_IMAGE_MODELS['nano-banana'];
  const parts = [{ text: prompt }];
  if (imageBase64) {
    const { mime, b64 } = stripDataUrl(imageBase64);
    parts.unshift({
      inline_data: {
        mime_type: mimeType || mime || 'image/png',
        data: b64,
      },
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const msg = data?.error?.message || data?.message || `Gemini HTTP ${upstream.status}`;
    const err = new Error(msg);
    err.status = upstream.status;
    throw err;
  }

  const outParts = data?.candidates?.[0]?.content?.parts || [];
  const images = [];
  let text = '';
  for (const p of outParts) {
    if (p.text) text += p.text;
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      images.push({
        mimeType: inline.mimeType || inline.mime_type || 'image/png',
        base64: inline.data,
      });
    }
  }
  if (!images.length) {
    const block = data?.promptFeedback?.blockReason || data?.promptFeedback?.block_reason;
    const err = new Error(
      text ||
        (block
          ? `Gemini blocked the request (${block}).`
          : 'Gemini returned no image. Check model access / free-tier quota.')
    );
    err.status = 502;
    throw err;
  }
  return {
    kind: 'image',
    provider: 'gemini',
    model: modelId,
    images,
    text: text || undefined,
  };
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
  return artifacts
    .map((a) => {
      const b64 = a?.base64 || a?.b64_json;
      if (!b64) return null;
      return {
        mimeType: 'image/png',
        base64: String(b64).replace(/^data:image\/\w+;base64,/, ''),
      };
    })
    .filter(Boolean);
}

async function nvidiaPost(path, body, key) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };
  const urls = [
    `${nvidiaBase()}${path}`,
    // Hosted catalog sometimes serves visual models on ai.api
    `https://ai.api.nvidia.com${path}`,
  ];
  // de-dupe if NVIDIA_MEDIA_BASE_URL already is ai.api
  const seen = new Set();
  let last = { ok: false, status: 0, data: {} };
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await upstream.json().catch(() => ({}));
    last = { ok: upstream.ok, status: upstream.status, data, url };
    if (upstream.ok) return last;
  }
  return last;
}

async function generateNvidiaQwenImage({ prompt, model, size, negativePrompt }) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    const err = new Error('Missing NVIDIA_API_KEY in Vercel env.');
    err.status = 503;
    throw err;
  }
  const modelId = NVIDIA_IMAGE_MODELS[model] || NVIDIA_IMAGE_MODELS['qwen-image'];
  const openaiBody = {
    model: modelId,
    prompt,
    n: 1,
    response_format: 'b64_json',
  };
  if (size) openaiBody.size = size;
  if (negativePrompt) openaiBody.negative_prompt = negativePrompt;

  let result = await nvidiaPost('/v1/images/generations', openaiBody, key);
  let images = result.ok ? parseNvidiaImages(result.data) : [];

  if (!images.length) {
    // Visual GenAI invoke shape used by some build.nvidia.com samples
    const slug = modelId.replace(/^qwen\//, '');
    const genaiBody = {
      prompt,
      negative_prompt: negativePrompt || '',
      seed: 0,
      steps: 20,
      cfg_scale: 4.0,
    };
    if (size) {
      const [w, h] = String(size).split(/[x*]/).map(Number);
      if (w && h) {
        const ratio = w / h;
        genaiBody.aspect_ratio =
          Math.abs(ratio - 1) < 0.05 ? '1:1' : ratio > 1 ? '16:9' : '9:16';
      }
    }
    result = await nvidiaPost(`/v1/genai/qwen/${slug}`, genaiBody, key);
    images = result.ok ? parseNvidiaImages(result.data) : [];
  }

  if (!images.length) {
    const msg =
      result.data?.error?.message ||
      result.data?.detail ||
      result.data?.message ||
      `NVIDIA Qwen-Image HTTP ${result.status || 'error'}. Enable qwen/qwen-image on build.nvidia.com for this key.`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = result.status || 502;
    throw err;
  }

  return {
    kind: 'image',
    provider: 'nvidia',
    model: modelId,
    images,
  };
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
  const key = process.env.NVIDIA_API_KEY;
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

  const body = {
    model: modelId,
    prompt,
    size: finalSize,
    seconds: Math.min(12, Math.max(1, Number(seconds) || 4)),
  };
  if (imageBase64) {
    const { mime, b64 } = stripDataUrl(imageBase64);
    const mt = (mimeType || mime || 'image/png').replace('image/jpg', 'image/jpeg');
    body.input_reference = asDataUrl(mt, b64);
  }

  // OpenAI-compatible video endpoint (NVIDIA NIM Wan 2.2)
  let result = await nvidiaPost('/v1/videos/generations', body, key);
  let b64 =
    result.ok &&
    (result.data?.data?.b64_json ||
      result.data?.data?.[0]?.b64_json ||
      result.data?.b64_json);

  // Native /v1/infer fallback (self-hosted NIM shape)
  if (!b64) {
    const [w, h] = finalSize.split('x').map(Number);
    const inferBody = {
      prompt,
      width: w || 832,
      height: h || 480,
      num_frames: Math.min(201, Math.max(1, (Number(seconds) || 4) * 16 + 1)),
      fps: 16,
      cfg_scale: 5.0,
      seed: 0,
    };
    if (negativePrompt) inferBody.negative_prompt = negativePrompt;
    if (imageBase64) {
      const { mime, b64: raw } = stripDataUrl(imageBase64);
      const mt = (mimeType || mime || 'image/png').replace('image/jpg', 'image/jpeg');
      inferBody.image = asDataUrl(mt, raw);
    }
    result = await nvidiaPost('/v1/infer', inferBody, key);
    b64 =
      result.ok &&
      (result.data?.artifacts?.[0]?.base64 ||
        result.data?.data?.b64_json ||
        result.data?.b64_json);
  }

  if (!b64) {
    const msg =
      result.data?.error?.message ||
      result.data?.detail ||
      result.data?.message ||
      `NVIDIA Wan 2.2 HTTP ${result.status || 'error'}. Use NVIDIA_API_KEY from build.nvidia.com (model wan-ai/wan2.2). If your account only has the downloadable NIM, set NVIDIA_MEDIA_BASE_URL to that NIM host.`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
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
        const out = await generateNvidiaQwenImage({
          prompt: prompt.trim(),
          model,
          size,
          negativePrompt,
        });
        return res.status(200).json(out);
      }
      const out = await generateGeminiImage({
        prompt: prompt.trim(),
        model: model || 'nano-banana',
        imageBase64,
        mimeType,
      });
      return res.status(200).json(out);
    }

    if (kind === 'video') {
      // Wan 2.2 on NVIDIA — not DashScope
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
    }

    return res.status(400).json({ error: `Unknown kind: ${kind}` });
  } catch (err) {
    console.error('media-generate error:', err);
    return res.status(err.status || 502).json({
      error: err.message || 'Media generation failed',
    });
  }
}
