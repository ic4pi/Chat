/* Music — MIDI Humanizer. Pure client-side: parse → humanize → piano roll → A/B play → export.
   The AI coach (optional) calls /api/assist mode "music-explain" with measured stats only. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);

  // ───────────────────────── RNG ─────────────────────────
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    let u = 0, v = 0;
    while (!u) u = r();
    while (!v) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ───────────────────────── MIDI parse ─────────────────────────
  function readVLQ(d, p) {
    let v = 0, b;
    do { b = d[p.i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p.i < d.length);
    return v;
  }

  function parseMidi(buf) {
    const d = new Uint8Array(buf);
    const str = (o, n) => String.fromCharCode(...d.slice(o, o + n));
    if (d.length < 14 || str(0, 4) !== 'MThd') throw new Error('Not a MIDI file');
    const ntrk = (d[10] << 8) | d[11];
    const div = (d[12] << 8) | d[13];
    if (div & 0x8000) throw new Error('SMPTE-timed MIDI is not supported');
    let off = 8 + (((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0);
    const tempos = [];
    const tracks = [];
    for (let t = 0; t < ntrk && off + 8 <= d.length; t++) {
      if (str(off, 4) !== 'MTrk') break;
      const len = ((d[off + 4] << 24) | (d[off + 5] << 16) | (d[off + 6] << 8) | d[off + 7]) >>> 0;
      const end = Math.min(off + 8 + len, d.length);
      const p = { i: off + 8 };
      let tick = 0, status = 0;
      const tr = { name: '', notes: [], others: [], metas: [] };
      const open = new Map();
      while (p.i < end) {
        tick += readVLQ(d, p);
        const b = d[p.i];
        if (b === 0xff) {
          p.i++;
          const type = d[p.i++];
          const l = readVLQ(d, p);
          const data = d.slice(p.i, p.i + l);
          p.i += l;
          if (type === 0x2f) continue;
          if (type === 0x03) tr.name = new TextDecoder().decode(data);
          else if (type === 0x51 && l === 3) tempos.push({ tick, uspq: (data[0] << 16) | (data[1] << 8) | data[2] });
          else tr.metas.push({ tick, type, data });
          continue;
        }
        if (b === 0xf0 || b === 0xf7) { p.i++; p.i += readVLQ(d, p); continue; }
        if (b & 0x80) { status = b; p.i++; }
        const hi = status & 0xf0, ch = status & 0x0f;
        const need = hi === 0xc0 || hi === 0xd0 ? 1 : 2;
        const a = d[p.i++];
        const c = need === 2 ? d[p.i++] : 0;
        const key = ch * 128 + a;
        if (hi === 0x90 && c > 0) {
          if (!open.has(key)) open.set(key, []);
          open.get(key).push({ tick, vel: c });
        } else if (hi === 0x80 || hi === 0x90) {
          const q = open.get(key);
          if (q && q.length) {
            const s = q.shift();
            tr.notes.push({ tick: s.tick, dur: Math.max(1, tick - s.tick), pitch: a, vel: s.vel, ch });
          }
        } else {
          tr.others.push({ tick, status, a, c, need });
        }
      }
      for (const [key, q] of open) for (const s of q) {
        tr.notes.push({ tick: s.tick, dur: Math.max(1, tick - s.tick), pitch: key % 128, vel: s.vel, ch: Math.floor(key / 128) });
      }
      tr.notes.sort((x, y) => x.tick - y.tick || x.pitch - y.pitch);
      tracks.push(tr);
      off = end;
    }
    tempos.sort((x, y) => x.tick - y.tick);
    return { ppq: div, tempos, tracks };
  }

  // ───────────────────────── MIDI write ─────────────────────────
  const vlq = (v) => {
    const out = [v & 0x7f];
    while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

  function trackChunk(events) {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const body = [];
    let last = 0;
    for (const e of events) {
      body.push(...vlq(e.tick - last), ...e.bytes);
      last = e.tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    return [...ascii('MTrk'), ...u32(body.length), ...body];
  }

  function metaBytes(type, data) {
    return [0xff, type, ...vlq(data.length), ...data];
  }

  function writeMidi(song, tracks) {
    const chunks = [];
    const cond = [];
    const tempos = song.tempos.length ? song.tempos : [{ tick: 0, uspq: 500000 }];
    for (const t of tempos) {
      cond.push({ tick: t.tick, order: 0, bytes: metaBytes(0x51, [(t.uspq >> 16) & 255, (t.uspq >> 8) & 255, t.uspq & 255]) });
    }
    chunks.push(trackChunk(cond));
    for (const tr of tracks) {
      const ev = [];
      if (tr.name) ev.push({ tick: 0, order: 0, bytes: metaBytes(0x03, [...new TextEncoder().encode(tr.name)]) });
      for (const m of tr.metas) ev.push({ tick: m.tick, order: 0, bytes: metaBytes(m.type, [...m.data]) });
      for (const o of tr.others) {
        ev.push({ tick: o.tick, order: 0, bytes: o.need === 2 ? [o.status, o.a, o.c] : [o.status, o.a] });
      }
      for (const n of tr.notes) {
        ev.push({ tick: n.tick, order: 2, bytes: [0x90 | n.ch, n.pitch, n.vel] });
        ev.push({ tick: n.tick + n.dur, order: 1, bytes: [0x80 | n.ch, n.pitch, 0] });
      }
      chunks.push(trackChunk(ev));
    }
    const head = [...ascii('MThd'), ...u32(6), 0, 1, (chunks.length >> 8) & 255, chunks.length & 255, (song.ppq >> 8) & 255, song.ppq & 255];
    return new Uint8Array([...head, ...chunks.flat()]);
  }

  // ───────────────────────── Tempo helpers ─────────────────────────
  function tickToSecFn(song) {
    const segs = [];
    let sec = 0, lastTick = 0, uspq = 500000;
    const list = song.tempos.length ? song.tempos : [{ tick: 0, uspq }];
    for (const t of list) {
      sec += ((t.tick - lastTick) * uspq) / 1e6 / song.ppq;
      segs.push({ tick: t.tick, sec, uspq: t.uspq });
      lastTick = t.tick; uspq = t.uspq;
    }
    return (tick) => {
      let s = segs[0];
      for (const g of segs) if (g.tick <= tick) s = g; else break;
      return s.sec + ((tick - s.tick) * s.uspq) / 1e6 / song.ppq;
    };
  }
  const songBpm = (song) => 60000000 / ((song.tempos[0] && song.tempos[0].uspq) || 500000);

  // ───────────────────────── Roles & modes ─────────────────────────
  const KICK = new Set([35, 36]);
  const SNARE = new Set([37, 38, 39, 40]);
  const HAT = new Set([42, 44, 46, 49, 51, 52, 53, 55, 57, 59]);
  const roleOf = (p) => (KICK.has(p) ? 'kick' : SNARE.has(p) ? 'snare' : HAT.has(p) ? 'hat' : 'other');

  function detectMode(tr) {
    if (tr.notes.some((n) => n.ch === 9)) return 'drums';
    if (!tr.notes.length) return 'off';
    const avg = tr.notes.reduce((s, n) => s + n.pitch, 0) / tr.notes.length;
    const at = new Map();
    for (const n of tr.notes) at.set(n.tick, (at.get(n.tick) || 0) + 1);
    const poly = [...at.values()].reduce((s, v) => s + v, 0) / at.size;
    if (avg < 52 && poly < 1.3) return 'bass';
    return 'piano';
  }

  // 16th-note accent shape (in velocity units at velocity=50)
  const ACCENT = [8, -7, -2, -7, 4, -7, -2, -7, 6, -7, -2, -7, 4, -7, -2, -7];
  const BIAS_MS = { drums: { kick: -1, snare: 7, hat: -3, other: 0 }, bass: { other: 4 }, piano: { other: 0 }, guitar: { other: 0 } };

  // ───────────────────────── Humanizer ─────────────────────────
  function humanize(song, cfg, seed) {
    const bpm = songBpm(song);
    const msPerTick = 60000 / (bpm * song.ppq);
    const toTicks = (ms) => ms / msPerTick;
    const bar = song.ppq * 4, six = song.ppq / 4;
    const result = [];
    const stats = [];

    song.tracks.forEach((tr, ti) => {
      if (!tr.notes.length || tr.mode === 'off') { result.push({ ...tr, notes: tr.notes.map((n) => ({ ...n, o: { tick: n.tick, dur: n.dur, vel: n.vel } })) }); stats.push(null); return; }
      const rng = mulberry32(seed * 7919 + ti * 104729 + 1);
      const mode = tr.mode;
      const notes = tr.notes.map((n) => ({ ...n, o: { tick: n.tick, dur: n.dur, vel: n.vel } }));
      const sd = cfg.timing / 2.5;
      const pocketMs = (cfg.pocket / 100) * 15;
      const bias = BIAS_MS[mode] || { other: 0 };
      let drift = 0;

      for (const n of notes) {
        const o = n.o;
        const posInBar = o.tick % bar;
        const idx = Math.round(posInBar / six) % 16;

        // swing: delay notes sitting on the off-grid
        let swingTicks = 0;
        const sw = (cfg.swing - 50) / 100;
        if (sw > 0) {
          if (cfg.swingGrid === 8 && Math.abs(o.tick % song.ppq - song.ppq / 2) < six / 2) swingTicks = song.ppq * sw;
          if (cfg.swingGrid === 16 && Math.abs(o.tick % (song.ppq / 2) - six) < six / 2) swingTicks = (song.ppq / 2) * sw;
        }

        drift = drift * 0.92 + gauss(rng) * cfg.timing * 0.06;
        const role = mode === 'drums' ? roleOf(n.pitch) : 'other';
        const b = (bias[role] ?? 0) * (cfg.timing / 20);
        const lim = cfg.timing * 1.5 + Math.abs(b) + Math.abs(pocketMs);
        const offMs = Math.max(-lim, Math.min(lim, gauss(rng) * sd + drift + b + pocketMs));
        n.tick = Math.max(0, Math.round(o.tick + swingTicks + toTicks(offMs)));

        const accent = ACCENT[idx] * (cfg.velocity / 50) * (mode === 'drums' && role === 'hat' ? 1.4 : 1);
        n.vel = Math.max(1, Math.min(127, Math.round(o.vel + accent + gauss(rng) * cfg.velocity * 0.12)));

        if (mode !== 'drums') {
          const k = mode === 'bass' ? 0.45 : 0.35;
          n.dur = Math.max(1, Math.round(o.dur * (1 + gauss(rng) * (cfg.length / 100) * k)));
        }
      }

      // chords: piano roll-up, guitar strum
      if (mode === 'piano' || mode === 'guitar') {
        const groups = new Map();
        for (const n of notes) {
          const k = n.o.tick;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(n);
        }
        for (const [tick, g] of groups) {
          if (g.length < 2) continue;
          g.sort((x, y) => x.pitch - y.pitch);
          const total = mode === 'guitar' ? cfg.strum : cfg.roll;
          if (total <= 0) continue;
          const onBeat = (tick % song.ppq) < six / 2;
          const down = mode === 'guitar' ? onBeat || rng() < 0.7 : true;
          const order = down ? g : [...g].reverse();
          order.forEach((n, k) => {
            const spread = (k / (g.length - 1)) * total * (0.7 + 0.6 * rng());
            n.tick += Math.round(toTicks(spread));
            if (mode === 'guitar') n.vel = Math.max(1, Math.min(127, n.vel + Math.round((1 - k / (g.length - 1)) * 6 - 3)));
          });
          if (mode === 'piano') {
            const top = g[g.length - 1];
            top.vel = Math.min(127, top.vel + 4);
            top.tick = Math.max(0, top.tick - Math.round(toTicks(3)));
          }
        }
      }

      // drum ghost notes before backbeat snares
      let ghosts = 0;
      if (mode === 'drums' && cfg.ghost > 0) {
        const have = new Set(notes.map((n) => `${n.pitch}@${n.o.tick}`));
        const add = [];
        for (const n of notes) {
          if (!(n.pitch === 38 || n.pitch === 40)) continue;
          const idx = Math.round((n.o.tick % bar) / six) % 16;
          if (idx !== 4 && idx !== 12) continue;
          const gt = n.o.tick - six;
          if (gt < 0 || have.has(`38@${gt}`) || rng() * 100 > cfg.ghost) continue;
          add.push({
            tick: Math.max(0, Math.round(gt + toTicks(gauss(rng) * 2))), dur: Math.round(song.ppq / 8), pitch: 38,
            vel: Math.round(18 + rng() * 18), ch: n.ch, ghost: true, o: null,
          });
          ghosts++;
        }
        notes.push(...add);
      }

      // stop same-pitch notes from overlapping their successor
      const byKey = new Map();
      for (const n of notes) {
        const k = n.ch * 128 + n.pitch;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(n);
      }
      for (const arr of byKey.values()) {
        arr.sort((x, y) => x.tick - y.tick);
        for (let i = 0; i < arr.length - 1; i++) {
          if (arr[i].tick + arr[i].dur >= arr[i + 1].tick) arr[i].dur = Math.max(1, arr[i + 1].tick - arr[i].tick - 1);
        }
      }
      notes.sort((x, y) => x.tick - y.tick || x.pitch - y.pitch);
      result.push({ ...tr, notes });
      stats.push(buildStats(tr, notes, mode, msPerTick, ghosts));
    });
    return { tracks: result, stats };
  }

  const sd = (a) => {
    if (a.length < 2) return 0;
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

  function buildStats(tr, notes, mode, msPerTick, ghosts) {
    const orig = notes.filter((n) => n.o);
    const offs = orig.map((n) => (n.tick - n.o.tick) * msPerTick);
    const roleMeans = {};
    if (mode === 'drums') {
      for (const r of ['kick', 'snare', 'hat']) {
        const v = orig.filter((n) => roleOf(n.pitch) === r).map((n) => (n.tick - n.o.tick) * msPerTick);
        if (v.length) roleMeans[r] = +mean(v).toFixed(1);
      }
    }
    const groups = new Map();
    for (const n of orig) {
      if (!groups.has(n.o.tick)) groups.set(n.o.tick, []);
      groups.get(n.o.tick).push(n.tick);
    }
    const spreads = [...groups.values()].filter((g) => g.length > 1).map((g) => (Math.max(...g) - Math.min(...g)) * msPerTick);
    return {
      track: tr.name || 'Track', mode, notes: orig.length,
      avgAbsOffsetMs: +mean(offs.map(Math.abs)).toFixed(1),
      meanOffsetMs: +mean(offs).toFixed(1),
      roleMeansMs: roleMeans,
      velStdBefore: +sd(orig.map((n) => n.o.vel)).toFixed(1),
      velStdAfter: +sd(orig.map((n) => n.vel)).toFixed(1),
      avgLenChangePct: +(mean(orig.map((n) => (n.dur / n.o.dur - 1) * 100))).toFixed(1),
      ghostNotesAdded: ghosts,
      chordSpreadMs: mode !== 'drums' && spreads.length ? +mean(spreads).toFixed(1) : 0,
    };
  }

  function localExplain(stats, cfg) {
    const lines = [];
    for (const s of stats) {
      if (!s) continue;
      const bits = [];
      bits.push(`Notes now land ${s.avgAbsOffsetMs} ms off the grid on average` +
        (Math.abs(s.meanOffsetMs) >= 1 ? `, ${s.meanOffsetMs > 0 ? 'sitting behind' : 'pushing ahead of'} the beat by ${Math.abs(s.meanOffsetMs)} ms overall.` : ', centred on the beat.'));
      const rm = s.roleMeansMs;
      if (rm.snare !== undefined) bits.push(`Snare sits ${rm.snare >= 0 ? '+' : ''}${rm.snare} ms (a late snare reads as relaxed); hats ${(rm.hat ?? 0) >= 0 ? '+' : ''}${rm.hat ?? 0} ms (${(rm.hat ?? 0) < rm.snare ? 'hats earlier than the snare keep the groove moving' : 'hats and snare drag together for a heavy pocket'}).`);
      bits.push(`Velocity spread went from ${s.velStdBefore} to ${s.velStdAfter}: downbeats get accented and off-16ths get softer, the way a hand naturally plays.`);
      if (s.mode !== 'drums' && Math.abs(s.avgLenChangePct) > 0.5) bits.push(`Note lengths vary by ${s.avgLenChangePct > 0 ? '+' : ''}${s.avgLenChangePct}% on average so notes don't all end on the same tick.`);
      if (s.chordSpreadMs > 0) bits.push(`Chords are spread over ~${s.chordSpreadMs} ms, low note first, instead of all hitting at once.`);
      if (s.ghostNotesAdded) bits.push(`Added ${s.ghostNotesAdded} quiet ghost snares just before the backbeat — they fill the gaps and add feel.`);
      lines.push({ title: `${s.track} (${s.mode})`, bits });
    }
    if (cfg.swing > 50) lines.push({ title: 'Swing', bits: [`${cfg.swing}% on the ${cfg.swingGrid}th grid: every off-${cfg.swingGrid}th is delayed so pairs become long-short instead of even. 50% is straight, ~66% is a triplet shuffle.`] });
    return lines;
  }

  // ───────────────────────── Presets ─────────────────────────
  const PRESETS = {
    'Tight Session Drummer': { timing: 6, velocity: 30, length: 10, swing: 50, ghost: 20, pocket: 0, roll: 6, strum: 20 },
    'Lazy Jazz Pianist': { timing: 14, velocity: 45, length: 40, swing: 62, swingGrid: 8, ghost: 0, pocket: 35, roll: 18, strum: 25 },
    'Nervous Beginner': { timing: 28, velocity: 70, length: 35, swing: 50, ghost: 5, pocket: -25, roll: 10, strum: 30 },
    'Lazy Beat Producer': { timing: 10, velocity: 35, length: 15, swing: 58, swingGrid: 16, ghost: 35, pocket: 40, roll: 8, strum: 20 },
  };
  const SLIDERS = [
    ['timing', 'Timing looseness', 0, 40, 1, 'ms'],
    ['velocity', 'Velocity variation', 0, 100, 1, ''],
    ['length', 'Note length variation', 0, 100, 1, ''],
    ['swing', 'Swing', 50, 75, 1, '%'],
    ['ghost', 'Ghost-note chance', 0, 100, 1, '%'],
    ['pocket', 'Pocket (rush ← → drag)', -100, 100, 1, ''],
    ['roll', 'Piano chord roll', 0, 30, 1, 'ms'],
    ['strum', 'Guitar strum spread', 0, 60, 1, 'ms'],
  ];

  // ───────────────────────── Demo song ─────────────────────────
  function demoSong() {
    const ppq = 480, bar = ppq * 4, tempos = [{ tick: 0, uspq: Math.round(60000000 / 96) }];
    const drums = { name: 'Drums', notes: [], others: [], metas: [], mode: 'drums' };
    const bass = { name: 'Bass', notes: [], others: [], metas: [], mode: 'bass' };
    const keys = { name: 'Keys', notes: [], others: [], metas: [], mode: 'piano' };
    const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
    const roots = [33, 29, 36, 31];
    for (let b = 0; b < 4; b++) {
      const t0 = b * bar;
      for (let s = 0; s < 16; s++) {
        const t = t0 + s * (ppq / 4);
        if (s % 2 === 0) drums.notes.push({ tick: t, dur: ppq / 8, pitch: 42, vel: s % 4 === 0 ? 100 : 80, ch: 9 });
        if (s === 0 || s === 10 || (s === 7 && b % 2)) drums.notes.push({ tick: t, dur: ppq / 8, pitch: 36, vel: 110, ch: 9 });
        if (s === 4 || s === 12) drums.notes.push({ tick: t, dur: ppq / 8, pitch: 38, vel: 105, ch: 9 });
      }
      for (const s of [0, 6, 8, 14]) bass.notes.push({ tick: t0 + s * (ppq / 4), dur: ppq * 0.7, pitch: roots[b] + (s === 14 ? 12 : 0), vel: 100, ch: 1 });
      for (const s of [0, 8, 12]) for (const p of chords[b]) keys.notes.push({ tick: t0 + s * (ppq / 4), dur: s === 0 ? ppq * 1.8 : ppq * 0.9, pitch: p, vel: 85, ch: 0 });
    }
    return { ppq, tempos, tracks: [drums, bass, keys], name: 'Demo groove (perfectly quantized)' };
  }

  // ───────────────────────── State ─────────────────────────
  const COLORS = ['#7C9CFF', '#5DE2B3', '#FFB86B', '#FF7A90', '#C79CFF', '#6BD6FF'];
  const state = { song: null, human: null, cfg: { timing: 10, velocity: 35, length: 15, swing: 50, swingGrid: 16, ghost: 20, pocket: 0, roll: 8, strum: 25 }, seed: 1, view: 'all', mute: new Set(), zoom: 0.08, play: null };

  const els = {
    file: $('#file'), drop: $('#drop'), demo: $('#demo'), name: $('#songName'), tracks: $('#tracks'), sliders: $('#sliders'),
    preset: $('#preset'), grid: $('#swingGrid'), reroll: $('#reroll'), roll: $('#roll'), canvas: $('#canvas'), view: $('#view'),
    zoom: $('#zoom'), playO: $('#playO'), playH: $('#playH'), stop: $('#stop'), exp: $('#export'), explain: $('#explain'),
    coach: $('#coach'), coachOut: $('#coachOut'), status: $('#status'),
  };
  const say = (m, err) => { els.status.textContent = m; els.status.className = err ? 'err' : ''; };

  function load(song) {
    song.tracks.forEach((t) => { if (!t.mode) t.mode = detectMode(t); });
    state.song = song; state.mute = new Set(); state.view = 'all';
    els.name.textContent = song.name || 'Untitled';
    document.body.classList.add('loaded');
    buildTrackUI(); stop(); recompute();
  }

  function buildTrackUI() {
    els.tracks.innerHTML = '';
    els.view.innerHTML = '<option value="all">All tracks</option>';
    state.song.tracks.forEach((t, i) => {
      if (!t.notes.length) return;
      const row = document.createElement('div');
      row.className = 'trk';
      row.innerHTML = `<span class="dot" style="background:${COLORS[i % COLORS.length]}"></span><span class="tn"></span><span class="cnt">${t.notes.length}</span>
        <select data-i="${i}"><option>drums</option><option>piano</option><option>guitar</option><option>bass</option><option>off</option></select>
        <label class="mu"><input type="checkbox" data-m="${i}"> mute</label>`;
      row.querySelector('.tn').textContent = t.name || `Track ${i + 1}`;
      const sel = row.querySelector('select'); sel.value = t.mode;
      sel.onchange = () => { t.mode = sel.value; recompute(); };
      row.querySelector('input').onchange = (e) => { e.target.checked ? state.mute.add(i) : state.mute.delete(i); };
      els.tracks.appendChild(row);
      els.view.insertAdjacentHTML('beforeend', `<option value="${i}">${(t.name || 'Track ' + (i + 1)).replace(/</g, '&lt;')}</option>`);
    });
  }

  function buildSliders() {
    els.sliders.innerHTML = '';
    for (const [k, label, min, max, step, unit] of SLIDERS) {
      const w = document.createElement('label');
      w.className = 'sl';
      w.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" data-k="${k}"><output></output>`;
      const inp = w.querySelector('input'), out = w.querySelector('output');
      inp.value = state.cfg[k]; out.textContent = state.cfg[k] + unit;
      inp.oninput = () => { state.cfg[k] = +inp.value; out.textContent = inp.value + unit; els.preset.value = ''; schedule(); };
      els.sliders.appendChild(w);
    }
    els.grid.value = String(state.cfg.swingGrid);
  }
  function syncSliders() {
    for (const [k, , , , , unit] of SLIDERS) {
      const inp = els.sliders.querySelector(`[data-k="${k}"]`);
      inp.value = state.cfg[k]; inp.nextElementSibling.textContent = state.cfg[k] + unit;
    }
    els.grid.value = String(state.cfg.swingGrid);
  }

  let timer = 0;
  function schedule() { clearTimeout(timer); timer = setTimeout(recompute, 60); }
  function recompute() {
    if (!state.song) return;
    state.human = humanize(state.song, state.cfg, state.seed);
    draw();
    renderExplain();
  }

  // ───────────────────────── Piano roll ─────────────────────────
  function draw() {
    const song = state.song, human = state.human;
    const idxs = song.tracks.map((_, i) => i).filter((i) => song.tracks[i].notes.length && (state.view === 'all' || +state.view === i));
    let maxTick = song.ppq * 4, lo = 127, hi = 0;
    for (const i of idxs) for (const n of human.tracks[i].notes) {
      maxTick = Math.max(maxTick, n.tick + n.dur);
      lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch);
    }
    if (hi < lo) { lo = 48; hi = 72; }
    lo = Math.max(0, lo - 2); hi = Math.min(127, hi + 2);
    const rowH = 8, W = Math.ceil(maxTick * state.zoom) + 20, H = (hi - lo + 1) * rowH;
    const dpr = window.devicePixelRatio || 1, c = els.canvas;
    c.width = W * dpr; c.height = H * dpr; c.style.width = W + 'px'; c.style.height = H + 'px';
    const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.body);
    g.fillStyle = css.getPropertyValue('--roll-bg') || '#0f1219'; g.fillRect(0, 0, W, H);
    for (let p = lo; p <= hi; p++) {
      if ([1, 3, 6, 8, 10].includes(p % 12)) { g.fillStyle = 'rgba(255,255,255,0.025)'; g.fillRect(0, (hi - p) * rowH, W, rowH); }
    }
    for (let t = 0; t <= maxTick; t += song.ppq) {
      const x = t * state.zoom;
      g.strokeStyle = t % (song.ppq * 4) === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
      g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
    }
    for (const i of idxs) {
      const col = COLORS[i % COLORS.length];
      for (const n of human.tracks[i].notes) {
        const y = (hi - n.pitch) * rowH + 1;
        if (n.o) {
          g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1;
          g.strokeRect(n.o.tick * state.zoom + 0.5, y + 0.5, Math.max(2, n.o.dur * state.zoom) - 1, rowH - 3);
        }
        g.globalAlpha = 0.35 + (n.vel / 127) * 0.65;
        g.fillStyle = n.ghost ? '#ffffff' : col;
        g.fillRect(n.tick * state.zoom, y + 1, Math.max(2, n.dur * state.zoom), rowH - 4);
        g.globalAlpha = 1;
      }
    }
  }

  // ───────────────────────── Explain ─────────────────────────
  function renderExplain() {
    const lines = localExplain(state.human.stats, state.cfg);
    els.explain.innerHTML = '';
    if (!lines.length) { els.explain.textContent = 'Nothing to humanize — every track is set to off.'; return; }
    for (const l of lines) {
      const d = document.createElement('div'); d.className = 'ex';
      const h = document.createElement('strong'); h.textContent = l.title; d.appendChild(h);
      const ul = document.createElement('ul');
      for (const b of l.bits) { const li = document.createElement('li'); li.textContent = b; ul.appendChild(li); }
      d.appendChild(ul); els.explain.appendChild(d);
    }
  }

  async function askCoach() {
    els.coach.disabled = true; els.coachOut.textContent = 'Asking the coach…';
    try {
      const payload = { song: state.song.name, bpm: Math.round(songBpm(state.song)), settings: state.cfg, tracks: state.human.stats.filter(Boolean) };
      const r = await fetch('/api/assist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'music-explain', messages: [{ role: 'user', content: JSON.stringify(payload) }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      els.coachOut.innerHTML = '';
      const p = document.createElement('p'); p.textContent = j.explanation || ''; els.coachOut.appendChild(p);
      if (j.lesson && j.lesson.length) {
        const h = document.createElement('strong'); h.textContent = 'Try it yourself in your DAW'; els.coachOut.appendChild(h);
        const ol = document.createElement('ol');
        for (const s of j.lesson) { const li = document.createElement('li'); li.textContent = s; ol.appendChild(li); }
        els.coachOut.appendChild(ol);
      }
    } catch (e) {
      els.coachOut.textContent = `Coach unavailable: ${e.message}`;
    } finally { els.coach.disabled = false; }
  }

  // ───────────────────────── Playback (Web Audio) ─────────────────────────
  function stop() {
    if (state.play) { try { state.play.ctx.close(); } catch {} cancelAnimationFrame(state.play.raf); state.play = null; }
    els.playO.classList.remove('on'); els.playH.classList.remove('on');
  }

  function play(which) {
    if (!state.song) return;
    stop();
    const song = state.song;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const tsec = tickToSecFn(song);
    const master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const start = ctx.currentTime + 0.15;
    let endSec = 0;

    const noise = (t, dur, type, freq, gain) => {
      const s = ctx.createBufferSource(); s.buffer = nb;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
      const gn = ctx.createGain(); gn.gain.setValueAtTime(gain, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(gn); gn.connect(master); s.start(t); s.stop(t + dur + 0.02);
    };
    const tone = (t, dur, freq, type, gain, sweepTo, lp) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
      if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t + Math.min(dur, 0.12));
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(gain, t + 0.006);
      gn.gain.setValueAtTime(gain, t + Math.max(0.01, dur - 0.05)); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
      let node = o;
      if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); node = f; }
      node.connect(gn); gn.connect(master); o.start(t); o.stop(t + dur + 0.12);
    };

    const tracks = which === 'orig' ? song.tracks : state.human.tracks;
    tracks.forEach((tr, i) => {
      if (state.mute.has(i)) return;
      for (const n of tr.notes) {
        if (which === 'orig' && n.ghost) continue;
        const tick = which === 'orig' && n.o ? n.o.tick : n.tick;
        const durT = which === 'orig' && n.o ? n.o.dur : n.dur;
        const vel = (which === 'orig' && n.o ? n.o.vel : n.vel) / 127;
        const t = start + tsec(tick), dur = Math.max(0.03, tsec(tick + durT) - tsec(tick));
        endSec = Math.max(endSec, t - start + dur);
        if (n.ch === 9) {
          const p = n.pitch;
          if (KICK.has(p)) tone(t, 0.18, 150, 'sine', vel * 0.9, 45);
          else if (SNARE.has(p)) { noise(t, 0.16, 'bandpass', 1800, vel * 0.5); tone(t, 0.08, 190, 'triangle', vel * 0.3, 140); }
          else if (HAT.has(p)) noise(t, p === 46 ? 0.25 : 0.05, 'highpass', 7000, vel * 0.28);
          else tone(t, 0.2, 60 + (p % 12) * 14, 'sine', vel * 0.6, 50);
        } else {
          const f = 440 * Math.pow(2, (n.pitch - 69) / 12);
          if (n.pitch < 52) tone(t, dur, f, 'sawtooth', vel * 0.3, 0, 700);
          else tone(t, dur, f, 'triangle', vel * 0.2);
        }
      }
    });
    const btn = which === 'orig' ? els.playO : els.playH; btn.classList.add('on');
    const p = { ctx, raf: 0 };
    state.play = p;
    const tick = () => { if (!state.play || state.play !== p) return; if (ctx.currentTime - start > endSec + 0.4) { stop(); return; } p.raf = requestAnimationFrame(tick); };
    tick();
  }

  function exportMidi() {
    if (!state.song) return;
    const bytes = writeMidi(state.song, state.human.tracks);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    a.download = ((state.song.name || 'song').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'song') + '_humanized.mid';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ───────────────────────── Wiring ─────────────────────────
  async function handleFile(f) {
    if (!f) return;
    try {
      const song = parseMidi(await f.arrayBuffer());
      song.name = f.name;
      if (!song.tracks.some((t) => t.notes.length)) throw new Error('No notes found in this file');
      load(song); say(`Loaded ${f.name}: ${song.tracks.filter((t) => t.notes.length).length} track(s), ${Math.round(songBpm(song))} BPM`);
    } catch (e) { say(e.message, true); }
  }

  els.file.onchange = () => handleFile(els.file.files[0]);
  els.drop.ondragover = (e) => { e.preventDefault(); els.drop.classList.add('over'); };
  els.drop.ondragleave = () => els.drop.classList.remove('over');
  els.drop.ondrop = (e) => { e.preventDefault(); els.drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); };
  els.drop.onclick = () => els.file.click();
  els.demo.onclick = () => { load(demoSong()); say('Demo loaded — try the presets, then A/B it.'); };
  els.preset.innerHTML = '<option value="">Custom</option>' + Object.keys(PRESETS).map((k) => `<option>${k}</option>`).join('');
  els.preset.onchange = () => { if (PRESETS[els.preset.value]) { Object.assign(state.cfg, { swingGrid: 16 }, PRESETS[els.preset.value]); syncSliders(); schedule(); } };
  els.grid.onchange = () => { state.cfg.swingGrid = +els.grid.value; els.preset.value = ''; schedule(); };
  els.reroll.onclick = () => { state.seed = (Math.random() * 1e6) | 0; recompute(); };
  els.view.onchange = () => { state.view = els.view.value; draw(); };
  els.zoom.oninput = () => { state.zoom = +els.zoom.value; if (state.human) draw(); };
  els.playO.onclick = () => (els.playO.classList.contains('on') ? stop() : play('orig'));
  els.playH.onclick = () => (els.playH.classList.contains('on') ? stop() : play('human'));
  els.stop.onclick = stop;
  els.exp.onclick = exportMidi;
  els.coach.onclick = askCoach;
  buildSliders();
  window.__music = { parseMidi, writeMidi, humanize, demoSong, detectMode };
})();
