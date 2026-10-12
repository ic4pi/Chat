/* Music — Genre Mastering Coach.
   Analysis (FFT, BS.1770 loudness, stereo) runs in plain JS; the chain renders offline with Web Audio.
   Genre mapping is rule-based. The optional AI coach (/api/assist mode "master-explain") only explains
   numbers this page measured. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ───────────────────────── DSP: loudness ─────────────────────────
  function biquad(x, c) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const [b0, b1, b2] = c.b, [, a1, a2] = c.a;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const v = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  function kWeight(x, fs) {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const s1 = { b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] };
    const f1 = 38.13547087602444, Q1 = 0.5003270373238773;
    K = Math.tan((Math.PI * f1) / fs); a0 = 1 + K / Q1 + K * K;
    const s2 = { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0] };
    return biquad(biquad(x, s1), s2);
  }
  function cumSq(x) {
    const c = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) c[i + 1] = c[i] + x[i] * x[i];
    return c;
  }
  function blockLoudness(cs, fs, lenSec, hopSec) {
    const n = cs[0].length - 1, len = Math.round(lenSec * fs), hop = Math.round(hopSec * fs), out = [];
    for (let s = 0; s + len <= n; s += hop) {
      let z = 0;
      for (const c of cs) z += (c[s + len] - c[s]) / len;
      out.push(z);
    }
    return out;
  }
  const lufsOf = (z) => -0.691 + 10 * Math.log10(Math.max(z, 1e-12));
  function integrated(z, relGate) {
    const abs = z.filter((v) => lufsOf(v) > -70);
    if (!abs.length) return { lufs: -70, kept: [] };
    const rel = lufsOf(abs.reduce((s, v) => s + v, 0) / abs.length) + relGate;
    const kept = abs.filter((v) => lufsOf(v) > rel);
    return { lufs: lufsOf(kept.reduce((s, v) => s + v, 0) / Math.max(1, kept.length)), kept };
  }
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };

  // ───────────────────────── DSP: spectrum ─────────────────────────
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
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  const BANDS = [
    { id: 'sub', name: 'Sub', lo: 20, hi: 60 },
    { id: 'bass', name: 'Bass', lo: 60, hi: 250 },
    { id: 'lowmid', name: 'Low-mids', lo: 250, hi: 500 },
    { id: 'mid', name: 'Mids', lo: 500, hi: 2000 },
    { id: 'upmid', name: 'Upper-mids', lo: 2000, hi: 4000 },
    { id: 'pres', name: 'Presence', lo: 4000, hi: 8000 },
    { id: 'air', name: 'Air', lo: 8000, hi: 16000 },
  ];
  const N = 4096;
  function avgSpectrum(mono, fs) {
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const frames = Math.max(1, Math.min(300, Math.floor(mono.length / N)));
    const step = Math.max(N, Math.floor((mono.length - N) / frames));
    const p = new Float64Array(N / 2);
    let used = 0;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let s = 0; s + N <= mono.length && used < frames; s += step) {
      for (let i = 0; i < N; i++) { re[i] = mono[s + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) p[k] += re[k] * re[k] + im[k] * im[k];
      used++;
    }
    const hz = fs / N;
    // per-octave band energy in dB, normalised so the Mids band = 0
    const raw = BANDS.map((b) => {
      let e = 0;
      for (let k = Math.max(1, Math.ceil(b.lo / hz)); k <= Math.min(N / 2 - 1, Math.floor(b.hi / hz)); k++) e += p[k];
      return 10 * Math.log10(Math.max(e / Math.log2(b.hi / b.lo), 1e-30));
    });
    const ref = raw[3];
    const bands = raw.map((v) => v - ref);
    // fine curve (1/6 octave smoothing)
    const curve = [];
    for (let f = 25; f <= 18000; f *= Math.pow(2, 1 / 6)) {
      const lo = f / Math.pow(2, 1 / 12), hi = f * Math.pow(2, 1 / 12);
      let e = 0;
      for (let k = Math.max(1, Math.ceil(lo / hz)); k <= Math.min(N / 2 - 1, Math.floor(hi / hz)); k++) e += p[k];
      curve.push({ f, v: 10 * Math.log10(Math.max(e, 1e-30)) });
    }
    const m = curve.filter((c) => c.f >= 500 && c.f <= 2000);
    const off = m.reduce((s, c) => s + c.v, 0) / Math.max(1, m.length);
    return { bands, curve: curve.map((c) => ({ f: c.f, v: c.v - off })) };
  }

  // ───────────────────────── DSP: whole-file analysis ─────────────────────────
  function analyze(L, R, fs) {
    const n = L.length;
    const mono = R === L;
    let peak = 0, sumSq = 0, sqM = 0, sqS = 0, cLR = 0, cLL = 0, cRR = 0;
    const mid = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sumSq += (l * l + r * r) / 2;
      const m = (l + r) / 2, s = (l - r) / 2;
      mid[i] = m; sqM += m * m; sqS += s * s;
      cLR += l * r; cLL += l * l; cRR += r * r;
    }
    const kL = kWeight(L, fs), kR = mono ? kL : kWeight(R, fs);
    const cs = mono ? [cumSq(kL), cumSq(kL)] : [cumSq(kL), cumSq(kR)];
    const ig = integrated(blockLoudness(cs, fs, 0.4, 0.1), -10);
    const st = integrated(blockLoudness(cs, fs, 3, 1), -20);
    const stL = blockLoudness(cs, fs, 3, 1).filter((v) => lufsOf(v) > -70).map(lufsOf);
    const lra = stL.length > 3 ? pct(stL, 0.95) - pct(stL, 0.1) : 0;
    // low-end correlation (<~200 Hz) with two 1-pole lowpasses
    const lp = (x) => { const a = Math.exp((-2 * Math.PI * 200) / fs); const y = new Float32Array(x.length); let s1 = 0, s2 = 0; for (let i = 0; i < x.length; i++) { s1 = (1 - a) * x[i] + a * s1; s2 = (1 - a) * s1 + a * s2; y[i] = s2; } return y; };
    let lowCorr = 1;
    if (!mono) {
      const a = lp(L), b = lp(R);
      let xy = 0, xx = 0, yy = 0;
      for (let i = 0; i < n; i++) { xy += a[i] * b[i]; xx += a[i] * a[i]; yy += b[i] * b[i]; }
      lowCorr = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 1;
    }
    const spec = avgSpectrum(mid, fs);
    const rmsDb = db(Math.sqrt(sumSq / n));
    return {
      lufs: +ig.lufs.toFixed(1), peakDb: +db(peak).toFixed(1), rmsDb: +rmsDb.toFixed(1), crest: +(db(peak) - rmsDb).toFixed(1),
      plr: +(db(peak) - ig.lufs).toFixed(1), lra: +lra.toFixed(1), width: mono ? 0 : +(Math.sqrt(sqS / Math.max(sqM, 1e-12))).toFixed(2),
      corr: mono ? 1 : +(cLR / Math.sqrt(Math.max(cLL * cRR, 1e-12))).toFixed(2), lowCorr: +lowCorr.toFixed(2), bands: spec.bands.map((v) => +v.toFixed(1)), curve: spec.curve,
      shortTerm: +st.lufs.toFixed(1), seconds: +(n / fs).toFixed(1),
    };
  }

  // ───────────────────────── Genre profiles ─────────────────────────
  // bands: dB per octave relative to Mids (sub,bass,lowmid,mid,upmid,pres,air). Starting points, not laws.
  const GENRES = {
    pop: { name: 'Pop', bands: [-3, 4, 1, 0, -2, -5, -10], lufs: -10, width: 0.45, ratio: 2.5, att: 30, rel: 150, sat: 0.25, kw: ['pop', 'radio', 'mainstream', 'synthpop', 'k-pop'] },
    hiphop: { name: 'Hip-hop / Trap', bands: [3, 6, 0, 0, -3, -6, -11], lufs: -9, width: 0.35, ratio: 3, att: 20, rel: 120, sat: 0.35, kw: ['hip hop', 'hip-hop', 'hiphop', 'trap', 'rap', 'drill', 'boom bap', '808'] },
    edm: { name: 'EDM / Techno', bands: [2, 6, -1, 0, -2, -4, -8], lufs: -8, width: 0.55, ratio: 3.5, att: 10, rel: 100, sat: 0.35, kw: ['edm', 'techno', 'house', 'trance', 'dubstep', 'dnb', 'drum and bass', 'electro', 'club', 'dance', 'rave'] },
    rock: { name: 'Rock / Indie', bands: [-6, 3, 2, 0, -1, -4, -10], lufs: -9, width: 0.5, ratio: 3, att: 25, rel: 180, sat: 0.4, kw: ['rock', 'indie', 'punk', 'grunge', 'alternative', 'band'] },
    metal: { name: 'Metal', bands: [-6, 2, 1, 0, 0, -3, -9], lufs: -8, width: 0.4, ratio: 4, att: 8, rel: 90, sat: 0.5, kw: ['metal', 'hardcore', 'djent', 'thrash'] },
    jazz: { name: 'Jazz', bands: [-9, 2, 1, 0, -3, -7, -13], lufs: -16, width: 0.4, ratio: 1.6, att: 40, rel: 250, sat: 0.1, kw: ['jazz', 'swing', 'bebop', 'bossa'] },
    lofi: { name: 'Lo-fi / Chill', bands: [-5, 3, 2, 0, -5, -10, -18], lufs: -14, width: 0.3, ratio: 2, att: 30, rel: 200, sat: 0.5, kw: ['lo-fi', 'lofi', 'lo fi', 'chill', 'vinyl', 'tape', 'study'] },
    orch: { name: 'Orchestral / Cinematic', bands: [-8, 1, 1, 0, -2, -5, -10], lufs: -20, width: 0.6, ratio: 1.4, att: 60, rel: 400, sat: 0, kw: ['orchestral', 'cinematic', 'classical', 'film score', 'symphon', 'trailer', 'score'] },
    folk: { name: 'Folk / Acoustic', bands: [-9, 1, 2, 0, -2, -5, -11], lufs: -15, width: 0.45, ratio: 1.8, att: 40, rel: 250, sat: 0.1, kw: ['folk', 'acoustic', 'singer-songwriter', 'country', 'bluegrass'] },
    rnb: { name: 'R&B / Soul', bands: [0, 5, 1, 0, -3, -6, -11], lufs: -11, width: 0.4, ratio: 2.2, att: 30, rel: 180, sat: 0.25, kw: ['r&b', 'rnb', 'soul', 'neo-soul', 'neo soul', 'funk'] },
  };
  // description modifiers → deltas on the blended target
  const MODS = [
    { kw: ['punch', 'snappy', 'tight'], label: 'punchy', att: 1.8, ratio: -0.2, bands: [0, 1, 0, 0, 0.5, 1, 0] },
    { kw: ['warm', 'analog', 'smooth', 'vintage'], label: 'warm', sat: 0.15, bands: [0, 1, 1.5, 0, 0, -1, -2] },
    { kw: ['bright', 'crisp', 'airy', 'sparkl', 'shimmer'], label: 'bright', bands: [0, 0, 0, 0, 1, 1.5, 3] },
    { kw: ['dark', 'mellow', 'dull', 'muted'], label: 'dark', bands: [0, 0, 0.5, 0, -1.5, -2.5, -4] },
    { kw: ['wide', 'huge', 'spacious', 'immersive'], label: 'wide', width: 0.15 },
    { kw: ['narrow', 'mono', 'focused'], label: 'narrow', width: -0.15 },
    { kw: ['loud', 'hot', 'in your face', 'competitive'], label: 'loud', lufs: 2, ratio: 0.5 },
    { kw: ['quiet', 'dynamic', 'gentle', 'natural', 'delicate'], label: 'dynamic', lufs: -3, ratio: -0.5 },
    { kw: ['aggressive', 'gritty', 'dirty', 'distort'], label: 'aggressive', sat: 0.2, ratio: 0.5, att: 0.6 },
    { kw: ['clean', 'clear', 'transparent', 'polished'], label: 'clean', sat: -0.15, bands: [0, 0, -1.5, 0, 0.5, 0.5, 0.5] },
    { kw: ['bass heavy', 'heavy bass', 'sub', 'boomy', 'low end', 'low-end', 'thump'], label: 'bass-heavy', bands: [2, 2, 0, 0, 0, 0, 0] },
    { kw: ['muddy'], label: 'fix mud', bands: [0, 0, -2.5, 0, 0, 0, 0] },
  ];
  function interpret(text) {
    const t = ' ' + String(text || '').toLowerCase() + ' ';
    const score = Object.entries(GENRES).map(([id, g]) => ({ id, s: g.kw.reduce((a, k) => a + (t.includes(k) ? 1 : 0), 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const mods = MODS.filter((m) => m.kw.some((k) => t.includes(k)));
    return { genres: score.slice(0, 2).map((x) => x.id), mods };
  }
  function targetFor(ids, mods) {
    const list = ids.length ? ids : ['pop'];
    const w = list.length === 2 ? [0.62, 0.38] : [1];
    const T = { bands: new Array(7).fill(0), lufs: 0, width: 0, ratio: 0, att: 0, rel: 0, sat: 0 };
    list.forEach((id, i) => {
      const g = GENRES[id];
      g.bands.forEach((v, k) => (T.bands[k] += v * w[i]));
      for (const k of ['lufs', 'width', 'ratio', 'att', 'rel', 'sat']) T[k] += g[k] * w[i];
    });
    for (const m of mods) {
      if (m.bands) m.bands.forEach((v, k) => (T.bands[k] += v));
      if (m.lufs) T.lufs += m.lufs;
      if (m.width) T.width += m.width;
      if (m.ratio) T.ratio += m.ratio;
      if (m.sat) T.sat += m.sat;
      if (m.att) T.att *= m.att;
    }
    T.ratio = clamp(T.ratio, 1.2, 6); T.sat = clamp(T.sat, 0, 0.8); T.width = clamp(T.width, 0.1, 0.9); T.att = clamp(T.att, 3, 90);
    T.label = list.map((id) => GENRES[id].name).join(' + ');
    return T;
  }

  // ───────────────────────── Plan (analysis × target) ─────────────────────────
  function makePlan(a, T) {
    const diff = T.bands.map((t, i) => t - a.bands[i]);
    const g = (i, s = 0.7, lim = 5) => +clamp(diff[i] * s, -lim, lim).toFixed(1);
    const subRumble = a.bands[0] > T.bands[0] + 6;
    return {
      hpf: subRumble ? 32 : 24,
      eq: { low: +clamp((diff[0] * 0.4 + diff[1] * 0.6) * 0.7, -5, 5).toFixed(1), lowmid: g(2, 0.8, 4), pres: +clamp((diff[4] * 0.5 + diff[5] * 0.5) * 0.7, -5, 5).toFixed(1), air: g(6, 0.7, 5) },
      comp: { ratio: +T.ratio.toFixed(1), att: Math.round(T.att), rel: Math.round(T.rel), amount: 0.6 },
      sat: +T.sat.toFixed(2),
      width: +clamp(T.width / Math.max(a.width, 0.08), 0.6, 1.6).toFixed(2),
      bassMono: 150,
      lufs: +T.lufs.toFixed(1),
      ceiling: -1.0,
    };
  }

  // ───────────────────────── Offline mastering chain ─────────────────────────
  function stereoize(buf) {
    const L = buf.getChannelData(0);
    return { L, R: buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, fs: buf.sampleRate, n: buf.length };
  }
  function toBuffer(ctx, L, R, fs) {
    const b = ctx.createBuffer(2, L.length, fs);
    b.copyToChannel(L, 0); b.copyToChannel(R, 1);
    return b;
  }
  function buildChain(ctx, buf, P, lastStage, lufsIn) {
    const src = ctx.createBufferSource(); src.buffer = buf;
    let node = src;
    const on = (i) => i <= lastStage;
    const biq = (type, f, q, gain) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; if (gain !== undefined) b.gain.value = gain; return b; };
    const chain = (n) => { node.connect(n); node = n; return n; };

    if (on(1)) { chain(biq('highpass', P.hpf, 0.707)); }
    if (on(2)) {
      for (const [type, f, q, gn] of [['lowshelf', 110, 0.7, P.eq.low], ['peaking', 320, 0.9, P.eq.lowmid], ['peaking', 3200, 0.8, P.eq.pres], ['highshelf', 10000, 0.7, P.eq.air]]) {
        if (Math.abs(gn) >= 0.2) chain(biq(type, f, q, gn));
      }
    }
    if (on(3)) {
      const X1 = 200, X2 = 4000, sum = ctx.createGain();
      const lr4 = (type, f, from) => { const a = biq(type, f, 0.7071), b = biq(type, f, 0.7071); from.connect(a); a.connect(b); return b; };
      const comp = (att, rel, thrOff, ratio) => { const c = ctx.createDynamicsCompressor(); c.threshold.value = clamp(lufsIn + thrOff, -60, -3); c.knee.value = 6; c.ratio.value = ratio; c.attack.value = att / 1000; c.release.value = rel / 1000; return c; };
      const r = 1 + (P.comp.ratio - 1) * P.comp.amount;
      const tail = ctx.createGain(); node.connect(tail);
      const lo = lr4('lowpass', X1, tail), mid = lr4('lowpass', X2, lr4('highpass', X1, tail)), hi = lr4('highpass', X2, tail);
      for (const [from, c] of [[lo, comp(P.comp.att * 1.6, P.comp.rel * 0.8, 3, r)], [mid, comp(P.comp.att, P.comp.rel, 2, r)], [hi, comp(P.comp.att * 0.5, P.comp.rel * 0.9, 1, r * 0.8)]]) { from.connect(c); c.connect(sum); }
      node = sum;
    }
    if (on(4) && P.sat > 0.01) {
      const ws = ctx.createWaveShaper(), k = 1 + P.sat * 6, curve = new Float32Array(4097);
      for (let i = 0; i < curve.length; i++) { const x = (i / 2048) - 1; curve[i] = Math.tanh(x * k) / Math.tanh(k); }
      ws.curve = curve; ws.oversample = '4x';
      const dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain();
      dry.gain.value = 1 - P.sat * 0.6; wet.gain.value = P.sat * 0.6;
      const pre = ctx.createGain(); pre.gain.value = 0.9;
      node.connect(dry); node.connect(pre); pre.connect(ws); ws.connect(wet); dry.connect(out); wet.connect(out); node = out;
    }
    if (on(5)) {
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      node.connect(sp);
      const mid = ctx.createGain(), side = ctx.createGain(), inv = ctx.createGain(), sideInv = ctx.createGain();
      mid.gain.value = 0.5; side.gain.value = 0.5; inv.gain.value = -1; sideInv.gain.value = -1;
      sp.connect(mid, 0); sp.connect(mid, 1);
      sp.connect(side, 0); sp.connect(inv, 1); inv.connect(side);
      const h1 = biq('highpass', P.bassMono, 0.7071), h2 = biq('highpass', P.bassMono, 0.7071), wg = ctx.createGain();
      wg.gain.value = P.width;
      side.connect(h1); h1.connect(h2); h2.connect(wg);
      mid.connect(mg, 0, 0); wg.connect(mg, 0, 0);
      mid.connect(mg, 0, 1); wg.connect(sideInv); sideInv.connect(mg, 0, 1);
      node = mg;
    }
    if (on(6)) {
      const mk = ctx.createGain(); mk.gain.value = Math.pow(10, P.makeupDb / 20); chain(mk);
      const lim = ctx.createDynamicsCompressor(); lim.threshold.value = P.ceiling - 5; lim.knee.value = 1; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.09; chain(lim);
      const ws = ctx.createWaveShaper(), c = Math.pow(10, P.ceiling / 20), curve = new Float32Array(8193);
      for (let i = 0; i < curve.length; i++) { const x = (i / 4096) - 1; curve[i] = clamp(x, -c, c); }
      ws.curve = curve; chain(ws);
    }
    node.connect(ctx.destination);
    return src;
  }

  async function render(buf, P, lastStage, lufsIn) {
    const off = new OfflineAudioContext(2, buf.length, buf.sampleRate);
    const src = buildChain(off, buf, P, lastStage, lufsIn);
    src.start(0);
    return off.startRendering();
  }

  // 2–3 passes: land on the target loudness through the limiter
  async function masterFull(buf, P, lufsIn) {
    const p = { ...P, makeupDb: 0 };
    let out = await render(buf, p, 6, lufsIn), s = stereoize(out), m = analyze(s.L, s.R, s.fs);
    for (let pass = 0; pass < 2; pass++) {
      const err = P.lufs - m.lufs;
      if (Math.abs(err) < 0.4) break;
      p.makeupDb = clamp(p.makeupDb + err * (pass ? 0.9 : 1), -8, 16);
      out = await render(buf, p, 6, lufsIn); s = stereoize(out); m = analyze(s.L, s.R, s.fs);
    }
    return { buffer: out, analysis: m, makeupDb: +p.makeupDb.toFixed(1) };
  }

  // ───────────────────────── WAV export ─────────────────────────
  function wavBytes(buf) {
    const n = buf.length, ch = 2, data = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const w = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, buf.sampleRate, true); data.setUint32(28, buf.sampleRate * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); w(36, 'data'); data.setUint32(40, n * ch * 2, true);
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    let o = 44;
    for (let i = 0; i < n; i++) for (const x of [L[i], R[i]]) { data.setInt16(o, Math.round(clamp(x, -1, 1) * 32767), true); o += 2; }
    return new Uint8Array(data.buffer);
  }

  // ───────────────────────── Reports & teaching text ─────────────────────────
  const fmt = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
  function reportLines(a, T) {
    const out = [];
    const lufsD = a.lufs - T.lufs;
    out.push(`Loudness is ${a.lufs} LUFS; ${T.label} usually sits near ${T.lufs.toFixed(0)} LUFS, so it is ${Math.abs(lufsD) < 1 ? 'about right' : Math.abs(lufsD).toFixed(1) + ' dB ' + (lufsD < 0 ? 'quieter' : 'louder') + ' than that'}.`);
    out.push(`Peaks reach ${a.peakDb} dBFS and the peak-to-loudness ratio is ${a.plr} dB${a.plr > 14 ? ' — lots of dynamic headroom to work with' : a.plr < 8 ? ' — already heavily compressed' : ''}.`);
    BANDS.forEach((b, i) => {
      const d = a.bands[i] - T.bands[i];
      if (Math.abs(d) >= 2.5) out.push(`${b.name} (${b.lo >= 1000 ? b.lo / 1000 + 'k' : b.lo}–${b.hi >= 1000 ? b.hi / 1000 + 'k' : b.hi} Hz) is ${Math.abs(d).toFixed(1)} dB ${d > 0 ? 'above' : 'below'} the ${T.label} target.`);
    });
    if (a.width > 0 && Math.abs(a.width - T.width) > 0.12) out.push(`Stereo width (side/mid) is ${a.width}; target is about ${T.width.toFixed(2)}.`);
    if (a.lowCorr < 0.85) out.push(`Low end below 200 Hz is only ${a.lowCorr} correlated between left and right — it may collapse on mono systems. The chain will mono the bass.`);
    return out;
  }
  function teachSteps(a, T, P) {
    return [
      { stage: 1, title: 'High-pass cleanup', params: `${P.hpf} Hz, 12 dB/oct`, why: `Anything below ~${P.hpf} Hz is inaudible rumble that eats headroom and makes the limiter work harder. Removing it frees roughly a dB of loudness for free.` },
      { stage: 2, title: 'Corrective EQ', params: `Low shelf ${fmt(P.eq.low)} dB @110 Hz · Low-mid ${fmt(P.eq.lowmid)} dB @320 Hz · Presence ${fmt(P.eq.pres)} dB @3.2 kHz · Air shelf ${fmt(P.eq.air)} dB @10 kHz`, why: `I compared your spectrum to the ${T.label} target band by band and moved only 70% of each gap — mastering EQ should be gentle. Low-mid cuts clear mud, presence boosts help clarity, the air shelf sets brightness.` },
      { stage: 3, title: '3-band compression', params: `Crossovers 200 Hz / 4 kHz · ratio ${(1 + (P.comp.ratio - 1) * P.comp.amount).toFixed(1)}:1 · attack ${P.comp.att} ms (low ×1.6, high ×0.5) · release ${P.comp.rel} ms`, why: `Splitting by frequency lets the bass be controlled without squashing the highs. Slower attack on the lows keeps kick punch; faster on the highs tames harshness. A gentle ratio glues the mix instead of flattening it.` },
      { stage: 4, title: 'Saturation (parallel)', params: `Drive ${Math.round(P.sat * 100)}%, blended with the dry signal`, why: `Soft clipping adds harmonics that make a mix sound louder and warmer than its meter says. Blending it in parallel keeps transients intact.` },
      { stage: 5, title: 'Stereo width + mono bass', params: `Side level ×${P.width} · side signal high-passed at ${P.bassMono} Hz`, why: `Mid/side processing: widen or narrow the "side" (what differs between left and right) toward the genre's width, and keep everything under ${P.bassMono} Hz centered so the low end stays solid on club systems and phones.` },
      { stage: 6, title: 'Gain + limiter', params: `Makeup to ${P.lufs} LUFS, ceiling ${P.ceiling} dBFS`, why: `The limiter stops peaks from clipping, which lets the whole track be turned up to the genre's loudness. Loudness is matched in A/B so you hear the tone difference, not just "louder is better".` },
    ];
  }
  function recipeText(a, T, P, mastered) {
    const s = teachSteps(a, T, P);
    return [`MASTERING RECIPE — ${T.label}`, `Measured before: ${a.lufs} LUFS, peak ${a.peakDb} dBFS, width ${a.width}, low-end corr ${a.lowCorr}`,
      mastered ? `Result: ${mastered.lufs} LUFS, peak ${mastered.peakDb} dBFS, width ${mastered.width}` : '', '',
      ...s.map((x, i) => `${i + 1}. ${x.title}\n   Settings: ${x.params}\n   Why: ${x.why}`), '', 'Use any plugin with equivalent controls; order matters: HPF → EQ → multiband comp → saturation → M/S → limiter.'].filter((l) => l !== undefined).join('\n');
  }

  // ───────────────────────── Demo audio ─────────────────────────
  async function demoBuffer() {
    const fs = 44100, secs = 16, off = new OfflineAudioContext(2, fs * secs, fs), bpm = 124, beat = 60 / bpm;
    const master = off.createGain(); master.gain.value = 0.12; master.connect(off.destination);
    const nb = off.createBuffer(1, fs, fs); const nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const env = (g, t, a, d, peak) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
    for (let b = 0; b < secs / beat; b++) {
      const t = b * beat;
      const k = off.createOscillator(), kg = off.createGain(); k.frequency.setValueAtTime(140, t); k.frequency.exponentialRampToValueAtTime(48, t + 0.12); env(kg, t, 0.003, 0.28, 1); k.connect(kg); kg.connect(master); k.start(t); k.stop(t + 0.4);
      for (const h of [0.5]) { const s = off.createBufferSource(); s.buffer = nb; const f = off.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6500; const g = off.createGain(); env(g, t + h * beat, 0.002, 0.04, 0.35); s.connect(f); f.connect(g); g.connect(master); s.start(t + h * beat); s.stop(t + h * beat + 0.1); }
      if (b % 2 === 1) { const s = off.createBufferSource(); s.buffer = nb; const f = off.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1700; const g = off.createGain(); env(g, t, 0.002, 0.15, 0.6); s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + 0.25); }
      const root = [55, 55, 49, 58.27][Math.floor(b / 8) % 4];
      const bo = off.createOscillator(), bg = off.createGain(), bf = off.createBiquadFilter(); bo.type = 'sawtooth'; bo.frequency.value = root; bf.type = 'lowpass'; bf.frequency.value = 500; env(bg, t + beat / 2, 0.01, beat * 0.45, 0.7); bo.connect(bf); bf.connect(bg); bg.connect(master); bo.start(t + beat / 2); bo.stop(t + beat);
    }
    // narrow, muddy pad
    for (const f of [220, 261.6, 329.6]) for (const det of [-6, 6]) { const o = off.createOscillator(), g = off.createGain(), pan = off.createStereoPanner(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det; pan.pan.value = det / 40; const lp = off.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; g.gain.value = 0.16; o.connect(lp); lp.connect(g); g.connect(pan); pan.connect(master); o.start(0); o.stop(secs); }
    return off.startRendering();
  }

  window.__master = { analyze, interpret, targetFor, makePlan, kWeight, cumSq, blockLoudness, integrated, lufsOf, fft, GENRES, BANDS, reportLines, teachSteps, recipeText };
  if (typeof document === 'undefined' || !document.getElementById || !document.getElementById('file')) return;

  // ───────────────────────── UI ─────────────────────────
  const els = Object.fromEntries(['file', 'drop', 'demo', 'status', 'desc', 'genre', 'go', 'detect', 'meters', 'spec', 'report', 'plan', 'player', 'srcSel', 'play', 'stop', 'teach', 'coach', 'coachOut', 'dlwav', 'dlrecipe', 'cmp', 'cmpBtn', 'cmpA', 'cmpB', 'cmpC', 'pos'].map((k) => [k, document.getElementById(k)]));
  const S = { buf: null, name: '', a: null, T: null, P: null, plan0: null, outs: new Map(), master: null, ctx: null, node: null, playing: null, off: 0, started: 0, cache: new Map(), gen: 0 };
  const say = (m, err) => { els.status.textContent = m; els.status.className = err ? 'err' : ''; };

  els.genre.innerHTML = '<option value="">Auto (from description)</option>' + Object.entries(GENRES).map(([k, g]) => `<option value="${k}">${g.name}</option>`).join('');
  for (const sel of [els.cmpA, els.cmpB, els.cmpC]) sel.innerHTML = Object.entries(GENRES).map(([k, g]) => `<option value="${k}">${g.name}</option>`).join('');
  els.cmpA.value = 'edm'; els.cmpB.value = 'jazz'; els.cmpC.value = 'lofi';

  async function loadBuffer(arr, name) {
    stopPlay();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(arr);
    ctx.close();
    if (decoded.duration > 360) throw new Error('Files over 6 minutes are not supported yet');
    const s = stereoize(decoded);
    S.buf = toBuffer(new OfflineAudioContext(2, 1, s.fs), s.L, s.R, s.fs);
    S.name = name; S.outs = new Map(); S.master = null; S.cache = new Map();
    document.body.classList.add('loaded');
    say(`Loaded ${name} — ${decoded.duration.toFixed(1)} s, ${decoded.numberOfChannels} ch, ${s.fs} Hz. Describe your music, then press Analyze & Master.`);
  }
  els.file.onchange = async () => { const f = els.file.files[0]; if (!f) return; try { await loadBuffer(await f.arrayBuffer(), f.name); } catch (e) { say('Could not read that file: ' + e.message, true); } };
  els.drop.onclick = () => els.file.click();
  els.drop.ondragover = (e) => { e.preventDefault(); els.drop.classList.add('over'); };
  els.drop.ondragleave = () => els.drop.classList.remove('over');
  els.drop.ondrop = async (e) => { e.preventDefault(); els.drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (!f) return; try { await loadBuffer(await f.arrayBuffer(), f.name); } catch (er) { say('Could not read that file: ' + er.message, true); } };
  els.demo.onclick = async () => { say('Generating demo…'); const b = await demoBuffer(); const s = stereoize(b); S.buf = b; S.name = 'Demo track (muddy, narrow, quiet)'; S.outs = new Map(); S.master = null; S.cache = new Map(); document.body.classList.add('loaded'); els.desc.value = els.desc.value || 'punchy melodic techno, wide and clean'; say(`Demo ready (${(s.n / s.fs).toFixed(0)} s).`); };

  // plan knobs: [path, label, min, max, step, unit]
  const KNOBS = [['hpf', 'High-pass', 15, 60, 1, 'Hz'], ['eq.low', 'Low shelf @110Hz', -6, 6, 0.1, 'dB'], ['eq.lowmid', 'Low-mid @320Hz', -6, 6, 0.1, 'dB'], ['eq.pres', 'Presence @3.2k', -6, 6, 0.1, 'dB'], ['eq.air', 'Air shelf @10k', -6, 6, 0.1, 'dB'], ['comp.ratio', 'Comp ratio', 1, 6, 0.1, ':1'], ['comp.amount', 'Comp amount', 0, 1, 0.05, ''], ['comp.att', 'Attack', 3, 90, 1, 'ms'], ['comp.rel', 'Release', 40, 500, 5, 'ms'], ['sat', 'Saturation', 0, 0.8, 0.01, ''], ['width', 'Stereo width ×', 0.4, 1.8, 0.02, ''], ['bassMono', 'Mono below', 60, 300, 5, 'Hz'], ['lufs', 'Target loudness', -24, -5, 0.5, 'LUFS']];
  const getP = (P, path) => path.split('.').reduce((o, k) => o[k], P);
  const setP = (P, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], P)[last] = v; };

  function renderPlanUI() {
    els.plan.innerHTML = '';
    for (const [path, label, min, max, step, unit] of KNOBS) {
      const w = document.createElement('label'); w.className = 'sl';
      const ai = getP(S.plan0, path);
      w.innerHTML = `<span>${label} <em>AI: ${ai}${unit}</em></span><input type="range" min="${min}" max="${max}" step="${step}"><output></output>`;
      const inp = w.querySelector('input'), out = w.querySelector('output');
      inp.value = getP(S.P, path); out.textContent = inp.value + unit;
      inp.oninput = () => { setP(S.P, path, +inp.value); out.textContent = inp.value + unit; S.cache = new Map(); S.dirty = true; els.go.textContent = 'Re-render master'; };
      els.plan.appendChild(w);
    }
  }

  function meterHTML(a, tag) {
    const m = [['Loudness', a.lufs + ' LUFS'], ['Peak', a.peakDb + ' dBFS'], ['PLR', a.plr + ' dB'], ['Loudness range', a.lra + ' LU'], ['Width (S/M)', a.width], ['Low-end corr', a.lowCorr]];
    return `<div class="mrow"><b>${tag}</b>${m.map(([k, v]) => `<span class="mt"><i>${k}</i>${v}</span>`).join('')}</div>`;
  }

  function drawSpec() {
    const c = els.spec, dpr = window.devicePixelRatio || 1, W = c.clientWidth || 700, H = 230;
    c.width = W * dpr; c.height = H * dpr; c.style.height = H + 'px';
    const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const x = (f) => 36 + ((Math.log(f) - Math.log(20)) / (Math.log(20000) - Math.log(20))) * (W - 46);
    const y = (v) => 10 + (1 - (clamp(v, -30, 15) + 30) / 45) * (H - 28);
    g.font = '11px Inter, sans-serif'; g.fillStyle = '#8b95a9'; g.strokeStyle = 'rgba(255,255,255,.08)';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.beginPath(); g.moveTo(x(f), 10); g.lineTo(x(f), H - 18); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x(f) - 8, H - 4); }
    for (const v of [-24, -12, 0]) { g.beginPath(); g.moveTo(36, y(v)); g.lineTo(W - 10, y(v)); g.stroke(); g.fillText(v + 'dB', 2, y(v) + 4); }
    const line = (pts, col, wd, dash) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(x(p.f), y(p.v)) : g.moveTo(x(p.f), y(p.v)))); g.strokeStyle = col; g.lineWidth = wd; g.setLineDash(dash || []); g.stroke(); g.setLineDash([]); };
    // target: per-octave band centres → convert to the same "density" curve space (per-octave energy ≈ density×f)
    const centre = BANDS.map((b, i) => ({ f: Math.sqrt(b.lo * b.hi), v: S.T.bands[i] }));
    const dens = (pts) => pts.map((p) => ({ f: p.f, v: p.v + 10 * Math.log10(p.f / 1000) }));
    line(dens(S.a.curve), '#7C9CFF', 2);
    if (S.master) line(dens(S.master.analysis.curve), '#5DE2B3', 2);
    line(centre.map((p) => ({ f: p.f, v: p.v })), '#FFB86B', 1.5, [5, 4]);
    g.fillStyle = '#7C9CFF'; g.fillText('Original', 44, 22); g.fillStyle = '#5DE2B3'; g.fillText('Mastered', 104, 22); g.fillStyle = '#FFB86B'; g.fillText('Genre target', 170, 22);
  }
  window.addEventListener('resize', () => { if (S.a) drawSpec(); });

  function renderAnalysis() {
    els.meters.innerHTML = meterHTML(S.a, 'Original') + (S.master ? meterHTML(S.master.analysis, 'Mastered') : '');
    els.report.innerHTML = '';
    const ul = document.createElement('ul'); for (const l of reportLines(S.a, S.T)) { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); } els.report.appendChild(ul);
    drawSpec();
  }

  function renderTeach() {
    els.teach.innerHTML = '';
    teachSteps(S.a, S.T, S.P).forEach((st, i) => {
      const d = document.createElement('div'); d.className = 'step';
      d.innerHTML = `<div class="sh"><b></b><span class="sp"></span></div><p></p><div class="row"><button class="btn" data-w="a">Hear without</button><button class="btn primary" data-w="b">Hear with</button></div>`;
      d.querySelector('b').textContent = `${i + 1}. ${st.title}`; d.querySelector('.sp').textContent = st.params; d.querySelector('p').textContent = st.why;
      d.querySelectorAll('button').forEach((b) => (b.onclick = () => playStage(st.stage, b.dataset.w === 'b')));
      els.teach.appendChild(d);
    });
  }

  async function stageBuffer(stage) {
    const key = 's' + stage;
    if (S.cache.has(key)) return S.cache.get(key);
    const b = stage === 0 ? S.buf : stage === 6 ? S.master.buffer : await render(S.buf, { ...S.P, makeupDb: 0 }, stage, S.a.lufs);
    S.cache.set(key, b); return b;
  }
  // level-match any buffer to the original's loudness (peak-safe) for fair A/B
  const gainCache = new WeakMap();
  function matchGain(buf) {
    if (gainCache.has(buf)) return gainCache.get(buf);
    const s = stereoize(buf), a = analyze(s.L, s.R, s.fs), ref = S.a.lufs;
    const gdb = clamp(ref - a.lufs, -24, 24), peakLim = -a.peakDb;
    const g = Math.pow(10, Math.min(gdb, peakLim - 0.5) / 20);
    gainCache.set(buf, g); return g;
  }
  async function playStage(stage, withIt) {
    if (!S.master) { say('Run Analyze & Master first.', true); return; }
    say('Rendering that step…');
    const b = await stageBuffer(withIt ? stage : stage - 1);
    say(`Playing ${withIt ? 'WITH' : 'WITHOUT'} step ${stage} (level-matched).`);
    startPlay(b, 0);
  }

  function stopPlay() {
    if (S.node) { try { S.node.stop(); } catch {} S.node = null; }
    if (S.ctx) { S.ctx.close().catch(() => {}); S.ctx = null; }
    S.playing = null; els.play.classList.remove('on');
  }
  function startPlay(buf, offset) {
    stopPlay();
    const ctx = new (window.AudioContext || window.webkitAudioContext)(), src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buf; g.gain.value = matchGain(buf) * 0.9; src.connect(g); g.connect(ctx.destination);
    S.off = offset % buf.duration; src.start(0, S.off); S.started = ctx.currentTime; S.ctx = ctx; S.node = src; S.playing = buf;
    src.onended = () => { if (S.node === src) stopPlay(); };
    els.play.classList.add('on');
  }
  const curPos = () => (S.ctx ? S.off + (S.ctx.currentTime - S.started) : S.off);
  function currentSel() { const v = els.srcSel.value; return v === 'orig' ? S.buf : v === 'master' ? S.master.buffer : S.outs.get(v)?.buffer; }
  els.play.onclick = () => { if (!S.master) { say('Run Analyze & Master first.', true); return; } S.playing ? stopPlay() : startPlay(currentSel(), S.off || 0); };
  els.stop.onclick = () => { S.off = 0; stopPlay(); };
  els.srcSel.onchange = () => { if (S.playing) startPlay(currentSel(), curPos()); };

  async function run() {
    if (!S.buf) { say('Load a file or the demo first.', true); return; }
    els.go.disabled = true; stopPlay();
    try {
      const t0 = performance.now();
      if (!S.a) S.a = null;
      say('Analyzing…'); await new Promise((r) => setTimeout(r, 30));
      const s = stereoize(S.buf);
      S.a = S.a && S.aFor === S.buf ? S.a : analyze(s.L, s.R, s.fs); S.aFor = S.buf;
      const itp = interpret(els.desc.value);
      const ids = els.genre.value ? [els.genre.value] : itp.genres;
      S.T = targetFor(ids, itp.mods);
      els.detect.textContent = `Detected: ${S.T.label}${itp.mods.length ? ' · ' + itp.mods.map((m) => m.label).join(', ') : ''}${!ids.length ? ' (no genre found — using Pop defaults)' : ''}`;
      if (!S.P || !S.dirty) { S.plan0 = makePlan(S.a, S.T); S.P = JSON.parse(JSON.stringify(S.plan0)); renderPlanUI(); }
      S.dirty = false; S.cache = new Map(); S.outs = new Map();
      say('Rendering master…'); await new Promise((r) => setTimeout(r, 30));
      S.master = await masterFull(S.buf, S.P, S.a.lufs);
      renderAnalysis(); renderTeach();
      document.body.classList.add('mastered');
      els.srcSel.innerHTML = '<option value="orig">Original</option><option value="master">Master</option>';
      els.srcSel.value = 'master'; els.go.textContent = 'Analyze & Master';
      say(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${S.a.lufs} → ${S.master.analysis.lufs} LUFS (makeup ${S.master.makeupDb} dB). A/B is level-matched.`);
    } catch (e) { say('Failed: ' + e.message, true); console.error(e); }
    finally { els.go.disabled = false; }
  }
  els.go.onclick = run;

  els.cmpBtn.onclick = async () => {
    if (!S.master) { say('Run Analyze & Master first.', true); return; }
    els.cmpBtn.disabled = true;
    try {
      const itp = interpret(els.desc.value);
      for (const [key, sel] of [['A', els.cmpA], ['B', els.cmpB], ['C', els.cmpC]]) {
        say(`Rendering comparison ${key}: ${GENRES[sel.value].name}…`); await new Promise((r) => setTimeout(r, 20));
        const T = targetFor([sel.value], itp.mods), P = makePlan(S.a, T);
        const out = await masterFull(S.buf, P, S.a.lufs);
        S.outs.set('cmp' + key, { ...out, label: GENRES[sel.value].name, P, T });
      }
      els.srcSel.innerHTML = '<option value="orig">Original</option><option value="master">Master (your settings)</option>' + ['A', 'B', 'C'].map((k) => `<option value="cmp${k}">${S.outs.get('cmp' + k).label} master</option>`).join('');
      const rows = ['A', 'B', 'C'].map((k) => { const o = S.outs.get('cmp' + k); return `<tr><td>${o.label}</td><td>${o.analysis.lufs}</td><td>${o.analysis.peakDb}</td><td>${o.analysis.width}</td><td>${o.P.eq.low >= 0 ? '+' : ''}${o.P.eq.low}</td><td>${o.P.eq.air >= 0 ? '+' : ''}${o.P.eq.air}</td></tr>`; }).join('');
      els.cmp.innerHTML = `<table><tr><th>Style</th><th>LUFS</th><th>Peak</th><th>Width</th><th>Low shelf dB</th><th>Air shelf dB</th></tr>${rows}</table>`;
      say('Comparison ready — pick a master in the player.');
    } catch (e) { say('Comparison failed: ' + e.message, true); } finally { els.cmpBtn.disabled = false; }
  };

  els.dlwav.onclick = () => { if (!S.master) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([wavBytes(S.master.buffer)], { type: 'audio/wav' })); a.download = (S.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'track') + '_mastered.wav'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  els.dlrecipe.onclick = () => { if (!S.master) return; const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([recipeText(S.a, S.T, S.P, S.master.analysis)], { type: 'text/plain' })); a.download = 'mastering-recipe.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };

  els.coach.onclick = async () => {
    if (!S.master) { say('Run Analyze & Master first.', true); return; }
    els.coach.disabled = true; els.coachOut.textContent = 'Asking the coach…';
    try {
      const strip = (a) => ({ ...a, curve: undefined });
      const payload = { style: S.T.label, description: els.desc.value.slice(0, 300), before: strip(S.a), after: strip(S.master.analysis), targets: { lufs: S.T.lufs, width: +S.T.width.toFixed(2), bandsRelMids: S.T.bands }, bandsOrder: BANDS.map((b) => b.name), settings: S.P };
      const r = await fetch('/api/assist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'master-explain', messages: [{ role: 'user', content: JSON.stringify(payload) }] }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      els.coachOut.innerHTML = '';
      const p = document.createElement('p'); p.textContent = j.explanation || ''; els.coachOut.appendChild(p);
      if (j.lesson?.length) { const h = document.createElement('strong'); h.textContent = 'Do it by hand in your DAW'; els.coachOut.appendChild(h); const ol = document.createElement('ol'); for (const s of j.lesson) { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); } els.coachOut.appendChild(ol); }
    } catch (e) { els.coachOut.textContent = 'Coach unavailable: ' + e.message; } finally { els.coach.disabled = false; }
  };
})();
