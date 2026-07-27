/**
 * Config normalization for the frame-chain animation workflow.
 */

export const DEFAULTS = {
  frameCount: 12,
  seed: 42,
  strength: 0.2,
  strengthMin: 0.15,
  strengthMax: 0.3,
  provider: 'nvidia',
  model: 'black-forest-labs/flux.1-dev',
  veniceModel: 'flux-dev-uncensored',
  interpolation: 'ffmpeg', // 'ffmpeg' | 'rife' | 'film' | 'none'
  interpolateFactor: 2,
  width: 1024,
  height: 1024,
  fps: 12,
  format: 'mp4', // mp4 | webm
  outputDir: null, // default: os tmp
};

/**
 * @typedef {Object} ProviderConfig
 * @property {'nvidia'|'venice'} [provider]
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {string} [model]
 * @property {boolean} [veniceKeyframeOnly]  // default true — Venice chain loop off unless opted in
 */

/**
 * @typedef {Object} FrameConditioning
 * @property {'none'|'canny'|'depth'|'pose'|'edge'} [type]
 * @property {Buffer|string|null} [image]  // control map (pose/depth/edge); not the init image
 * @property {number} [scale]
 */

/**
 * @typedef {Object} AnimateConfig
 * @property {string} basePrompt
 * @property {number} [frameCount]
 * @property {number} [seed]
 * @property {number} [strength]
 * @property {string[]|string} [promptDeltas]  // per-frame motion deltas; auto-generated if omitted
 * @property {ProviderConfig} [providerConfig]
 * @property {'ffmpeg'|'rife'|'film'|'none'} [interpolation]
 * @property {number} [interpolateFactor]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [fps]
 * @property {'mp4'|'webm'} [format]
 * @property {string} [outputDir]
 * @property {string} [outputPath]
 * @property {FrameConditioning|((frameIndex:number, prev:Buffer|null)=>FrameConditioning|null|Promise<FrameConditioning|null>)} [conditioning]
 * @property {(info:object)=>void} [onProgress]
 */

export function clampStrength(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULTS.strength;
  return Math.min(DEFAULTS.strengthMax, Math.max(DEFAULTS.strengthMin, n));
}

/**
 * Build incremental motion-delta strings when the caller does not supply them.
 * Example: "arm raised 8%", "arm raised 17%", …
 */
export function defaultPromptDeltas(frameCount, motionHint = 'subject motion advances') {
  const n = Math.max(1, Number(frameCount) || DEFAULTS.frameCount);
  const deltas = ['base keyframe, neutral pose'];
  for (let i = 1; i < n; i += 1) {
    const pct = Math.round((i / (n - 1 || 1)) * 100);
    deltas.push(`${motionHint} ${pct}%`);
  }
  return deltas;
}

/**
 * @param {AnimateConfig} raw
 * @returns {Required<Pick<AnimateConfig,'basePrompt'|'frameCount'|'seed'|'strength'|'promptDeltas'|'interpolation'|'interpolateFactor'|'width'|'height'|'fps'|'format'>> & AnimateConfig}
 */
export function normalizeAnimateConfig(raw = {}) {
  const basePrompt = String(raw.basePrompt || raw.base_prompt || '').trim();
  if (!basePrompt) {
    throw new Error('basePrompt is required');
  }

  const frameCount = Math.max(2, Math.min(48, Number(raw.frameCount ?? raw.frame_count ?? DEFAULTS.frameCount) || DEFAULTS.frameCount));
  const seed = Number.isFinite(Number(raw.seed)) ? Number(raw.seed) : DEFAULTS.seed;
  const strength = clampStrength(raw.strength ?? DEFAULTS.strength);

  let promptDeltas = raw.promptDeltas ?? raw.prompt_deltas ?? raw.deltas;
  if (typeof promptDeltas === 'string') {
    promptDeltas = promptDeltas.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(promptDeltas) || promptDeltas.length === 0) {
    promptDeltas = defaultPromptDeltas(frameCount, raw.motionHint || raw.motion_hint || 'subtle motion advances');
  }
  while (promptDeltas.length < frameCount) {
    const last = promptDeltas[promptDeltas.length - 1] || 'motion continues';
    promptDeltas.push(last);
  }
  promptDeltas = promptDeltas.slice(0, frameCount);

  const providerConfig = {
    provider: String(raw.providerConfig?.provider || raw.provider || DEFAULTS.provider).toLowerCase(),
    apiKey: raw.providerConfig?.apiKey || raw.apiKey || undefined,
    baseUrl: raw.providerConfig?.baseUrl || raw.baseUrl || undefined,
    model: raw.providerConfig?.model || raw.model || undefined,
    veniceKeyframeOnly: raw.providerConfig?.veniceKeyframeOnly !== false,
  };

  const interpolation = String(raw.interpolation || DEFAULTS.interpolation).toLowerCase();
  const interpolateFactor = Math.max(1, Math.min(8, Number(raw.interpolateFactor ?? raw.interpolate_factor ?? DEFAULTS.interpolateFactor) || 1));
  const width = Math.max(256, Number(raw.width) || DEFAULTS.width);
  const height = Math.max(256, Number(raw.height) || DEFAULTS.height);
  const fps = Math.max(1, Number(raw.fps) || DEFAULTS.fps);
  const format = String(raw.format || DEFAULTS.format).toLowerCase() === 'webm' ? 'webm' : 'mp4';

  return {
    ...raw,
    basePrompt,
    frameCount,
    seed,
    strength,
    promptDeltas,
    providerConfig,
    interpolation,
    interpolateFactor,
    width,
    height,
    fps,
    format,
    outputDir: raw.outputDir || raw.output_dir || DEFAULTS.outputDir,
    outputPath: raw.outputPath || raw.output_path || null,
    conditioning: raw.conditioning || null,
    onProgress: typeof raw.onProgress === 'function' ? raw.onProgress : () => {},
  };
}

export function composeFramePrompt(basePrompt, delta, frameIndex) {
  const d = String(delta || '').trim();
  if (!d || frameIndex === 0) {
    return d && frameIndex === 0 && !/keyframe/i.test(d)
      ? `${basePrompt}. ${d}`
      : basePrompt;
  }
  return `${basePrompt}. Motion beat: ${d}. Keep identity, composition, lighting, and style consistent with the previous frame.`;
}
