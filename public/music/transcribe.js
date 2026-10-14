/* Audio → MIDI for the Humanizer. In-browser, no model download.
   - Drums: spectral-flux onsets per band (kick / snare / hat)
   - Bass + melody: YIN pitch tracking on band-limited copies of the mix (monophonic lines)
   - Tempo: autocorrelation of the onset envelope, with beat-phase alignment
   Polyphonic chords are NOT transcribed. Best on beat loops, bass lines, and single melodies. */
(() => {
  'use strict';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  // ── filters / resampling ──
  function biquad(x, type, f, fs, q = 0.7071) {
    const w = (2 * Math.PI * f) / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    const a0 = 1 + al, a1 = (-2 * c) / a0, a2 = (1 - al) / a0;
    b0 /= a0; b1 /= a0; b2 /= a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  const lp2 = (x, f, fs) => biquad(biquad(x, 'lp', f, fs), 'lp', f, fs);
  const hp2 = (x, f, fs) => biquad(biquad(x, 'hp', f, fs), 'hp', f, fs);
  function decimate(x, n) {
    const out = new Float32Array(Math.floor(x.length / n));
    for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < n; k++) s += x[i * n + k]; out[i] = s / n; }
    return out;
  }

  // ── FFT ──
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  // ── onset flux per band ──
  const FS = 22050, FN = 1024, HOP = 256;
  const DRUM_BANDS = { kick: [[40, 140]], snareLo: [[180, 500]], snareHi: [[1800, 5000]], hat: [[7000, 11000]] };
  function bandFlux(x) {
    const frames = Math.max(0, Math.floor((x.length - FN) / HOP));
    const win = new Float64Array(FN); for (let i = 0; i < FN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FN - 1));
    const hz = FS / FN, re = new Float64Array(FN), im = new Float64Array(FN);
    const raw = Object.fromEntries(Object.keys(DRUM_BANDS).map((k) => [k, new Float32Array(frames)]));
    let prev = new Float64Array(FN / 2);
    for (let t = 0; t < frames; t++) {
      for (let i = 0; i < FN; i++) { re[i] = x[t * HOP + i] * win[i]; im[i] = 0; }
      fft(re, im);
      const mag = new Float64Array(FN / 2);
      for (let k = 1; k < FN / 2; k++) mag[k] = Math.log1p(40 * Math.hypot(re[k], im[k]) / FN * 8);
      for (const [name, ranges] of Object.entries(DRUM_BANDS)) {
        let f = 0;
        for (const [lo, hi] of ranges) for (let k = Math.max(1, Math.ceil(lo / hz)); k <= Math.floor(hi / hz); k++) f += Math.max(0, mag[k] - prev[k]);
        raw[name][t] = f;
      }
      prev = mag;
    }
    // A snare is noisy across low AND high regions; a tonal note or a kick lights up only one. Take the weaker of the two.
    const p90 = (a) => { const s = [...a].sort((u, v) => u - v); return s[Math.floor(s.length * 0.9)] || 1; };
    const lo = p90(raw.snareLo), hi = p90(raw.snareHi), snare = new Float32Array(frames);
    for (let t = 0; t < frames; t++) snare[t] = Math.min(raw.snareLo[t] / lo, raw.snareHi[t] / hi);
    return { kick: raw.kick, snare, hat: raw.hat };
  }
  function pickPeaks(env, minGapFrames, sens) {
    const n = env.length, peaks = [], w = Math.round(0.5 * FS / HOP);
    const sorted = [...env].sort((a, b) => a - b), p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
    if (p90 <= 0) return peaks;
    for (let t = 2; t < n - 2; t++) {
      const v = env[t];
      if (v < env[t - 1] || v < env[t + 1] || v < env[t - 2] || v < env[t + 2]) continue;
      let sum = 0, c = 0; for (let k = Math.max(0, t - w); k < Math.min(n, t + w); k++) { sum += env[k]; c++; }
      if (v < (sum / c) * 1.6 + sens * p90 * 0.18) continue;
      if (peaks.length && t - peaks[peaks.length - 1].t < minGapFrames) { if (v > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { t, v }; continue; }
      peaks.push({ t, v });
    }
    return peaks;
  }

  // ── tempo ──
  function estimateTempo(env) {
    const fps = FS / HOP;
    if (env.length < fps * 4) return { bpm: 120, phase: 0, conf: 0 };
    const mean = env.reduce((s, v) => s + v, 0) / env.length, e = env.map((v) => Math.max(0, v - mean));
    let best = { bpm: 120, score: -1 };
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const lag = (60 / bpm) * fps; let s = 0;
      for (const m of [1, 2, 4]) {
        const L = lag * m, i0 = Math.floor(L), fr = L - i0;
        let a = 0; for (let t = 0; t + i0 + 1 < e.length; t++) a += e[t] * (e[t + i0] * (1 - fr) + e[t + i0 + 1] * fr);
        s += a / m ** 0.3;
      }
      const prior = Math.exp(-0.5 * ((Math.log2(bpm / 120)) / 0.6) ** 2); // gentle preference for 85–170
      s *= 0.6 + 0.4 * prior;
      if (s > best.score) best = { bpm, score: s };
    }
    const beat = (60 / best.bpm) * fps;
    let bestPh = 0, bestV = -1;
    for (let ph = 0; ph < beat; ph += 0.5) { let v = 0; for (let t = ph; t < e.length - 1; t += beat) v += e[Math.round(t)]; if (v > bestV) { bestV = v; bestPh = ph; } }
    return { bpm: +best.bpm.toFixed(1), phase: bestPh / fps, conf: best.score };
  }

  // ── YIN ──
  function yin(x, start, W, tauMin, tauMax, fs, thr) {
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) { let s = 0; for (let i = 0; i < W; i++) { const df = x[start + i] - x[start + i + tau]; s += df * df; } d[tau] = s; }
    let run = 0; const cm = new Float32Array(tauMax + 1); cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run ? (d[tau] * tau) / run : 1; }
    let tau = tauMin;
    while (tau < tauMax) { if (cm[tau] < thr) { while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++; break; } tau++; }
    if (tau >= tauMax || cm[tau] >= thr) return { f: 0, c: 1 };
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a + c - 2 * b;
    const t2 = den ? tau + (a - c) / (2 * den) : tau;
    return { f: fs / t2, c: cm[tau] };
  }
  function trackPitch(x, fs, fLo, fHi, W, hopSec, minRms) {
    const hop = Math.round(hopSec * fs), tauMin = Math.floor(fs / fHi), tauMax = Math.ceil(fs / fLo);
    const n = Math.floor((x.length - W - tauMax) / hop), midi = new Float32Array(Math.max(0, n)), rms = new Float32Array(Math.max(0, n));
    for (let t = 0; t < n; t++) {
      const s = t * hop; let e = 0; for (let i = 0; i < W; i++) e += x[s + i] * x[s + i]; rms[t] = Math.sqrt(e / W);
      if (rms[t] < minRms) { midi[t] = 0; continue; }
      const r = yin(x, s, W, tauMin, tauMax, fs, 0.15);
      midi[t] = r.f ? 69 + 12 * Math.log2(r.f / 440) : 0;
    }
    return { midi, rms, hopSec };
  }
  function segmentNotes(p, lo, hi, minFrames) {
    const { midi, rms, hopSec } = p, n = midi.length, sm = new Float32Array(n);
    for (let t = 0; t < n; t++) { const w = []; for (let k = -2; k <= 2; k++) if (midi[t + k] > 0) w.push(midi[t + k]); sm[t] = w.length >= 3 ? Math.round(median(w)) : 0; }
    const notes = [], maxRms = [...rms].sort((a, b) => a - b)[Math.floor(n * 0.95)] || 1;
    let t = 0;
    while (t < n) {
      if (!sm[t]) { t++; continue; }
      const pitch = sm[t]; let e = t; while (e + 1 < n && sm[e + 1] === pitch) e++;
      // bridge ≤2-frame gaps of the same pitch
      while (e + 3 < n && !sm[e + 1] && (sm[e + 2] === pitch || sm[e + 3] === pitch)) { e += sm[e + 2] === pitch ? 2 : 3; while (e + 1 < n && sm[e + 1] === pitch) e++; }
      if (e - t + 1 >= minFrames && pitch >= lo && pitch <= hi) {
        let m = 0; for (let k = t; k <= e; k++) m = Math.max(m, rms[k]);
        notes.push({ t0: t * hopSec, t1: (e + 1) * hopSec, pitch, vel: Math.round(clamp(45 + (m / maxRms) * 70, 30, 120)) });
      }
      t = e + 1;
    }
    return notes;
  }

  // ── public: transcribe raw audio (mono Float32Array at any rate) ──
  function transcribe(mono, fs) {
    const ratio = Math.max(1, Math.round(fs / FS));
    let x22 = ratio > 1 ? decimate(lp2(mono, FS * 0.45, fs), ratio) : Float32Array.from(mono);
    const fs22 = fs / ratio;
    if (Math.abs(fs22 - FS) > 2000) throw new Error(`Unsupported sample rate ${fs}`);
    let peak = 0; for (const v of x22) peak = Math.max(peak, Math.abs(v));
    if (peak < 1e-4) throw new Error('That file is silent');
    x22 = x22.map((v) => v / peak);

    const flux = bandFlux(x22);
    const total = new Float32Array(flux.kick.length); for (let i = 0; i < total.length; i++) total[i] = flux.kick[i] * 0.8 + flux.snare[i] + flux.hat[i] * 0.6;
    const tempo = estimateTempo(total);

    // bass: ≤300 Hz, decimate ×4 → 5.5 kHz
    const bassSig = decimate(lp2(x22, 300, FS), 4), bFs = FS / 4;
    const bass = segmentNotes(trackPitch(bassSig, bFs, 35, 300, 512, 0.02, 0.03), 28, 55, 5);

    const drums = [];
    for (const [name, pitch, gap, sens] of [['kick', 36, 7, 1], ['snare', 38, 7, 3], ['hat', 42, 4, 1]]) {
      let peaks = pickPeaks(flux[name], gap, sens);
      if (peaks.length < 3) continue;
      if (name === 'kick' && bass.length) {
        // Bass-note attacks also light up the kick band. Keep a kick that lands on a bass attack only if it is
        // clearly stronger than the kicks that stand alone (kick + bass together hit harder than bass alone).
        const near = (p) => bass.some((b) => Math.abs((p.t * HOP + FN / 2) / FS - b.t0) < 0.05);
        const alone = peaks.filter((p) => !near(p)).map((p) => p.v);
        if (alone.length >= 3) { const m = median(alone); peaks = peaks.filter((p) => !near(p) || p.v > m * 1.3); }
      }
      if (name === 'snare') {
        // A kick or a hat also has some broadband energy; call it a snare only when neither one clearly dominates that frame.
        const p90 = (a) => { const q = [...a].sort((u, v) => u - v); return q[Math.floor(q.length * 0.9)] || 1; };
        const kN = p90(flux.kick), hN = p90(flux.hat), at = (a, t) => Math.max(a[t - 1] || 0, a[t] || 0, a[t + 1] || 0);
        peaks = peaks.filter((p) => at(flux.kick, p.t) / kN < p.v * 1.2 && at(flux.hat, p.t) / hN < p.v * 2);
        if (peaks.length < 3) continue;
      }
      const mx = Math.max(...peaks.map((p) => p.v));
      for (const p of peaks) drums.push({ t0: (p.t * HOP + FN / 2) / FS, t1: (p.t * HOP + FN / 2) / FS + 0.06, pitch, vel: Math.round(clamp(55 + (p.v / mx) * 65, 40, 122)) });
    }
    drums.sort((a, b) => a.t0 - b.t0);
    // melody: 200–2000 Hz
    const melSig = lp2(hp2(x22, 200, FS), 2000, FS);
    const melody = segmentNotes(trackPitch(melSig, FS, 180, 1500, 1024, 0.02, 0.03), 52, 96, 3);
    return { drums, bass, melody, bpm: tempo.bpm, phase: tempo.phase, seconds: mono.length / fs };
  }

  // ── build a song (ticks) from a transcription ──
  function buildSong(raw, bpm, snap, name) {
    const ppq = 480, beat = 60 / bpm, grid = snap === 'off' ? 0 : snap === '8' ? ppq / 2 : ppq / 4;
    const sec2tick = (t) => ((t - raw.phase + beat) / beat) * ppq;
    const mk = (title, mode, ch, list) => {
      const notes = list.map((n) => {
        let a = Math.max(0, sec2tick(n.t0)), b = Math.max(a + 1, sec2tick(n.t1));
        if (grid) { a = Math.round(a / grid) * grid; b = Math.max(a + grid, Math.round(b / grid) * grid); if (mode === 'drums') b = a + Math.round(ppq / 8); }
        return { tick: Math.round(a), dur: Math.max(1, Math.round(b - a)), pitch: n.pitch, vel: n.vel, ch };
      });
      // collapse duplicates created by snapping (same pitch, same tick)
      const seen = new Map();
      for (const n of notes) { const k = n.pitch + '@' + n.tick; if (!seen.has(k) || seen.get(k).vel < n.vel) seen.set(k, n); }
      const out = [...seen.values()].sort((x, y) => x.tick - y.tick || x.pitch - y.pitch);
      // monophonic lines: trim overlap
      if (mode !== 'drums') for (let i = 0; i < out.length - 1; i++) if (out[i].tick + out[i].dur > out[i + 1].tick) out[i].dur = Math.max(1, out[i + 1].tick - out[i].tick);
      return { name: title, notes: out, others: [], metas: [], mode };
    };
    const tracks = [mk('Drums (detected)', 'drums', 9, raw.drums), mk('Bass (detected)', 'bass', 1, raw.bass), mk('Melody (detected)', 'piano', 0, raw.melody)].filter((t) => t.notes.length);
    return { ppq, tempos: [{ tick: 0, uspq: Math.round(60000000 / bpm) }], tracks, name };
  }

  window.__transcribe = { transcribe, buildSong, estimateTempo, yin };
})();
