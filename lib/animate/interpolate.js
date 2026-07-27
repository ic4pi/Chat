/**
 * Pluggable frame interpolation.
 *
 * Built-in backends:
 *   - ffmpeg  — always available via ffmpeg minterpolate (default)
 *   - rife    — shells out to `rife-ncnn-vulkan` or `rife` if installed
 *   - film    — shells out to a FILM CLI if `FILM_BIN` / `film` is available
 *   - none    — passthrough (keyframes only)
 *
 * Register custom backends with `registerInterpolator(name, fn)`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const registry = new Map();

/**
 * @typedef {Object} InterpolateOptions
 * @property {'ffmpeg'|'rife'|'film'|'none'|string} [method]
 * @property {number} [factor]  // multiply frame count roughly by this
 * @property {number} [fps]
 * @property {string} [outputDir]
 * @property {(info:object)=>void} [onProgress]
 */

/**
 * @param {string} name
 * @param {(framePaths:string[], opts:InterpolateOptions)=>Promise<string[]>} fn
 */
export function registerInterpolator(name, fn) {
  registry.set(String(name).toLowerCase(), fn);
}

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function which(bin) {
  try {
    const { stdout } = await run('sh', ['-c', `command -v ${bin}`]);
    const p = stdout.trim();
    return p || null;
  } catch {
    return null;
  }
}

async function listImages(dir) {
  const names = await fs.readdir(dir);
  return names
    .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

/** Passthrough — no interpolation. */
registerInterpolator('none', async (framePaths) => [...framePaths]);

/**
 * ffmpeg minterpolate — practical default when RIFE/FILM binaries are absent.
 * Writes an intermediate high-fps video then extracts frames.
 */
registerInterpolator('ffmpeg', async (framePaths, opts = {}) => {
  if (framePaths.length < 2) return [...framePaths];
  const factor = Math.max(2, Number(opts.factor) || 2);
  const inFps = Math.max(1, Number(opts.fps) || 12);
  const outFps = inFps * factor;
  const workDir = opts.outputDir || path.join(path.dirname(framePaths[0]), '..', 'interpolated');
  await fs.mkdir(workDir, { recursive: true });

  // Build concat-friendly numbered copies so image2 demuxer is happy.
  const staged = path.join(workDir, '_stage');
  await fs.rm(staged, { recursive: true, force: true });
  await fs.mkdir(staged, { recursive: true });
  for (let i = 0; i < framePaths.length; i += 1) {
    const ext = path.extname(framePaths[i]) || '.png';
    // image2 demuxer defaults to start_number=1; keep 1-based names.
    await fs.copyFile(framePaths[i], path.join(staged, `k_${String(i + 1).padStart(4, '0')}${ext}`));
  }

  const stagedFiles = await listImages(staged);
  const ext = path.extname(stagedFiles[0]) || '.png';
  const pattern = path.join(staged, `k_%04d${ext}`);
  const midVideo = path.join(workDir, '_interp.mp4');

  // mi_mode=mci motion-compensated interpolation
  await run('ffmpeg', [
    '-y',
    '-framerate', String(inFps),
    '-start_number', '1',
    '-i', pattern,
    '-vf', `minterpolate=fps=${outFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
    '-an',
    midVideo,
  ]);

  const outDir = path.join(workDir, 'frames');
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-i', midVideo,
    path.join(outDir, 'f_%04d.png'),
  ]);

  const out = await listImages(outDir);
  opts.onProgress?.({ stage: 'interpolate', method: 'ffmpeg', input: framePaths.length, output: out.length });
  return out;
});

/**
 * RIFE — expects `rife-ncnn-vulkan` or env RIFE_BIN.
 * Falls back to ffmpeg if binary missing.
 */
registerInterpolator('rife', async (framePaths, opts = {}) => {
  const bin = process.env.RIFE_BIN || (await which('rife-ncnn-vulkan')) || (await which('rife'));
  if (!bin) {
    opts.onProgress?.({ stage: 'interpolate', method: 'rife', fallback: 'ffmpeg', reason: 'RIFE binary not found' });
    return registry.get('ffmpeg')(framePaths, opts);
  }

  const workDir = opts.outputDir || path.join(path.dirname(framePaths[0]), '..', 'interpolated-rife');
  await fs.mkdir(workDir, { recursive: true });
  const inDir = path.join(workDir, 'in');
  const outDir = path.join(workDir, 'out');
  await fs.rm(inDir, { recursive: true, force: true });
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(inDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  for (let i = 0; i < framePaths.length; i += 1) {
    const ext = path.extname(framePaths[i]) || '.png';
    await fs.copyFile(framePaths[i], path.join(inDir, `${String(i).padStart(8, '0')}${ext}`));
  }

  // Common rife-ncnn-vulkan CLI: -i indir -o outdir -m rife-v4 -n factor
  const factor = Math.max(2, Number(opts.factor) || 2);
  try {
    await run(bin, ['-i', inDir, '-o', outDir, '-n', String(factor)]);
  } catch (err) {
    opts.onProgress?.({ stage: 'interpolate', method: 'rife', fallback: 'ffmpeg', reason: String(err.message || err) });
    return registry.get('ffmpeg')(framePaths, opts);
  }

  const out = await listImages(outDir);
  if (!out.length) {
    return registry.get('ffmpeg')(framePaths, opts);
  }
  opts.onProgress?.({ stage: 'interpolate', method: 'rife', input: framePaths.length, output: out.length });
  return out;
});

/**
 * FILM — expects FILM_BIN env or `film` on PATH.
 * Falls back to ffmpeg if unavailable.
 */
registerInterpolator('film', async (framePaths, opts = {}) => {
  const bin = process.env.FILM_BIN || (await which('film')) || (await which('frame-interpolation'));
  if (!bin) {
    opts.onProgress?.({ stage: 'interpolate', method: 'film', fallback: 'ffmpeg', reason: 'FILM binary not found' });
    return registry.get('ffmpeg')(framePaths, opts);
  }

  const workDir = opts.outputDir || path.join(path.dirname(framePaths[0]), '..', 'interpolated-film');
  await fs.mkdir(workDir, { recursive: true });
  const outDir = path.join(workDir, 'out');
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  try {
    // Generic convention: film --input <list or dir> --output <dir> --times <factor>
    await run(bin, [
      '--input', path.dirname(framePaths[0]),
      '--output', outDir,
      '--times', String(Math.max(2, Number(opts.factor) || 2)),
    ]);
  } catch (err) {
    opts.onProgress?.({ stage: 'interpolate', method: 'film', fallback: 'ffmpeg', reason: String(err.message || err) });
    return registry.get('ffmpeg')(framePaths, opts);
  }

  const out = await listImages(outDir);
  if (!out.length) return registry.get('ffmpeg')(framePaths, opts);
  opts.onProgress?.({ stage: 'interpolate', method: 'film', input: framePaths.length, output: out.length });
  return out;
});

/**
 * Interpolate keyframes with the selected backend.
 * @param {string[]} framePaths
 * @param {InterpolateOptions} opts
 * @returns {Promise<string[]>}
 */
export async function interpolateFrames(framePaths, opts = {}) {
  if (!Array.isArray(framePaths) || framePaths.length === 0) {
    throw new Error('interpolateFrames requires at least one frame path');
  }
  const method = String(opts.method || 'ffmpeg').toLowerCase();
  const fn = registry.get(method);
  if (!fn) {
    throw new Error(`Unknown interpolation method "${method}". Registered: ${[...registry.keys()].join(', ')}`);
  }
  return fn(framePaths, { ...opts, method });
}

export function listInterpolators() {
  return [...registry.keys()];
}

// Ensure this file is treated as a module with a stable path for tests.
export const __dirname = path.dirname(fileURLToPath(import.meta.url));
