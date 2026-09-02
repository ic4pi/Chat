/**
 * POST /api/tts
 * Body: { text: string, voice?: string, rate?: string, pitch?: string }
 *
 * Free neural TTS via Microsoft Edge online voices (no API key).
 * Returns audio/mpeg.
 *
 * Client is expected to chunk long replies (~1800 chars). We still enforce a
 * hard ceiling so a single request cannot overwhelm Edge TTS.
 */

import { UniversalEdgeTTS } from 'edge-tts-universal';

const ALLOWED_VOICES = new Set([
  'en-US-AvaNeural',
  'en-US-AndrewNeural',
  'en-US-EmmaMultilingualNeural',
  'en-US-BrianMultilingualNeural',
  'en-US-JennyNeural',
  'en-US-GuyNeural',
  'en-GB-SoniaNeural',
  'en-GB-RyanNeural',
  'en-AU-NatashaNeural',
  'en-AU-WilliamNeural',
  'en-US-AriaNeural',
]);

const DEFAULT_VOICE = 'en-US-AvaNeural';
/** Soft ceiling per request — client chunks below this so full replies play. */
const MAX_CHARS = 2400;
/** Retry once on failure — Edge TTS occasionally drops the WebSocket. */
const MAX_ATTEMPTS = 2;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { text, voice: voiceIn, rate, pitch } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return res.status(400).json({ error: 'Nothing speakable after cleaning' });
  }

  if (cleaned.length > MAX_CHARS) {
    return res.status(400).json({
      error: `Text too long for one TTS request (${cleaned.length} > ${MAX_CHARS}). Send smaller chunks.`,
    });
  }

  const voice = ALLOWED_VOICES.has(voiceIn) ? voiceIn : DEFAULT_VOICE;
  const rateOpt = typeof rate === 'string' && /^[+-]?\d+%$/.test(rate) ? rate : '+0%';
  const pitchOpt = typeof pitch === 'string' && /^[+-]?\d+Hz$/.test(pitch) ? pitch : '+0Hz';

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const tts = new UniversalEdgeTTS(cleaned, voice, {
        rate: rateOpt,
        pitch: pitchOpt,
        volume: '+0%',
      });
      // Edge TTS's websocket occasionally hangs instead of erroring. Without
      // a timeout here, this attempt (and the retry loop) just sits until
      // Vercel's own hard function timeout kills it with no clean error —
      // that's why voice would play the first sentence then silently stop.
      const result = await Promise.race([
        tts.synthesize(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Edge TTS synthesis timed out after 10s')), 10000),
        ),
      ]);
      if (!result?.audio) {
        throw new Error('TTS returned no audio data');
      }
      const buf = Buffer.from(await result.audio.arrayBuffer());
      if (!buf.length) {
        throw new Error('TTS returned an empty audio buffer');
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-TTS-Voice', voice);
      res.setHeader('Content-Length', String(buf.length));
      return res.status(200).send(buf);
    } catch (err) {
      lastErr = err;
      console.error(`tts attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err.message);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  return res.status(502).json({
    error: (lastErr?.message) || 'Neural TTS failed after retries',
    hint: 'Edge TTS service may be temporarily unavailable. The client will retry.',
  });
}
