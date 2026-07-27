/**
 * Frame-chain AI animation workflow.
 *
 * Pipeline (separable):
 *   1. generateFrameChain()  — t2i keyframe + img2img chain with prompt deltas
 *   2. interpolateFrames()   — pluggable RIFE / FILM / ffmpeg
 *   3. stitchFramesToVideo() — ffmpeg encode
 *
 * ControlNet-ready: pass `conditioning` (object or per-frame fn) without
 * changing the pipeline shape. Pure img2img alone drifts after ~10–15 frames.
 *
 * @example
 *   import { generateAnimatedSequence } from './lib/animate/index.js';
 *   const { videoPath } = await generateAnimatedSequence({
 *     basePrompt: 'a red robot waving in a sunlit workshop, cinematic',
 *     frameCount: 12,
 *     seed: 42,
 *     strength: 0.2,
 *     providerConfig: { provider: 'nvidia', model: 'black-forest-labs/flux.1-dev' },
 *   });
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeAnimateConfig, DEFAULTS, clampStrength, defaultPromptDeltas } from './config.js';
import { createImageProvider } from './providers.js';
import { generateFrameChain } from './chain.js';
import { interpolateFrames, registerInterpolator, listInterpolators } from './interpolate.js';
import { stitchFramesToVideo } from './stitch.js';

/**
 * End-to-end: base prompt → keyframe chain → interpolation → stitched video.
 *
 * @param {import('./config.js').AnimateConfig} rawConfig
 * @returns {Promise<{
 *   videoPath: string,
 *   keyframes: object[],
 *   interpolated: string[],
 *   workDir: string,
 *   config: object,
 * }>}
 */
export async function generateAnimatedSequence(rawConfig = {}) {
  const cfg = normalizeAnimateConfig(rawConfig);
  const workDir = cfg.outputDir || path.join(
    os.tmpdir(),
    `animate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.mkdir(workDir, { recursive: true });

  const provider = createImageProvider(cfg.providerConfig);

  // --- 1. Frame chain ---
  const chain = await generateFrameChain(
    { ...cfg, outputDir: workDir },
    { provider, framesDir: path.join(workDir, 'keyframes') }
  );
  const keyframePaths = chain.frames.map((f) => f.path);

  // --- 2. Interpolation (pluggable) ---
  let interpolated = keyframePaths;
  if (cfg.interpolation !== 'none') {
    interpolated = await interpolateFrames(keyframePaths, {
      method: cfg.interpolation,
      factor: cfg.interpolateFactor,
      fps: cfg.fps,
      outputDir: path.join(workDir, 'interpolated'),
      onProgress: cfg.onProgress,
    });
  } else {
    cfg.onProgress({ stage: 'interpolate', method: 'none', output: keyframePaths.length });
  }

  // --- 3. Stitch ---
  const outputPath = cfg.outputPath || path.join(workDir, `sequence.${cfg.format}`);
  const stitch = await stitchFramesToVideo(interpolated, {
    outputPath,
    fps: cfg.interpolation === 'none' ? cfg.fps : cfg.fps * Math.max(1, cfg.interpolateFactor),
    format: cfg.format,
    width: cfg.width,
    height: cfg.height,
    onProgress: cfg.onProgress,
  });

  cfg.onProgress({ stage: 'done', videoPath: stitch.outputPath });

  return {
    videoPath: stitch.outputPath,
    keyframes: chain.frames,
    interpolated,
    workDir,
    config: {
      basePrompt: cfg.basePrompt,
      frameCount: cfg.frameCount,
      seed: cfg.seed,
      strength: cfg.strength,
      provider: provider.id,
      model: provider.model,
      interpolation: cfg.interpolation,
      interpolateFactor: cfg.interpolateFactor,
      width: cfg.width,
      height: cfg.height,
      fps: cfg.fps,
      format: cfg.format,
      promptDeltas: cfg.promptDeltas,
    },
  };
}

export {
  generateFrameChain,
  interpolateFrames,
  stitchFramesToVideo,
  createImageProvider,
  registerInterpolator,
  listInterpolators,
  normalizeAnimateConfig,
  DEFAULTS,
  clampStrength,
  defaultPromptDeltas,
};
