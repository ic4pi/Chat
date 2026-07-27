# Frame-chain AI animation workflow

Generate a short animated clip by chaining text-to-image → image-to-image frames with incremental motion prompts, interpolating in-betweens, and stitching with ffmpeg.

## Pipeline (separable)

1. `generateFrameChain(config)` — locked-seed keyframe + img2img loop  
2. `interpolateFrames(paths, { method })` — `ffmpeg` | `rife` | `film` | `none`  
3. `stitchFramesToVideo(paths, opts)` — ffmpeg encode  
4. `generateAnimatedSequence(config)` — runs all three

## Quick start

```bash
# Env
export NVIDIA_API_KEY=...          # primary chain provider
# optional keyframe-only:
export VENICE_API_KEY=...

node scripts/animate-sequence.mjs \
  --prompt "a red robot waving in a sunlit workshop, cinematic lighting" \
  --frames 12 \
  --seed 42 \
  --strength 0.2 \
  --provider nvidia \
  --model black-forest-labs/flux.1-dev \
  --interp ffmpeg \
  --out ./out/robot-wave.mp4
```

## Config surface

| Field | Default | Notes |
|-------|---------|-------|
| `basePrompt` | required | Scene description |
| `frameCount` | `12` | Keyframes before interpolation |
| `seed` | `42` | Locked for every frame |
| `strength` | `0.2` | Denoise / img2img; clamped to **0.15–0.3** |
| `promptDeltas` | auto | Per-frame motion beats |
| `providerConfig.provider` | `nvidia` | `nvidia` \| `venice` |
| `providerConfig.model` | `black-forest-labs/flux.1-dev` | Venice default `flux-dev-uncensored` |
| `providerConfig.baseUrl` | NVIDIA integrate / Venice API | Swap for self-hosted NIM |
| `providerConfig.veniceKeyframeOnly` | `true` | See Venice note below |
| `interpolation` | `ffmpeg` | `ffmpeg` \| `rife` \| `film` \| `none` |
| `interpolateFactor` | `2` | Approx. multiply frame count |
| `width` / `height` | `1024` | Output resolution |
| `fps` / `format` | `12` / `mp4` | Stitch settings |
| `conditioning` | — | ControlNet hook (pose/depth/edge) |

## Venice verification (docs.venice.ai)

- Native `POST /api/v1/image/generate` accepts `style_references[{ image, strength }]` — **aesthetic style guidance**, not classic img2img denoise.
- OpenAI-compatible `POST /api/v1/images/generations` is **text-to-image only**.
- Edit API is for inpainting.

**Default:** Venice is used only for single keyframe (frame 0) generation. The chain loop uses NVIDIA. Set `veniceKeyframeOnly: false` only if you explicitly want experimental `style_references` chaining.

## ControlNet-ready hook

Pure img2img drifts after ~10–15 frames. Pass conditioning without rewriting the loop:

```js
await generateAnimatedSequence({
  basePrompt: '...',
  frameCount: 12,
  seed: 42,
  strength: 0.2,
  providerConfig: { provider: 'nvidia' },
  // Static:
  conditioning: { type: 'depth', image: depthMapBuffer, scale: 1 },
  // Or per-frame (recommended):
  conditioning: async (frameIndex, prevFrame) => ({
    type: 'pose',
    image: await renderPoseMap(frameIndex), // your future ControlNet map
    scale: 1,
  }),
});
```

NVIDIA hosted FLUX maps `canny` / `depth` / `edge` onto genai `mode`. Pose currently routes to depth until a pose NIM is wired — same request shape.

## Programmatic API

```js
import {
  generateAnimatedSequence,
  generateFrameChain,
  interpolateFrames,
  stitchFramesToVideo,
} from '../lib/animate/index.js';

const result = await generateAnimatedSequence({
  basePrompt: 'cat turning its head toward camera, soft window light',
  frameCount: 12,
  seed: 7,
  strength: 0.22,
  promptDeltas: [
    'looking left',
    'head turns 10%',
    'head turns 20%',
    // ...
  ],
  providerConfig: {
    provider: 'nvidia',
    model: 'black-forest-labs/flux.1-dev',
    // baseUrl: 'https://your-nim-host', // self-hosted OpenAI-compatible NIM
  },
  interpolation: 'rife', // falls back to ffmpeg if binary missing
  format: 'mp4',
});

console.log(result.videoPath);
```

## Interpolation backends

| Method | Requirement |
|--------|-------------|
| `ffmpeg` | `ffmpeg` on PATH (always used as fallback) |
| `rife` | `RIFE_BIN` or `rife-ncnn-vulkan` / `rife` |
| `film` | `FILM_BIN` or `film` |
| `none` | Skip; stitch keyframes only |

Register a custom backend:

```js
import { registerInterpolator } from '../lib/animate/index.js';
registerInterpolator('my-rife', async (framePaths, opts) => { /* return new paths */ });
```
