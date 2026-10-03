/**
 * Turns a finished group-chat/standing-task transcript into one downloadable
 * MP3 — each speaker in a distinct voice, in speaking order. Built on the
 * same Edge TTS the app already uses for "Read aloud" (api/tts.js); this
 * just calls it per turn and joins the results.
 *
 * Concatenation is raw buffer-join after stripping ID3 tags, not a real
 * remux — MP3 frames are independently self-synced, so this plays correctly
 * in effectively every real-world player (browsers, phones, desktop apps)
 * even though it isn't a "proper" media-aware merge. If a specific player
 * ever chokes on it, the real fix is remuxing with ffmpeg in a sandbox, not
 * patching this function — flag it rather than guessing at a workaround.
 */

import { UniversalEdgeTTS } from 'edge-tts-universal';
import { VOICE_LIST } from '../api/tts.js';

const MAX_CHARS = 2400;

/** Same cleanup api/tts.js applies before synthesizing. */
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split on sentence boundaries, keeping each chunk under the TTS ceiling. */
function chunkText(text, maxChars = MAX_CHARS) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = '';
    }
    if (s.length > maxChars) {
      // A single sentence longer than the ceiling — hard-split it.
      for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars).trim());
      continue;
    }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

/** Same speaker always gets the same voice within one export, stable by first appearance. */
export function assignVoices(speakerNames) {
  const map = new Map();
  let i = 0;
  for (const name of speakerNames) {
    if (map.has(name)) continue;
    map.set(name, VOICE_LIST[i % VOICE_LIST.length]);
    i += 1;
  }
  return map;
}

/** Strip a leading ID3v2 tag and trailing ID3v1 tag so joined segments don't carry stray metadata mid-stream. */
function stripId3(buf) {
  let start = 0;
  let end = buf.length;
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const size =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    start = 10 + size;
  }
  if (end - start >= 128 && buf.toString('ascii', end - 128, end - 125) === 'TAG') {
    end -= 128;
  }
  return buf.subarray(start, end);
}

async function synthesizeChunk(text, voice) {
  const tts = new UniversalEdgeTTS(text, voice, { rate: '+0%', pitch: '+0Hz', volume: '+0%' });
  const result = await tts.synthesize();
  if (!result?.audio) throw new Error(`TTS returned no audio for voice ${voice}`);
  return Buffer.from(await result.audio.arrayBuffer());
}

/**
 * @param {{personaName: string, content: string}[]} turns
 * @returns {Promise<{audio: Buffer, voiceMap: Record<string,string>}>}
 */
export async function buildBoardroomMp3(turns) {
  const clean = (turns || [])
    .map((t) => ({ personaName: String(t.personaName || t.heading || 'Speaker'), content: cleanForSpeech(t.content ?? t.body ?? '') }))
    .filter((t) => t.content);
  if (!clean.length) throw new Error('Nothing speakable in this transcript.');

  const voices = assignVoices(clean.map((t) => t.personaName));
  const segments = [];

  for (const turn of clean) {
    const voice = voices.get(turn.personaName);
    for (const chunk of chunkText(turn.content)) {
      const buf = await synthesizeChunk(chunk, voice);
      segments.push(stripId3(buf));
    }
  }

  return {
    audio: Buffer.concat(segments),
    voiceMap: Object.fromEntries(voices),
  };
}
