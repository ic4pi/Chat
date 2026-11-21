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

export const VOICE_LIST = [
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
];
const ALLOWED_VOICES = new Set(VOICE_LIST);

const DEFAULT_VOICE = 'en-US-AvaNeural';
/** Soft ceiling per request — client chunks below this so full replies play. */
const MAX_CHARS = 2400;
/** Retry once on failure — Edge TTS occasionally drops the WebSocket. */
const MAX_ATTEMPTS = 1;
/** The library has no timeout of its own: a stalled WebSocket hangs until Vercel kills the
 * function (60s). Cut each attempt off so the client gets an error fast and can fall back. */
const ATTEMPT_TIMEOUT_MS = 7000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Edge TTS timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Groq (Orpheus) is fast and reachable from Vercel; Edge's WebSocket often stalls there.
 * Used first when GROQ_API_KEY is set. Input is capped at 200 chars per request, output is WAV. */
const GROQ_TTS_URL = 'https://api.groq.com/openai/v1/audio/speech';
const GROQ_MODEL = process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english';
const GROQ_MAX_CHARS = 200;
const GROQ_TIMEOUT_MS = 6000;
const GROQ_FEMALE = ['autumn', 'diana', 'hannah'];
const GROQ_MALE = ['austin', 'daniel', 'troy'];
const EDGE_MALE = /Andrew|Brian|Guy|Ryan|William/;

function groqVoiceFor(edgeVoice) {
  const idx = Math.max(0, VOICE_LIST.indexOf(edgeVoice));
  const pool = EDGE_MALE.test(edgeVoice) ? GROQ_MALE : GROQ_FEMALE;
  return pool[idx % pool.length];
}

async function synthesizeGroq(text, edgeVoice) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GROQ_TIMEOUT_MS);
  try {
    const r = await fetch(GROQ_TTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: GROQ_MODEL, input: text, voice: groqVoiceFor(edgeVoice), response_format: 'wav' }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      throw new Error(`Groq TTS HTTP ${r.status} ${detail}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('Groq TTS returned empty audio');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { text, voice: voiceIn, rate, pitch, engine } = req.body || {};
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

  // Live playback prefers Groq; MP3 export (engine: 'edge') needs MP3, which only Edge returns.
  if (engine !== 'edge' && process.env.GROQ_API_KEY && cleaned.length <= GROQ_MAX_CHARS) {
    try {
      const wav = await synthesizeGroq(cleaned, voice);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-TTS-Engine', 'groq');
      res.setHeader('Content-Length', String(wav.length));
      return res.status(200).send(wav);
    } catch (err) {
      console.error('tts groq failed, falling back to edge:', err.message);
    }
  }

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const tts = new UniversalEdgeTTS(cleaned, voice, {
        rate: rateOpt,
        pitch: pitchOpt,
        volume: '+0%',
      });
      const result = await withTimeout(tts.synthesize(), ATTEMPT_TIMEOUT_MS);
      if (!result?.audio) {
        throw new Error('TTS returned no audio data');
      }
      const buf = Buffer.from(await withTimeout(result.audio.arrayBuffer(), ATTEMPT_TIMEOUT_MS));
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
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  return res.status(502).json({
    error: (lastErr?.message) || 'Neural TTS failed after retries',
    hint: 'Edge TTS service may be temporarily unavailable. The client will retry.',
  });
}
