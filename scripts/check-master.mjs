#!/usr/bin/env node
/** DSP + mapping checks for public/music/master.js (no browser needed). */
import fs from 'node:fs';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(new URL('../public/music/master.js', import.meta.url), 'utf8'));
const M = window.__master;

// BS.1770: 997 Hz sine, same signal in both channels, amplitude 0.1 → -20.0 LUFS (K-weight gain cancels the -0.691 offset)
const fs48 = 48000, n = fs48 * 6, sine = new Float32Array(n).map((_, i) => 0.1 * Math.sin((2 * Math.PI * 997 * i) / fs48));
const a = M.analyze(sine, sine.slice(), fs48);
assert.ok(Math.abs(a.lufs - -20.0) < 0.2, `LUFS off: ${a.lufs}`);
assert.ok(Math.abs(a.peakDb - -20) < 0.1, `peak off: ${a.peakDb}`);
assert.equal(a.width, 0);
assert.ok(a.corr > 0.99);

// out-of-phase channels → width large, correlation negative
const inv = sine.map((v) => -v);
const w = M.analyze(sine, inv, fs48);
assert.ok(w.corr < -0.9 && w.width > 5, `phase test: ${w.corr}/${w.width}`);

// spectrum: a 100 Hz tone lands in the Bass band as the strongest
const lowTone = new Float32Array(n).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 100 * i) / fs48) + 0.001 * Math.sin(i));
const sp = M.analyze(lowTone, lowTone, fs48);
assert.equal(sp.bands.indexOf(Math.max(...sp.bands)), 1, 'bass band should peak');

// description mapping
let r = M.interpret('dark melodic techno, wide and punchy');
assert.deepEqual(r.genres, ['edm']);
assert.deepEqual(r.mods.map((m) => m.label).sort(), ['dark', 'punchy', 'wide']);
r = M.interpret('lo-fi hip hop beats to study to');
assert.deepEqual(r.genres.sort(), ['hiphop', 'lofi']);
assert.deepEqual(M.interpret('???').genres, []);

// plan stays inside sane limits
const T = M.targetFor(['edm'], M.interpret('loud aggressive').mods), P = M.makePlan(a, T);
assert.ok(Math.abs(P.eq.low) <= 5 && P.width >= 0.6 && P.width <= 1.6 && T.ratio <= 6);
assert.ok(M.teachSteps(a, T, P).length === 6);
console.log('check-master: ok');
