/**
 * Generate a planned series of clips from a shot list, in one sitting.
 *
 * Two things this buys over clicking Generate N times:
 *
 *   Cost — the Modal apps scale to zero and reload weights on a cold start.
 *   Running the shots back to back keeps one container warm for the whole
 *   list, so the cold start and the 5-minute idle window are paid once
 *   instead of once per clip. On A14B that overhead is most of the bill for
 *   scattered one-offs.
 *
 *   Consistency — a series falls apart when the character drifts between
 *   shots. Every prompt here is expanded to "<shot>, <character>, <style>"
 *   with the character description repeated verbatim, and every shot runs on
 *   the same seed. Both matter: the seed fixes the noise the model starts
 *   from, and the repeated description stops it inventing a new bear each
 *   time. Pronouns and "the same character as before" do not work — the model
 *   has no memory across calls.
 *
 * Usage:
 *   node scripts/batch-video.mjs shots.json
 *   node scripts/batch-video.mjs shots.json --out ./clips --dry-run
 *
 * Shot list (JSON):
 *   {
 *     "site":      "https://your-site.vercel.app",
 *     "model":     "wan2.2-5b",       // or ltx-video | wan2.2-a14b
 *     "seed":      12345,             // shared across every shot
 *     "seconds":   5,
 *     "size":      "832x480",
 *     "accessKey": "",                // only if VIDEO_ACCESS_KEYS is set
 *     "character": "worn brown teddy bear, missing left eye, red bowtie",
 *     "style":     "2D cartoon, flat colors, thick black outlines",
 *     "negative":  "blurry, distorted",
 *     "shots": [
 *       "sitting alone on a park bench at dusk",
 *       "slowly turning to look at the camera"
 *     ]
 *   }
 *
 * Continuous mode ("continuous": true) feeds each clip's last frame into the
 * next as its start image, for one unbroken scene rather than separate shots.
 * Only wan2.2-5b and ltx-video can do it — A14B has no image-to-video
 * pipeline, so it is rejected rather than silently ignored.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const POLL_MS = 5000;
const POLL_CEILING_MS = 3_600_000;

const args = process.argv.slice(2);
const configPath = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const outDir = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1] : './clips';
})();

if (!configPath) {
  console.error('Usage: node scripts/batch-video.mjs <shots.json> [--out ./clips] [--dry-run]');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const shots = Array.isArray(cfg.shots) ? cfg.shots.filter((s) => String(s || '').trim()) : [];
if (!shots.length) {
  console.error(`No shots in ${configPath}.`);
  process.exit(1);
}

const model = cfg.model || 'wan2.2-5b';
const continuous = !!cfg.continuous;
// A14B loads only a text-to-video pipeline (two 14B experts already fill the
// card), so there is nothing to continue a frame from. Failing here beats
// silently producing disconnected shots the caller asked to be continuous.
if (continuous && /a14b/i.test(model)) {
  console.error('continuous mode needs image-to-video — use wan2.2-5b or ltx-video, not A14B.');
  process.exit(1);
}

// Chaining needs the previous clip's last frame, which the API does not
// return — it is pulled out of the mp4 locally instead. Checked up front so a
// missing ffmpeg fails before spending GPU time rather than on shot 2.
if (continuous) {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.error('continuous mode needs ffmpeg on PATH to pull each clip\'s last frame.');
    process.exit(1);
  }
}

const site = String(cfg.site || '').replace(/\/+$/, '');
if (!site && !dryRun) {
  console.error('Set "site" in the config (e.g. https://your-site.vercel.app).');
  process.exit(1);
}

// The whole point of the character/style fields: repeated verbatim on every
// shot rather than mentioned once, because each call is independent.
function expand(shot) {
  return [shot, cfg.character, cfg.style].map((p) => String(p || '').trim()).filter(Boolean).join(', ');
}

// One seed for the series. Without this each shot starts from different noise
// and the character drifts even with an identical description.
const seed = Number.isFinite(Number(cfg.seed)) ? Number(cfg.seed) : Math.floor(Math.random() * 2 ** 31);

console.log(`${shots.length} shot(s) · ${model} · seed ${seed}${continuous ? ' · continuous' : ''}`);
for (const [i, shot] of shots.entries()) console.log(`  ${i + 1}. ${expand(shot)}`);
if (dryRun) {
  console.log('\n--dry-run: nothing submitted.');
  process.exit(0);
}

const post = async (op, body) => {
  const res = await fetch(`${site}/api/media-generate${op ? `?op=${op}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};

/** Submit one shot and poll it to completion. Falls back to the blocking
 *  route when the app has no submit endpoint (HTTP 501 ASYNC_UNAVAILABLE). */
async function generate(prompt, imageBase64) {
  const payload = {
    kind: 'video',
    provider: 'modal',
    model,
    prompt,
    negativePrompt: cfg.negative || undefined,
    size: cfg.size,
    seconds: cfg.seconds || 5,
    seed,
    accessKey: cfg.accessKey || undefined,
    ...(imageBase64 ? { imageBase64 } : {}),
  };

  const { res, data } = await post('submit', payload);
  if (res.status === 501 || data.code === 'ASYNC_UNAVAILABLE') {
    const sync = await post('', payload);
    if (!sync.res.ok) throw new Error(sync.data.error || `HTTP ${sync.res.status}`);
    return sync.data;
  }
  if (!res.ok || !data.jobId) throw new Error(data.error || `HTTP ${res.status}`);

  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (Date.now() - started > POLL_CEILING_MS) throw new Error('Timed out waiting for the job.');
    let job;
    try {
      job = (await post('result', { jobId: data.jobId, model, accessKey: cfg.accessKey })).data;
    } catch {
      continue; // a dropped request is not a dead job — keep polling
    }
    if (job.status === 'running') continue;
    if (job.status !== 'done') throw new Error(job.error || job.status);
    return job;
  }
}

/** Last frame of a finished clip, as a data URL for the next shot's i2v call.
 *  sseof seeks from the end, so this decodes the final second rather than the
 *  whole clip. */
async function lastFrameOf(videoUrl, localFile) {
  let src = localFile;
  let temp;
  if (!src || src === videoUrl) {
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`could not fetch clip (HTTP ${res.status})`);
    temp = join(outDir, `.carry-${Date.now()}.mp4`);
    writeFileSync(temp, Buffer.from(await res.arrayBuffer()));
    src = temp;
  }
  const framePath = join(outDir, `.carry-${Date.now()}.jpg`);
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-sseof', '-1', '-i', src, '-update', '1', '-q:v', '3', framePath],
      { stdio: 'ignore' },
    );
    return `data:image/jpeg;base64,${readFileSync(framePath).toString('base64')}`;
  } finally {
    for (const f of [temp, framePath]) if (f) rmSync(f, { force: true });
  }
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const manifest = [];
let carryFrame; // last frame of the previous clip, in continuous mode
let spent = 0;

for (const [i, shot] of shots.entries()) {
  const n = String(i + 1).padStart(2, '0');
  const prompt = expand(shot);
  process.stdout.write(`[${n}/${shots.length}] generating… `);
  const t0 = Date.now();

  let out;
  try {
    out = await generate(prompt, continuous ? carryFrame : undefined);
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
    manifest.push({ shot: i + 1, prompt, error: err.message });
    continue; // one bad shot should not throw away the clips already paid for
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  spent += Number(out.elapsedSeconds) || 0;

  // A hosted URL is just recorded; inline base64 is written out, since without
  // storage configured that is the only copy of the clip.
  let where = out.videoUrl;
  if (String(out.videoUrl || '').startsWith('data:')) {
    const b64 = out.videoUrl.split(',', 2)[1] || '';
    const file = join(outDir, `shot-${n}.mp4`);
    writeFileSync(file, Buffer.from(b64, 'base64'));
    where = file;
  }
  console.log(`done in ${secs}s → ${where}`);
  manifest.push({ shot: i + 1, prompt, seed, url: out.videoUrl, file: where });

  if (continuous && i < shots.length - 1) {
    try {
      carryFrame = await lastFrameOf(out.videoUrl, where);
    } catch (err) {
      // Losing continuity is worth reporting, but not worth discarding the
      // clips already generated — the run continues as separate shots.
      console.log(`   (continuity broken: ${err.message})`);
      carryFrame = undefined;
    }
  }
}

const manifestPath = join(outDir, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify({ model, seed, continuous, shots: manifest }, null, 2));

const ok = manifest.filter((m) => !m.error).length;
console.log(`\n${ok}/${shots.length} clip(s) · ${spent.toFixed(0)}s GPU · ${manifestPath}`);
