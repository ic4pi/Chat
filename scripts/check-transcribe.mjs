#!/usr/bin/env node
/** Audio → MIDI checks on synthetic audio with known tempo, drums and notes. */
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.window = {};
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(new URL('../public/music/transcribe.js', import.meta.url), 'utf8'));
const T = window.__transcribe;

const FS = 44100, BPM = 120, SECS = 16, beat = 60 / BPM, n = FS * SECS;
const x = new Float32Array(n);
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const add = (t, f) => { for (let i = Math.floor(t * FS); i < n; i++) { const v = f(i / FS - t); if (v === null) break; x[i] += v; } };
for (let b = 0; b < SECS / beat; b++) {
  const t = b * beat;
  add(t, (s) => (s > 0.25 ? null : 0.8 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-s * 30)) * s) * Math.exp(-s * 14)));                 // kick
  let h1 = 0, h2 = 0; add(t + beat / 2, (s) => { if (s > 0.04) return null; const r = rnd(), d = r - 2 * h1 + h2; h2 = h1; h1 = r; return 0.12 * d * Math.exp(-s * 80); });  // hat (high-passed noise)
  if (b % 2) add(t, (s) => (s > 0.15 ? null : 0.5 * rnd() * Math.exp(-s * 25)));                                                         // snare-ish noise
  const bass = [33, 33, 36, 31][Math.floor(b / 4) % 4];                                                                                    // bass note per beat
  add(t + beat / 2, (s) => (s > beat * 0.45 ? null : 0.35 * Math.sin(2 * Math.PI * 440 * Math.pow(2, (bass - 69) / 12) * s) * Math.min(1, s * 200)));
}
const mel = [69, 72, 76, 72, 69, 67, 72, 76];                                                                                               // melody, 1 note / beat from beat 0
mel.forEach((m, i) => add(i * beat * 2 + 0.01, (s) => (s > beat * 1.8 ? null : 0.3 * Math.sin(2 * Math.PI * 440 * Math.pow(2, (m - 69) / 12) * s) * Math.min(1, s * 150))));

const raw = T.transcribe(x, FS);
console.log('bpm', raw.bpm, 'drums', raw.drums.length, 'bass', raw.bass.length, 'melody', raw.melody.length);
const octFree = (b) => Math.min(Math.abs(b - BPM), Math.abs(b - BPM * 2), Math.abs(b - BPM / 2));
assert.ok(octFree(raw.bpm) < 3, `tempo ${raw.bpm}`);
const kicks = raw.drums.filter((d) => d.pitch === 36).length;
assert.ok(kicks >= 20 && kicks <= 40, `kick count ${kicks} (expected ~32)`);
const cnt = (p) => raw.drums.filter((d) => d.pitch === p).length;
assert.ok(cnt(42) >= 20, `hats ${cnt(42)}`);
assert.ok(cnt(38) >= 8 && cnt(38) <= 30, `snares ${cnt(38)} (expected ~16)`);
const melPitches = new Set(raw.melody.map((m) => m.pitch));
for (const p of [69, 72, 76]) assert.ok(melPitches.has(p), `melody should contain ${p}, got ${[...melPitches]}`);
const bassPitches = new Set(raw.bass.map((m) => m.pitch));
assert.ok(raw.bass.length >= 24 && raw.bass.length <= 40, `bass note count ${raw.bass.length} (expected ~32)`);
assert.ok(bassPitches.has(33), `bass should contain 33, got ${[...bassPitches]}`);

const song = T.buildSong(raw, 120, '16', 'x');
assert.ok(song.tracks.length >= 2 && song.tracks.every((t) => t.notes.length && t.notes.every((q) => q.tick >= 0 && q.dur >= 1)));
assert.ok(song.tracks.find((t) => t.mode === 'drums').notes.every((q) => q.tick % 120 === 0), 'drums snapped to 16ths');
console.log('check-transcribe: ok');
