/**
 * Is each Modal app deployed, and does it still answer the way the client
 * expects?
 *
 *   node scripts/check-modal-endpoints.mjs              # probe all 8 — seconds, free
 *   node scripts/check-modal-endpoints.mjs --full       # + real wan/ltx generations
 *   node scripts/check-modal-endpoints.mjs --full sdxl  # one app, real generation
 *
 * PROBE (default) answers "did it deploy, under the name the client calls?".
 * It sends a GET to a POST-only endpoint: Modal's gateway routes that without
 * ever waking a container, so a deployed app answers 405 instantly and a
 * missing one answers 404. No GPU, no cost, no cold start. This is the check
 * to run after a redeploy — Modal derives an endpoint's URL from the app name
 * plus the function name, so a rename is silent until something calls it.
 *
 * FULL sends the exact request body api/media-generate.js sends and asserts
 * the exact response keys that file reads back, so drift between the deployed
 * apps and the client surfaces here rather than as a dead generate button.
 * It runs real generations: minutes of GPU time and real money per app.
 *
 * Run it from a machine that can reach *.modal.run.
 */

const SECRET = (process.env.MODAL_SHARED_SECRET || '').trim();
const authHeaders = () => (SECRET ? { 'X-Modal-Secret': SECRET } : {});

/**
 * Every Modal app the client calls, with the URL it defaults to. Keep these in
 * step with the MODAL_*_ENDPOINT constants in api/media-generate.js — that is
 * the whole point of this file.
 */
const ENDPOINTS = {
  sdxl: {
    url: process.env.MODAL_SDXL_ENDPOINT || 'https://ic4pi--sdxl-nsfw-v2-generate.modal.run',
    what: 'image · SDXL (lustify / wai-illustrious)',
    // Mirrors generateModalSdxlImage().
    body: { prompt: 'a red balloon over a field', model: 'lustify', width: 1024, height: 1024 },
    expect: ['image_base64'],
  },
  'sdxl-legacy': {
    url: 'https://ic4pi--sdxl-nsfw-generate.modal.run',
    what: 'image · SDXL v1 (fallback path only)',
    optional: true,
    body: { prompt: 'a red balloon over a field', model: 'lustify', width: 1024, height: 1024 },
    expect: ['image_base64'],
  },
  wan: {
    url: process.env.MODAL_WAN_ENDPOINT || 'https://ic4pi--wan-video-generate.modal.run',
    what: 'video · Wan 2.2 5B',
    // Mirrors generateModalWanVideo(): 832x480, 81 frames, 16fps, 1 clip.
    body: { prompt: 'a red balloon drifting over a field, cinematic',
            width: 832, height: 480, num_frames: 81, fps: 16, num_clips: 1 },
    expect: ['video_base64'],
  },
  a14b: {
    url: process.env.MODAL_WAN_A14B_ENDPOINT || 'https://ic4pi--wan-video-a14b-generate.modal.run',
    what: 'video · Wan 2.2 A14B',
    body: { prompt: 'a red balloon drifting over a field, cinematic',
            width: 832, height: 480, num_frames: 81, fps: 16, num_clips: 1 },
    expect: ['video_base64'],
  },
  ltx: {
    url: process.env.MODAL_LTX_ENDPOINT || 'https://ic4pi--ltx-video-generate.modal.run',
    what: 'video · LTX',
    // Mirrors generateModalLtxVideo(): 704x480, 121 frames, 24fps, 1 clip.
    body: { prompt: 'a red balloon drifting over a field, cinematic',
            width: 704, height: 480, num_frames: 121, fps: 24, num_clips: 1 },
    expect: ['video_base64'],
  },
  tts: {
    url: process.env.MODAL_TTS_ENDPOINT || 'https://ic4pi--voice-tts-speak.modal.run',
    what: 'voice · Chatterbox TTS',
    body: { text: 'a red balloon drifting over a field' },
    expect: ['audio_base64'],
  },
  stitch: {
    url: process.env.MODAL_STITCH_ENDPOINT || 'https://ic4pi--video-stitch-join.modal.run',
    what: 'video · ffmpeg join (CPU only)',
    // Needs real clips to join, so only the probe is meaningful here.
    probeOnly: true,
  },
  lipsync: {
    url: process.env.MODAL_LIPSYNC_ENDPOINT || 'https://ic4pi--lip-sync-run.modal.run',
    what: 'video · lip-sync',
    // Needs a real clip plus a real voice track.
    probeOnly: true,
  },
};

const TIMEOUT_MS = Number(process.env.MODAL_CHECK_TIMEOUT_MS) || 900_000;
const PROBE_TIMEOUT_MS = 30_000;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--')).map((a) => a.slice(2));
const named = args.filter((a) => !a.startsWith('--') && ENDPOINTS[a]);
const full = flags.includes('full');
const selected = named.length ? named : Object.keys(ENDPOINTS);

const mb = (n) => `${(n / 1_048_576).toFixed(1)}MB`;

/**
 * Deployed or not, without waking anything. Modal answers a GET to a POST-only
 * endpoint at the gateway: 405 means the route exists, 404 means no app of
 * that name is serving it.
 */
async function probe(name) {
  const spec = ENDPOINTS[name];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(spec.url, { method: 'GET', headers: authHeaders(), signal: ctl.signal });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const text = await res.text().catch(() => '');

    // An egress proxy that refuses the host answers 403 too, and calling that
    // "deployed, auth required" would be a green light proving nothing. Say
    // the request never left this machine instead.
    if (res.headers.get('x-deny-reason') || /not in allowlist|egress|blocked by policy/i.test(text)) {
      return { name, blocked: true, secs,
               why: `blocked before it left this machine (${res.headers.get('x-deny-reason') || 'network policy'})` };
    }
    if (res.status === 404) {
      return { name, ok: false, secs, why: 'HTTP 404 — nothing deployed at this name' };
    }
    if (res.status === 401 || res.status === 403) {
      // Modal answered: the app is there and wants credentials.
      return { name, ok: true, secs, detail: `deployed (HTTP ${res.status} — auth required)` };
    }
    return { name, ok: true, secs, detail: `deployed (HTTP ${res.status})` };
  } catch (e) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    return { name, ok: false, secs,
             why: e.name === 'AbortError' ? `no answer in ${secs}s` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** The real thing: same body the client sends, same keys it reads back. */
async function contract(name) {
  const spec = ENDPOINTS[name];
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  try {
    // fetch() follows Modal's 303-to-result redirect and switches to GET.
    // curl -X POST -L does not, which is why this is a script and not a curl.
    const res = await fetch(spec.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(spec.body),
      signal: ctl.signal,
    });

    const secs = ((Date.now() - started) / 1000).toFixed(0);
    const body = await res.json().catch(() => ({}));

    if (!res.ok) return { name, ok: false, why: `HTTP ${res.status} ${body.error || ''}`.trim(), secs };
    if (body.error) return { name, ok: false, why: `app error: ${body.error}`, secs };

    const missing = spec.expect.filter((k) => !body[k]);
    if (missing.length) {
      return { name, ok: false, secs,
               why: `missing ${missing.join(', ')} — got keys: ${Object.keys(body).join(', ') || '(none)'}` };
    }

    const bytes = Buffer.from(body[spec.expect[0]], 'base64').length;
    // A payload this size 413s on Vercel before it ever reaches the browser.
    const tooBig = bytes > 4.5 * 1_048_576;
    return { name, ok: true, secs, bytes, tooBig,
             detail: `${mb(bytes)}${body.elapsed_seconds ? `, gpu ${body.elapsed_seconds}s` : ''}` };
  } catch (e) {
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    return { name, ok: false, secs, why: e.name === 'AbortError' ? `timed out after ${secs}s` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

console.log(full
  ? 'Full contract check — real generations, real GPU cost.\n'
  : 'Probe — is each app deployed under the name the client calls?\n');
if (!SECRET) {
  console.log('MODAL_SHARED_SECRET is unset, so nothing is sent for auth.');
  console.log('If the apps require it, they answer 401/403 and that still proves deployment.\n');
}

const results = [];
for (const name of selected) {
  const spec = ENDPOINTS[name];
  process.stdout.write(`${name.padEnd(12)} ${spec.url}\n`);
  const runFull = full && !spec.probeOnly;
  results.push({ ...(runFull ? await contract(name) : await probe(name)), probed: !runFull });
  if (full && spec.probeOnly) console.log(`             (probe only — needs real input to generate)`);
}

console.log('');
let failed = 0;
let blocked = 0;
for (const r of results) {
  const spec = ENDPOINTS[r.name];
  if (r.blocked) {
    if (!spec.optional) blocked++;
    console.error(`?     ${r.name.padEnd(12)} ${r.why} — ${spec.what}`);
  } else if (r.ok) {
    console.log(`ok    ${r.name.padEnd(12)} ${r.detail} (${r.secs}s) — ${spec.what}`);
    if (r.tooBig) console.log(`      WARNING: over Vercel's 4.5MB body limit — will 413 through /api/media-generate`);
  } else if (spec.optional) {
    console.log(`—     ${r.name.padEnd(12)} ${r.why} — ${spec.what}, not required`);
  } else {
    failed++;
    console.error(`FAIL  ${r.name.padEnd(12)} ${r.why} (${r.secs}s) — ${spec.what}`);
  }
}
const checked = results.filter((r) => !ENDPOINTS[r.name].optional).length;
if (blocked) {
  console.error(
    `\n${blocked} of ${checked} never reached Modal — this machine's network policy blocks *.modal.run,` +
    `\nso nothing here says anything about your deployments. Run it somewhere with egress.`,
  );
  process.exit(2);
}
console.log(failed ? `\n${failed} of ${checked} failing` : `\nall ${checked} answering`);
if (!full && !failed) console.log('Deployed and routable. Run with --full to prove they still generate.');
process.exit(failed ? 1 : 0);
