/**
 * Frame-chain generation loop.
 *
 * Frame 0: text-to-image (locked seed)
 * Frames 1..N: image-to-image using previous frame + prompt delta
 *
 * Architecture note:
 * Pure img2img drifts after ~10–15 frames. This loop accepts an optional
 * `conditioning` hook (pose/depth/edge ControlNet maps) per frame so a
 * ControlNet step can be added later without rewriting the pipeline.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { composeFramePrompt, normalizeAnimateConfig } from './config.js';
import { createImageProvider } from './providers.js';

/**
 * Resolve per-frame conditioning (static object or async function).
 * @param {import('./config.js').AnimateConfig} cfg
 * @param {number} frameIndex
 * @param {Buffer|null} prevFrame
 */
async function resolveConditioning(cfg, frameIndex, prevFrame) {
  const c = cfg.conditioning;
  if (!c) return null;
  if (typeof c === 'function') {
    const out = await c(frameIndex, prevFrame);
    return out || null;
  }
  if (c.type && c.type !== 'none') return c;
  return null;
}

/**
 * Generate a keyframe sequence via prompt-delta img2img chaining.
 *
 * @param {import('./config.js').AnimateConfig} rawConfig
 * @param {{ provider?: ReturnType<typeof createImageProvider>, framesDir?: string }} [opts]
 * @returns {Promise<{ frames: Array<{ index:number, path:string, prompt:string, mode:string }>, framesDir: string, seed: number, strength: number }>}
 */
export async function generateFrameChain(rawConfig, opts = {}) {
  const cfg = normalizeAnimateConfig(rawConfig);
  const provider = opts.provider || createImageProvider(cfg.providerConfig);
  const framesDir = opts.framesDir || path.join(cfg.outputDir || await defaultWorkDir(), 'keyframes');
  await fs.mkdir(framesDir, { recursive: true });

  /** @type {Array<{ index:number, path:string, prompt:string, mode:string }>} */
  const frames = [];
  /** @type {Buffer|null} */
  let prev = null;
  let prevMime = 'image/png';

  // Hybrid strategy: Venice may generate frame 0 only; NVIDIA runs the chain.
  const chainProvider = provider;
  let keyframeProvider = provider;
  if (provider.id === 'nvidia' && process.env.VENICE_API_KEY && cfg.providerConfig?.useVeniceKeyframe) {
    try {
      keyframeProvider = createImageProvider({
        provider: 'venice',
        apiKey: process.env.VENICE_API_KEY,
        model: cfg.providerConfig.veniceModel || 'flux-dev-uncensored',
      });
    } catch {
      keyframeProvider = provider;
    }
  }

  for (let i = 0; i < cfg.frameCount; i += 1) {
    const delta = cfg.promptDeltas[i];
    const prompt = composeFramePrompt(cfg.basePrompt, delta, i);
    const conditioning = await resolveConditioning(cfg, i, prev);
    const active = i === 0 ? keyframeProvider : chainProvider;

    cfg.onProgress({
      stage: 'generate',
      frame: i,
      total: cfg.frameCount,
      prompt,
      provider: active.id,
    });

    const result = await active.generate({
      prompt,
      seed: cfg.seed,
      strength: cfg.strength,
      initImage: i === 0 ? null : prev,
      initMime: prevMime,
      conditioning,
      width: cfg.width,
      height: cfg.height,
      negativePrompt: cfg.negativePrompt || undefined,
      allowVeniceChain: cfg.providerConfig?.veniceKeyframeOnly === false,
    });

    const ext = result.mimeType.includes('jpeg') || result.mimeType.includes('jpg') ? 'jpg' : 'png';
    const filePath = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.${ext}`);
    await fs.writeFile(filePath, result.buffer);

    frames.push({
      index: i,
      path: filePath,
      prompt,
      mode: result.mode || (i === 0 ? 't2i' : 'i2i'),
      provider: result.provider,
      model: result.model,
    });

    prev = result.buffer;
    prevMime = result.mimeType;
  }

  return {
    frames,
    framesDir,
    seed: cfg.seed,
    strength: cfg.strength,
    frameCount: cfg.frameCount,
  };
}

async function defaultWorkDir() {
  const { tmpdir } = await import('node:os');
  const dir = path.join(tmpdir(), `animate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export { composeFramePrompt };
