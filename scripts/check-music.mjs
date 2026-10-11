#!/usr/bin/env node
/** Round-trip + determinism checks for public/music/music.js (no browser needed). */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const stub = new Proxy(function () {}, { get: () => stub, set: () => true, apply: () => stub });
globalThis.document = { querySelector: () => stub, createElement: () => stub, body: { classList: { add() {} } } };
globalThis.window = {};
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(new URL('../public/music/music.js', import.meta.url), 'utf8'));
const m = window.__music;

const cfg = { timing: 12, velocity: 40, length: 20, swing: 58, swingGrid: 16, ghost: 50, pocket: 10, roll: 10, strum: 25 };
const song = m.demoSong();
const a = m.humanize(song, cfg, 3);
const b = m.humanize(song, cfg, 3);
assert.deepEqual(a.tracks[0].notes, b.tracks[0].notes, 'same seed must give same result');

const back = m.parseMidi(m.writeMidi(song, a.tracks).buffer);
const counts = back.tracks.filter((t) => t.notes.length).map((t) => t.notes.length);
assert.deepEqual(counts, a.tracks.map((t) => t.notes.length), 'export → parse keeps every note');
assert.equal(back.ppq, song.ppq);

const zero = m.humanize(song, { ...cfg, timing: 0, velocity: 0, length: 0, swing: 50, ghost: 0, pocket: 0, roll: 0, strum: 0 }, 1);
for (const t of zero.tracks) assert.ok(t.notes.every((n) => n.tick === n.o.tick && n.vel === n.o.vel), 'zero settings change nothing');
console.log('check-music: ok');
