/**
 * Lightweight voice chat helpers for Workspace (mic STT + neural TTS).
 * Mirrors main-chat behavior without pulling in the vanilla app.js state.
 */

const SPEAK_PREF_KEY = 'workspace_speak_replies_v1';
const VOICE_PREF_KEY = 'uncensored_tts_voice_v1';
const DEFAULT_VOICE = 'en-US-AndrewNeural';

let speakGeneration = 0;
let activeAudio: HTMLAudioElement | null = null;
let speakQueue: Promise<void> = Promise.resolve();

export function loadSpeakPref(): boolean {
  try {
    return localStorage.getItem(SPEAK_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSpeakPref(on: boolean): void {
  try {
    localStorage.setItem(SPEAK_PREF_KEY, on ? '1' : '0');
  } catch { /* ignore */ }
}

function preferredVoice(): string {
  try {
    return localStorage.getItem(VOICE_PREF_KEY) || DEFAULT_VOICE;
  } catch {
    return DEFAULT_VOICE;
  }
}

export function cleanForSpeech(text: string): string {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\bFile:\s+\S+/gi, ' ')
    .replace(/[#*_`>+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkSpeech(text: string, max = 1800): string[] {
  const clean = cleanForSpeech(text);
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf('? ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf('! ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function stopSpeech(): void {
  speakGeneration += 1;
  try {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = '';
      activeAudio = null;
    }
  } catch { /* ignore */ }
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

async function fetchNeuralAudio(text: string, voice: string): Promise<Blob> {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
  return res.blob();
}

function playBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      reject(new Error('Audio playback failed'));
    };
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        URL.revokeObjectURL(url);
        reject(err);
      });
    }
  });
}

function speakBrowserFallback(text: string): void {
  if (!window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const chunks = chunkSpeech(text, 1100);
    const voices = window.speechSynthesis.getVoices?.() || [];
    const en = voices.find(v => /en[-_]/i.test(v.lang) && /enhanced|premium|neural|samantha|google/i.test(v.name))
      || voices.find(v => /en[-_]/i.test(v.lang));
    for (const chunk of chunks) {
      const u = new SpeechSynthesisUtterance(chunk);
      u.rate = 1.02;
      if (en) u.voice = en;
      window.speechSynthesis.speak(u);
    }
  } catch { /* ignore */ }
}

/** Speak an assistant reply (skips code-heavy text). */
export async function speakReply(text: string, { force = false } = {}): Promise<void> {
  const chunks = chunkSpeech(text);
  if (!chunks.length) return;

  if (force) stopSpeech();
  const gen = speakGeneration;
  const voice = preferredVoice();

  speakQueue = speakQueue.then(async () => {
    if (gen !== speakGeneration) return;
    try {
      for (const chunk of chunks) {
        if (gen !== speakGeneration) return;
        const blob = await fetchNeuralAudio(chunk, voice);
        if (gen !== speakGeneration) return;
        await playBlob(blob);
      }
    } catch {
      if (gen === speakGeneration) speakBrowserFallback(chunks.join(' '));
    }
  });
  return speakQueue;
}

type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: {
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
  }) => void) | null;
  start: () => void;
  stop: () => void;
};

export function getSpeechRecognition(): SpeechRec | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}
