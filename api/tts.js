/**
 * POST /api/tts
 * Body: { text: string, voice?: string, rate?: string, pitch?: string }
 *
 * Free neural TTS via Microsoft Edge online voices (no API key).
 * Returns audio/mpeg.
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
]);

const DEFAULT_VOICE = 'en-US-AvaNeural';
const MAX_CHARS = 2200;

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
    .trim()
    .slice(0, MAX_CHARS);

  if (!cleaned) {
    return res.status(400).json({ error: 'Nothing speakable after cleaning' });
  }

  const voice = ALLOWED_VOICES.has(voiceIn) ? voiceIn : DEFAULT_VOICE;
  const rateOpt = typeof rate === 'string' && /^[+-]?\d+%$/.test(rate) ? rate : '+0%';
  const pitchOpt = typeof pitch === 'string' && /^[+-]?\d+Hz$/.test(pitch) ? pitch : '+0Hz';

  try {
    const tts = new UniversalEdgeTTS(cleaned, voice, {
      rate: rateOpt,
      pitch: pitchOpt,
      volume: '+0%',
    });
    const result = await tts.synthesize();
    if (!result?.audio) {
      return res.status(502).json({ error: 'TTS returned no audio' });
    }
    const buf = Buffer.from(await result.audio.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Voice', voice);
    res.setHeader('Content-Length', String(buf.length));
    return res.status(200).send(buf);
  } catch (err) {
    console.error('tts error:', err);
    return res.status(502).json({
      error: err.message || 'Neural TTS failed',
      hint: 'Fall back to browser speech on the client.',
    });
  }
}
