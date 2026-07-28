/**
 * RunPod ComfyUI client — serverless worker-comfyui OR direct ComfyUI on a Pod.
 *
 * Env:
 *   RUNPOD_API_KEY          — RunPod API key
 *   RUNPOD_ENDPOINT_ID      — Serverless endpoint id (preferred for the website)
 *   COMFYUI_BASE_URL        — Optional direct ComfyUI URL (pod :8188), e.g. https://xxx-8188.proxy.runpod.net
 */

import {
  buildWan225bWorkflow,
  videoDimsFromSize,
  framesFromSeconds,
} from './wan22-5b-workflow.js';

function runpodKey() {
  return (process.env.RUNPOD_API_KEY || process.env.RUNPOD_API_KEY_SECRET || '').trim();
}

function runpodEndpointId() {
  return (process.env.RUNPOD_ENDPOINT_ID || process.env.RUNPOD_COMFY_ENDPOINT_ID || '').trim();
}

function comfyBaseUrl() {
  return (process.env.COMFYUI_BASE_URL || process.env.RUNPOD_COMFY_URL || '').trim().replace(/\/$/, '');
}

export function runpodConfigured() {
  return Boolean((runpodKey() && runpodEndpointId()) || comfyBaseUrl());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractMediaFromRunpodOutput(output) {
  if (!output || typeof output !== 'object') return null;

  const buckets = [
    ...(Array.isArray(output.images) ? output.images : []),
    ...(Array.isArray(output.files) ? output.files : []),
    ...(Array.isArray(output.videos) ? output.videos : []),
  ];

  for (const item of buckets) {
    if (!item) continue;
    if (typeof item === 'string') {
      if (/^https?:\/\//i.test(item)) return { type: 'url', data: item, mime: 'video/mp4' };
      if (item.length > 100) return { type: 'base64', data: item.replace(/^data:[^;]+;base64,/, ''), mime: 'video/mp4' };
      continue;
    }
    const filename = String(item.filename || item.name || '');
    const data = item.data || item.url || item.image || item.video;
    const typ = String(item.type || '').toLowerCase();
    if (!data) continue;
    if (typ === 's3_url' || /^https?:\/\//i.test(String(data))) {
      return { type: 'url', data: String(data), mime: guessMime(filename) };
    }
    return {
      type: 'base64',
      data: String(data).replace(/^data:[^;]+;base64,/, ''),
      mime: guessMime(filename),
      filename,
    };
  }

  // Some workers nest message / result
  if (typeof output.message === 'string' && /^https?:\/\//i.test(output.message)) {
    return { type: 'url', data: output.message, mime: 'video/mp4' };
  }
  return null;
}

function guessMime(filename) {
  const f = String(filename || '').toLowerCase();
  if (f.endsWith('.webm')) return 'video/webm';
  if (f.endsWith('.gif')) return 'image/gif';
  if (f.endsWith('.png')) return 'image/png';
  if (f.endsWith('.jpg') || f.endsWith('.jpeg')) return 'image/jpeg';
  if (f.endsWith('.webp')) return 'image/webp';
  return 'video/mp4';
}

async function runpodRunAsync(endpointId, key, payload, { timeoutMs = 280_000 } = {}) {
  const submit = await fetch(`https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const submitted = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    const err = new Error(submitted.error || submitted.message || `RunPod HTTP ${submit.status}`);
    err.status = submit.status || 502;
    throw err;
  }
  const jobId = submitted.id || submitted.jobId;
  if (!jobId) {
    // Rare: sync-ish response
    if (submitted.status === 'COMPLETED' && submitted.output) return submitted;
    const err = new Error('RunPod did not return a job id.');
    err.status = 502;
    throw err;
  }

  const started = Date.now();
  let delay = 2500;
  while (Date.now() - started < timeoutMs) {
    await sleep(delay);
    const st = await fetch(
      `https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}/status/${encodeURIComponent(jobId)}`,
      { headers: { Authorization: `Bearer ${key}` } }
    );
    const body = await st.json().catch(() => ({}));
    const status = String(body.status || '').toUpperCase();
    if (status === 'COMPLETED') return body;
    if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
      const detail =
        body.error ||
        body.output?.error ||
        (Array.isArray(body.output?.errors) ? body.output.errors.join('; ') : null) ||
        `RunPod job ${status}`;
      const err = new Error(String(detail));
      err.status = 502;
      throw err;
    }
    delay = Math.min(8000, Math.floor(delay * 1.2));
  }
  const err = new Error(`RunPod job ${jobId} timed out waiting for Wan video.`);
  err.status = 504;
  throw err;
}

async function comfyDirectGenerate(baseUrl, workflow, images, { timeoutMs = 280_000 } = {}) {
  // Optional: upload images to ComfyUI input folder
  for (const img of images || []) {
    const raw = String(img.image || '').replace(/^data:[^;]+;base64,/, '');
    const blob = Buffer.from(raw, 'base64');
    const form = new FormData();
    // Node 18+ FormData + Blob
    form.append('image', new Blob([blob], { type: 'image/jpeg' }), img.name);
    form.append('overwrite', 'true');
    const up = await fetch(`${baseUrl}/upload/image`, { method: 'POST', body: form });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      const err = new Error(`ComfyUI image upload failed: ${up.status} ${t}`);
      err.status = up.status || 502;
      throw err;
    }
  }

  const queued = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const qBody = await queued.json().catch(() => ({}));
  if (!queued.ok) {
    const err = new Error(qBody.error || qBody.node_errors || `ComfyUI /prompt HTTP ${queued.status}`);
    err.status = queued.status || 502;
    throw err;
  }
  const promptId = qBody.prompt_id;
  if (!promptId) {
    const err = new Error('ComfyUI did not return prompt_id.');
    err.status = 502;
    throw err;
  }

  const started = Date.now();
  let delay = 2000;
  while (Date.now() - started < timeoutMs) {
    await sleep(delay);
    const hist = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`);
    const hBody = await hist.json().catch(() => ({}));
    const entry = hBody[promptId];
    if (!entry) {
      delay = Math.min(8000, Math.floor(delay * 1.2));
      continue;
    }
    if (entry.status?.status_str === 'error' || entry.status?.completed === false && entry.status?.messages?.some?.((m) => m[0] === 'execution_error')) {
      const err = new Error('ComfyUI workflow failed.');
      err.status = 502;
      throw err;
    }
    const outputs = entry.outputs || {};
    for (const nodeOut of Object.values(outputs)) {
      const videos = nodeOut.videos || nodeOut.gifs || [];
      for (const v of videos) {
        const filename = v.filename;
        const subfolder = v.subfolder || '';
        const type = v.type || 'output';
        const viewUrl = `${baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
        // Fetch bytes so the website can play without depending on RunPod proxy auth
        const fileRes = await fetch(viewUrl);
        if (!fileRes.ok) continue;
        const buf = Buffer.from(await fileRes.arrayBuffer());
        return {
          type: 'base64',
          data: buf.toString('base64'),
          mime: guessMime(filename),
          filename,
        };
      }
      const images = nodeOut.images || [];
      // Fallback: if only frames, skip — we need a video file from SaveVideo
      if (images.length && String(images[0].filename || '').match(/\.(mp4|webm)$/i)) {
        const v = images[0];
        const viewUrl = `${baseUrl}/view?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder || '')}&type=${encodeURIComponent(v.type || 'output')}`;
        const fileRes = await fetch(viewUrl);
        if (fileRes.ok) {
          const buf = Buffer.from(await fileRes.arrayBuffer());
          return { type: 'base64', data: buf.toString('base64'), mime: guessMime(v.filename), filename: v.filename };
        }
      }
    }
    if (entry.status?.completed) {
      const err = new Error('ComfyUI finished but produced no video file. Check SaveVideo node / models.');
      err.status = 502;
      throw err;
    }
    delay = Math.min(8000, Math.floor(delay * 1.2));
  }
  const err = new Error('ComfyUI timed out waiting for Wan video.');
  err.status = 504;
  throw err;
}

/**
 * Generate Wan 2.2 5B video via RunPod serverless ComfyUI or a direct ComfyUI URL.
 */
export async function generateRunpodWan22({
  prompt,
  negativePrompt,
  size,
  seconds,
  imageBase64,
  mimeType,
}) {
  const key = runpodKey();
  const endpointId = runpodEndpointId();
  const direct = comfyBaseUrl();

  if (!((key && endpointId) || direct)) {
    const err = new Error(
      'RunPod Wan is not configured. Set RUNPOD_API_KEY + RUNPOD_ENDPOINT_ID ' +
        '(serverless ComfyUI), or COMFYUI_BASE_URL for a running Pod.'
    );
    err.status = 503;
    throw err;
  }

  const { width, height } = videoDimsFromSize(size);
  const length = framesFromSeconds(seconds, 24);
  const inputImageName = imageBase64 ? 'wan_ref.jpg' : null;
  const workflow = buildWan225bWorkflow({
    prompt,
    negativePrompt,
    width,
    height,
    length,
    inputImageName,
  });

  const images = [];
  if (imageBase64) {
    const raw = String(imageBase64);
    images.push({
      name: inputImageName,
      image: raw.startsWith('data:') ? raw : `data:${mimeType || 'image/jpeg'};base64,${raw}`,
    });
  }

  let media;
  if (key && endpointId) {
    const result = await runpodRunAsync(
      endpointId,
      key,
      { input: { workflow, images: images.length ? images : undefined } },
      { timeoutMs: 280_000 }
    );
    media = extractMediaFromRunpodOutput(result.output || result);
    if (!media) {
      const err = new Error(
        'RunPod finished but returned no video. Enable S3 upload on the worker or check the SaveVideo output. ' +
          `Raw keys: ${Object.keys(result.output || {}).join(',') || 'none'}`
      );
      err.status = 502;
      throw err;
    }
  } else {
    media = await comfyDirectGenerate(direct, workflow, images, { timeoutMs: 280_000 });
  }

  if (media.type === 'url') {
    return {
      kind: 'video',
      provider: 'runpod',
      model: 'wan2.2-ti2v-5b',
      videoUrl: media.data,
      mime: media.mime || 'video/mp4',
    };
  }

  // Base64 path — keep under Vercel 4.5MB or fail clearly
  const b64 = media.data;
  if (Buffer.byteLength(b64, 'utf8') > 3_200_000) {
    const err = new Error(
      'Wan video is too large to return through Vercel (4.5MB). ' +
        'On the RunPod worker, enable S3/R2 upload so the API returns a URL, ' +
        'or request a shorter clip (try 2–3 seconds).'
    );
    err.status = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  return {
    kind: 'video',
    provider: 'runpod',
    model: 'wan2.2-ti2v-5b',
    videoUrl: `data:${media.mime || 'video/mp4'};base64,${b64}`,
    mime: media.mime || 'video/mp4',
  };
}
