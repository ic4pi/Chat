/**
 * Stitch a frame sequence into a video with ffmpeg.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * @param {string[]} framePaths  absolute paths, ordered
 * @param {{ outputPath: string, fps?: number, format?: 'mp4'|'webm', width?: number, height?: number, onProgress?: Function }} opts
 * @returns {Promise<{ outputPath: string, frameCount: number }>}
 */
export async function stitchFramesToVideo(framePaths, opts = {}) {
  if (!Array.isArray(framePaths) || framePaths.length === 0) {
    throw new Error('stitchFramesToVideo requires frame paths');
  }
  const fps = Math.max(1, Number(opts.fps) || 12);
  const format = String(opts.format || 'mp4').toLowerCase() === 'webm' ? 'webm' : 'mp4';
  const outputPath = opts.outputPath || path.join(path.dirname(framePaths[0]), `../output.${format}`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Stage into a contiguous %04d sequence for the image2 demuxer.
  const stageDir = path.join(path.dirname(outputPath), `_stitch_${Date.now()}`);
  await fs.mkdir(stageDir, { recursive: true });
  try {
    for (let i = 0; i < framePaths.length; i += 1) {
      const ext = path.extname(framePaths[i]) || '.png';
      await fs.copyFile(framePaths[i], path.join(stageDir, `f_${String(i + 1).padStart(4, '0')}${ext}`));
    }
    const firstExt = path.extname(framePaths[0]) || '.png';
    const pattern = path.join(stageDir, `f_%04d${firstExt}`);

    const vf = [];
    if (opts.width && opts.height) {
      vf.push(`scale=${opts.width}:${opts.height}:flags=lanczos`);
    }
    vf.push('format=yuv420p');

    const args = [
      '-y',
      '-framerate', String(fps),
      '-start_number', '1',
      '-i', pattern,
      '-vf', vf.join(','),
    ];

    if (format === 'webm') {
      args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-an', outputPath);
    } else {
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outputPath);
    }

    opts.onProgress?.({ stage: 'stitch', fps, format, frames: framePaths.length, outputPath });
    await run('ffmpeg', args);
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }

  return { outputPath, frameCount: framePaths.length };
}
