/**
 * POST /api/media-generate
 *
 * Body:
 *   {
 *     kind: 'image' | 'video',
 *     provider: 'gemini' | 'nvidia' | 'wan',
 *     model?: string,
 *     prompt: string,
 *     negativePrompt?: string,
 *     size?: string,          // image: 1024x1024 | video: 832*480 / 1920*1080
 *     imageBase64?: string,   // optional reference / i2v frame (data URL or raw b64)
 *     mimeType?: string
 *   }
 *
 * Env (Vercel → Settings → Environment Variables):
 *   GEMINI_API_KEY      — Gemini Nano Banana image gen
 *   NVIDIA_API_KEY      — Qwen-Image on NVIDIA
 *   DASHSCOPE_API_KEY   — Wan 2.2 video (Alibaba Model Studio / DashScope)
 *   DASHSCOPE_BASE_URL  — optional, default https://dashscope-intl.aliyuncs.com
 */

const GEMINI_IMAGE_MODELS = {
  'nano-banana': 'gemini-2.5-flash-image',
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image': 'gemini-2.5-flash-image',
  'gemini-3.1-flash-image-preview': 'gemini-3.1-flash-image-preview',
};

const NVIDIA_IMAGE_MODELS = {
  'qwen-image': 'qwen/qwen-image',
  'qwen/qwen-image': 'qwen/qwen-image',
  'qwen-image-2512': 'qwen/qwen-image-2512',
  'qwen/qwen-image-2512': 'qwen/qwen-image-2512',
};

const WAN_VIDEO_MODELS = {
  'wan2.2-t2v': 'wan2.2-t2v-plus',
  'wan2.2-t2v-plus': 'wan2.2-t2v-plus',
  'wan2.2-i2v': 'wan2.2-i2v-plus',
  'wan2.2-i2v-plus': 'wan2.2-i2v-plus',
};

function dashBase() {
  return (process.env.DASHSCOPE_BASE_URL || 'https://dashscope-intl.aliyuncs.com').replace(/\/$/, '');
}

function stripDataUrl(input) {
  const s = String(input || '');
  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (m) return { mime: m[1], b64: m[2] };
  return { mime: null, b64: s.replace(/\s+/g, '') };
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
      if (d.b64_json) return { mimeType: 'image/png', base64: String(d.b64_json).replace(/^data:image\/\w+;base64,/, '') };
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

async function generateNvidiaQwenImage({ prompt, model, size, negativePrompt }) {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    const err = new Error('Missing NVIDIA_API_KEY in Vercel env.');
    err.status = 503;
    throw err;
  }
  const modelId = NVIDIA_IMAGE_MODELS[model] || NVIDIA_IMAGE_MODELS['qwen-image'];
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };

  // Preferred: OpenAI-compatible hosted images API
  const openaiBody = {
    model: modelId,
    prompt,
    n: 1,
    response_format: 'b64_json',
  };
  if (size) openaiBody.size = size;
  if (negativePrompt) openaiBody.negative_prompt = negativePrompt;

  let upstream = await fetch('https://integrate.api.nvidia.com/v1/images/generations', {
    method: 'POST',
    headers,
    body: JSON.stringify(openaiBody),
  });
  let data = await upstream.json().catch(() => ({}));

  // Fallback: Visual GenAI invoke path used by some build.nvidia.com samples
  if (!upstream.ok || !parseNvidiaImages(data).length) {
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
        // map common sizes to aspect_ratio
        const ratio = w / h;
        genaiBody.aspect_ratio =
          Math.abs(ratio - 1) < 0.05 ? '1:1' : ratio > 1 ? '16:9' : '9:16';
      }
    }
    const genai = await fetch(`https://ai.api.nvidia.com/v1/genai/qwen/${slug}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(genaiBody),
    });
    const genaiData = await genai.json().catch(() => ({}));
    if (genai.ok && parseNvidiaImages(genaiData).length) {
      upstream = genai;
      data = genaiData;
    } else if (!upstream.ok) {
      const msg =
        data?.error?.message ||
        data?.detail ||
        data?.message ||
        genaiData?.error?.message ||
        genaiData?.detail ||
        `NVIDIA HTTP ${upstream.status}`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      err.status = upstream.status;
      throw err;
    }
  }

  const images = parseNvidiaImages(data);
  if (!images.length) {
    const err = new Error(
      'NVIDIA Qwen-Image returned no image. Confirm the key has access to qwen/qwen-image on build.nvidia.com.'
    );
    err.status = 502;
    throw err;
  }
  return {
    kind: 'image',
    provider: 'nvidia',
    model: modelId,
    images,
  };
}

async function pollWanTask(taskId, apiKey, { timeoutMs = 240_000, intervalMs = 3000 } = {}) {
  const started = Date.now();
  const url = `${dashBase()}/api/v1/tasks/${encodeURIComponent(taskId)}`;
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.message || data?.code || `Wan poll HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const status = data?.output?.task_status || data?.task_status;
    if (status === 'SUCCEEDED') {
      const videoUrl = data?.output?.video_url || data?.output?.results?.[0]?.url;
      if (!videoUrl) {
        const err = new Error('Wan succeeded but returned no video_url.');
        err.status = 502;
        throw err;
      }
      return { videoUrl, raw: data };
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const msg = data?.output?.message || data?.message || `Wan task ${status}`;
      const err = new Error(msg);
      err.status = 502;
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error('Wan video generation timed out.');
  err.status = 504;
  throw err;
}

async function generateWanVideo({ prompt, model, size, imageBase64, mimeType }) {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) {
    const err = new Error('Missing DASHSCOPE_API_KEY in Vercel env.');
    err.status = 503;
    throw err;
  }

  const hasImage = Boolean(imageBase64);
  const modelId = hasImage
    ? (WAN_VIDEO_MODELS[model] || WAN_VIDEO_MODELS['wan2.2-i2v'])
    : (WAN_VIDEO_MODELS[model] || WAN_VIDEO_MODELS['wan2.2-t2v']);

  // i2v models need img_url — DashScope accepts public URLs; for uploads we
  // pass a data URL when the region supports it, else fail clearly.
  const input = { prompt };
  if (hasImage) {
    const { mime, b64 } = stripDataUrl(imageBase64);
    const mt = mimeType || mime || 'image/png';
    input.img_url = `data:${mt};base64,${b64}`;
  }

  const parameters = {
    prompt_extend: true,
  };
  if (size) parameters.size = size.includes('*') ? size : size.replace('x', '*');

  const submitUrl = `${dashBase()}/api/v1/services/aigc/video-generation/video-synthesis`;
  const submit = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: modelId,
      input,
      parameters,
    }),
  });
  const submitData = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    const msg = submitData?.message || submitData?.code || `Wan submit HTTP ${submit.status}`;
    const err = new Error(msg);
    err.status = submit.status;
    throw err;
  }
  const taskId = submitData?.output?.task_id;
  if (!taskId) {
    const err = new Error('Wan submit returned no task_id.');
    err.status = 502;
    throw err;
  }

  const { videoUrl } = await pollWanTask(taskId, key);
  return {
    kind: 'video',
    provider: 'wan',
    model: modelId,
    taskId,
    videoUrl,
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
      // Default image path: Gemini Nano Banana (also used when provider omitted)
      const out = await generateGeminiImage({
        prompt: prompt.trim(),
        model: model || 'nano-banana',
        imageBase64,
        mimeType,
      });
      return res.status(200).json(out);
    }

    if (kind === 'video') {
      const out = await generateWanVideo({
        prompt: prompt.trim(),
        model: model || (imageBase64 ? 'wan2.2-i2v' : 'wan2.2-t2v'),
        size: size || '832*480',
        imageBase64,
        mimeType,
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
