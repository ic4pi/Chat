/**
 * POST /api/animate-sequence
 *
 * Runs the frame-chain animation workflow and returns JSON metadata.
 * On Vercel, ffmpeg may be unavailable and long multi-frame jobs can hit
 * duration limits — prefer the local CLI (`scripts/animate-sequence.mjs`)
 * for full sequences. This endpoint is useful for short dry-runs or
 * environments that bundle ffmpeg.
 *
 * Body: {
 *   basePrompt, frameCount?, seed?, strength?,
 *   promptDeltas?, provider?, model?, baseUrl?,
 *   interpolation?, interpolateFactor?,
 *   width?, height?, fps?, format?
 * }
 *
 * Env: NVIDIA_API_KEY (chain), optional VENICE_API_KEY (keyframe)
 */

import { generateAnimatedSequence } from '../lib/animate/index.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const workDir = path.join(os.tmpdir(), `animate-api-${Date.now()}`);
    const format = body.format === 'webm' ? 'webm' : 'mp4';

    const result = await generateAnimatedSequence({
      basePrompt: body.basePrompt || body.prompt,
      frameCount: body.frameCount,
      seed: body.seed,
      strength: body.strength,
      promptDeltas: body.promptDeltas || body.deltas,
      motionHint: body.motionHint,
      providerConfig: {
        provider: body.provider || body.providerConfig?.provider || 'nvidia',
        model: body.model || body.providerConfig?.model,
        baseUrl: body.baseUrl || body.providerConfig?.baseUrl,
        apiKey: body.apiKey || body.providerConfig?.apiKey,
        veniceKeyframeOnly: body.veniceKeyframeOnly !== false,
        useVeniceKeyframe: Boolean(body.useVeniceKeyframe),
      },
      interpolation: body.interpolation || 'ffmpeg',
      interpolateFactor: body.interpolateFactor,
      width: body.width,
      height: body.height,
      fps: body.fps,
      format,
      outputDir: workDir,
      outputPath: path.join(workDir, `sequence.${format}`),
      conditioning: body.conditioning || null,
    });

    const videoBuf = await fs.readFile(result.videoPath);
    const mime = format === 'webm' ? 'video/webm' : 'video/mp4';

    if (body.return === 'binary' || body.returnBinary) {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `inline; filename="sequence.${format}"`);
      return res.status(200).end(videoBuf);
    }

    return res.status(200).json({
      ok: true,
      video: {
        mimeType: mime,
        base64: videoBuf.toString('base64'),
      },
      keyframes: result.keyframes.map(({ index, prompt, mode, provider, model }) => ({
        index, prompt, mode, provider, model,
      })),
      interpolatedCount: result.interpolated.length,
      config: result.config,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || String(err),
      code: err.code || undefined,
    });
  }
}
