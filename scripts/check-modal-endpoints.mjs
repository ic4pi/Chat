/**
 * Live contract check against the deployed Modal apps.
 *
 *   node scripts/check-modal-endpoints.mjs            # video only (default)
 *   node scripts/check-modal-endpoints.mjs --all      # + the SDXL image app
 *   node scripts/check-modal-endpoints.mjs --ltx      # one app only
 *
 * Run it from a machine that can reach *.modal.run. It sends the exact request
 * body api/media-generate.js sends and asserts the exact response keys that
 * file reads back, so a drift between the deployed apps and the client shows up
 * here rather than as a dead generate button.
 *
 * Cold starts are slow by design (scale-to-zero), so the timeout is generous
 * and a first run may take several minutes.
 */

const ENDPOINTS = {
  wan: {
    url: process.env.MODAL_WAN_ENDPOINT || 'https://ic4pi--wan-video-generate.modal.run',
    kind: 'video',
    // Mirrors generateModalWanVideo(): 832x480, 81 frames, 16fps, 1 clip.
    body: { prompt: 'a red balloon drifting over a field, cinematic',
            width: 832, height: 480, num_frames: 81, fps: 16, num_clips: 1 },
    expect: ['video_base64'],
  },
  ltx: {
    url: process.env.MODAL_LTX_ENDPOINT || 'https://ic4pi--ltx-video-generate.modal.run',
    kind: 'video',
    // Mirrors generateModalLtxVideo(): 704x480, 121 frames, 24fps, 1 clip.
    body: { prompt: 'a red balloon drifting over a field, cinematic',
            width: 704, height: 480, num_frames: 121, fps: 24, num_clips: 1 },
    expect: ['video_base64'],
  },
  sdxl: {
    url: process.env.MODAL_SDXL_ENDPOINT || 'https://ic4pi--sdxl-nsfw-generate.modal.run',
    kind: 'image',
    // Mirrors generateModalSdxlImage().
    body: { prompt: 'a red balloon over a field', model: 'lustify', width: 1024, height: 1024 },
    expect: ['image_base64'],
  },
};

const TIMEOUT_MS = Number(process.env.MODAL_CHECK_TIMEOUT_MS) || 900_000;

const args = process.argv.slice(2);
const named = args.filter((a) => a.startsWith('--')).map((a) => a.slice(2));
const selected = named.includes('all')
  ? Object.keys(ENDPOINTS)
  : named.filter((n) => ENDPOINTS[n]).length
    ? named.filter((n) => ENDPOINTS[n])
    : ['wan', 'ltx'];

const mb = (n) => `${(n / 1_048_576).toFixed(1)}MB`;

async function check(name) {
  const spec = ENDPOINTS[name];
  process.stdout.write(`${name.padEnd(5)} ${spec.url}\n`);

  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  try {
    // fetch() follows Modal's 303-to-result redirect and switches to GET.
    // curl -X POST -L does not, which is why this is a script and not a curl.
    const res = await fetch(spec.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

const results = [];
for (const name of selected) results.push(await check(name));

console.log('');
let failed = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`ok    ${r.name} — ${r.detail} (${r.secs}s wall)`);
    if (r.tooBig) console.log(`      WARNING: over Vercel's 4.5MB body limit — will 413 through /api/media-generate`);
  } else {
    failed++;
    console.error(`FAIL  ${r.name} — ${r.why} (${r.secs}s)`);
  }
}
console.log(failed ? `\n${failed} of ${results.length} failing` : `\nall ${results.length} passing`);
process.exit(failed ? 1 : 0);
