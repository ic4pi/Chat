/**
 * ComfyUI API-format workflow for Wan 2.2 TI2V 5B (text + image → video).
 * Native ComfyUI nodes — no WanVideoWrapper required.
 *
 * Models (on the RunPod / ComfyUI host):
 *   models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
 *   models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
 *   models/vae/wan2.2_vae.safetensors
 */

const DEFAULT_NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.negativePrompt]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} [opts.length] frame count (4n+1). 81 ≈ 3.3s @ 24fps
 * @param {number} [opts.steps]
 * @param {number} [opts.cfg]
 * @param {number} [opts.seed]
 * @param {number} [opts.fps]
 * @param {string|null} [opts.inputImageName] filename uploaded via RunPod input.images
 */
export function buildWan225bWorkflow({
  prompt,
  negativePrompt,
  width = 832,
  height = 480,
  length = 81,
  steps = 20,
  cfg = 5,
  seed = null,
  fps = 24,
  inputImageName = null,
} = {}) {
  const w = Math.max(320, Math.min(1280, Number(width) || 832));
  const h = Math.max(320, Math.min(1280, Number(height) || 480));
  // Wan length must be 4n+1
  let frames = Math.max(17, Math.min(121, Number(length) || 81));
  frames = Math.floor((frames - 1) / 4) * 4 + 1;
  const seedVal =
    Number.isFinite(Number(seed)) && Number(seed) >= 0
      ? Math.floor(Number(seed))
      : Math.floor(Math.random() * 1_000_000_000);

  const workflow = {
    '37': {
      class_type: 'UNETLoader',
      inputs: {
        unet_name: 'wan2.2_ti2v_5B_fp16.safetensors',
        weight_dtype: 'default',
      },
    },
    '38': {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
        type: 'wan',
        device: 'default',
      },
    },
    '39': {
      class_type: 'VAELoader',
      inputs: {
        vae_name: 'wan2.2_vae.safetensors',
      },
    },
    '48': {
      class_type: 'ModelSamplingSD3',
      inputs: {
        model: ['37', 0],
        shift: 8,
      },
    },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: String(prompt || ''),
        clip: ['38', 0],
      },
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: String(negativePrompt || DEFAULT_NEGATIVE),
        clip: ['38', 0],
      },
    },
    '55': {
      class_type: 'Wan22ImageToVideoLatent',
      inputs: {
        vae: ['39', 0],
        width: w,
        height: h,
        length: frames,
        batch_size: 1,
      },
    },
    '3': {
      class_type: 'KSampler',
      inputs: {
        model: ['48', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['55', 0],
        seed: seedVal,
        steps: Math.max(4, Math.min(40, Number(steps) || 20)),
        cfg: Number(cfg) || 5,
        sampler_name: 'uni_pc',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    '8': {
      class_type: 'VAEDecode',
      inputs: {
        samples: ['3', 0],
        vae: ['39', 0],
      },
    },
    '57': {
      class_type: 'CreateVideo',
      inputs: {
        images: ['8', 0],
        fps: Math.max(8, Math.min(30, Number(fps) || 24)),
      },
    },
    '58': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['57', 0],
        filename_prefix: 'wan22_5b',
        format: 'auto',
        codec: 'auto',
      },
    },
  };

  if (inputImageName) {
    workflow['56'] = {
      class_type: 'LoadImage',
      inputs: {
        image: inputImageName,
      },
    };
    workflow['55'].inputs.start_image = ['56', 0];
  }

  return workflow;
}

export function videoDimsFromSize(size) {
  const s = String(size || '832x480').replace('*', 'x');
  if (s === '480x832') return { width: 480, height: 832 };
  if (s === '1280x704' || s === '1280x720') return { width: 1280, height: 704 };
  if (s === '704x1280' || s === '720x1280') return { width: 704, height: 1280 };
  return { width: 832, height: 480 };
}

export function framesFromSeconds(seconds, fps = 24) {
  const secs = Math.min(5, Math.max(1, Number(seconds) || 3));
  let frames = Math.round(secs * fps);
  frames = Math.floor((frames - 1) / 4) * 4 + 1;
  return Math.max(17, Math.min(121, frames));
}
