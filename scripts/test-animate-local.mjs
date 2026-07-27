#!/usr/bin/env node
/**
 * Offline smoke test: interpolation + stitch (no API keys).
 * Generates solid-color PNGs as fake keyframes, interpolates, stitches.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { interpolateFrames, stitchFramesToVideo, normalizeAnimateConfig, clampStrength, defaultPromptDeltas } from '../lib/animate/index.js';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `${cmd} ${code}`))));
  });
}

async function makeKeyframe(dir, i, color) {
  const p = path.join(dir, `frame_${String(i).padStart(4, '0')}.png`);
  // ffmpeg color source → png
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=256x256:d=1`, '-frames:v', '1', p]);
  return p;
}

async function main() {
  // unit-ish checks
  if (clampStrength(0.05) !== 0.15) throw new Error('clamp low failed');
  if (clampStrength(0.9) !== 0.3) throw new Error('clamp high failed');
  if (clampStrength(0.22) !== 0.22) throw new Error('clamp mid failed');
  const deltas = defaultPromptDeltas(4, 'arm raised');
  if (deltas.length !== 4) throw new Error('deltas length');

  const cfg = normalizeAnimateConfig({
    basePrompt: 'test robot',
    frameCount: 4,
    seed: 1,
    strength: 0.2,
    promptDeltas: ['a', 'b', 'c', 'd'],
  });
  if (cfg.frameCount !== 4) throw new Error('normalize failed');

  const work = path.join(os.tmpdir(), `animate-smoke-${Date.now()}`);
  const keyDir = path.join(work, 'keyframes');
  await fs.mkdir(keyDir, { recursive: true });

  const colors = ['#224466', '#335577', '#446688', '#557799'];
  const keys = [];
  for (let i = 0; i < colors.length; i += 1) keys.push(await makeKeyframe(keyDir, i, colors[i]));

  const interpolated = await interpolateFrames(keys, {
    method: 'ffmpeg',
    factor: 2,
    fps: 6,
    outputDir: path.join(work, 'interpolated'),
  });
  if (interpolated.length < keys.length) throw new Error(`expected more frames, got ${interpolated.length}`);

  const out = path.join(work, 'out.mp4');
  const stitch = await stitchFramesToVideo(interpolated, {
    outputPath: out,
    fps: 12,
    format: 'mp4',
  });
  const st = await fs.stat(stitch.outputPath);
  if (st.size < 1000) throw new Error('video too small');

  console.log(JSON.stringify({
    ok: true,
    keyframes: keys.length,
    interpolated: interpolated.length,
    videoPath: stitch.outputPath,
    bytes: st.size,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
