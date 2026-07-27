#!/usr/bin/env node
/**
 * CLI for lib/animate — frame-chain generation → interpolate → ffmpeg stitch.
 *
 * Usage:
 *   node scripts/animate-sequence.mjs --prompt "..." [--frames 12] [--seed 42] [--strength 0.2]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAnimatedSequence, DEFAULTS } from '../lib/animate/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function usage() {
  console.log(`Usage:
  node scripts/animate-sequence.mjs --prompt "scene..." [options]

Options:
  --prompt, -p       Base prompt (required)
  --frames           Keyframe count (default ${DEFAULTS.frameCount})
  --seed             Locked seed (default ${DEFAULTS.seed})
  --strength         Img2img denoise 0.15–0.3 (default ${DEFAULTS.strength})
  --provider         nvidia | venice (default nvidia)
  --model            Model id
  --base-url         Provider OpenAI-compatible base URL
  --deltas           Path to file with one motion delta per line
  --interp           ffmpeg | rife | film | none (default ffmpeg)
  --factor           Interpolation factor (default ${DEFAULTS.interpolateFactor})
  --width --height   Resolution (default ${DEFAULTS.width}x${DEFAULTS.height})
  --fps              Output fps before factor (default ${DEFAULTS.fps})
  --format           mp4 | webm
  --out              Output video path
  --venice-keyframe  Use Venice for frame 0 only (nvidia chain)
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }

  const prompt = args.prompt || args.p;
  if (!prompt) {
    usage();
    process.exit(1);
  }

  let promptDeltas;
  if (args.deltas) {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(path.resolve(args.deltas), 'utf8');
    promptDeltas = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  }

  const result = await generateAnimatedSequence({
    basePrompt: prompt,
    frameCount: args.frames ? Number(args.frames) : undefined,
    seed: args.seed != null ? Number(args.seed) : undefined,
    strength: args.strength != null ? Number(args.strength) : undefined,
    promptDeltas,
    providerConfig: {
      provider: args.provider || 'nvidia',
      model: args.model,
      baseUrl: args['base-url'],
      useVeniceKeyframe: Boolean(args['venice-keyframe']),
    },
    interpolation: args.interp || 'ffmpeg',
    interpolateFactor: args.factor ? Number(args.factor) : undefined,
    width: args.width ? Number(args.width) : undefined,
    height: args.height ? Number(args.height) : undefined,
    fps: args.fps ? Number(args.fps) : undefined,
    format: args.format,
    outputPath: args.out ? path.resolve(args.out) : path.resolve(__dirname, '../tmp/animate-out.mp4'),
    onProgress: (info) => {
      if (info.stage === 'generate') {
        process.stderr.write(`[generate] frame ${info.frame + 1}/${info.total} (${info.provider})\n`);
      } else if (info.stage === 'interpolate') {
        process.stderr.write(`[interpolate] ${info.method}${info.fallback ? ` → ${info.fallback}` : ''} frames=${info.output ?? '?'}\n`);
      } else if (info.stage === 'stitch') {
        process.stderr.write(`[stitch] ${info.frames} frames → ${info.outputPath}\n`);
      } else if (info.stage === 'done') {
        process.stderr.write(`[done] ${info.videoPath}\n`);
      }
    },
  });

  console.log(JSON.stringify({
    videoPath: result.videoPath,
    keyframes: result.keyframes.length,
    interpolated: result.interpolated.length,
    config: result.config,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
