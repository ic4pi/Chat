const IMAGE_MODELS = [
  { value: 'modal:lustify', label: 'Realistic · Text → Image (self-hosted)', kind: 'image', provider: 'modal', model: 'lustify', usesRef: false },
  { value: 'modal:wai-illustrious', label: 'Anime · Text → Image (self-hosted)', kind: 'image', provider: 'modal', model: 'wai-illustrious', usesRef: false },
  { value: 'cloudflare:flux-schnell', label: 'Cloudflare · FLUX.1 Schnell (free, filtered)', kind: 'image', provider: 'cloudflare', model: 'flux-schnell', usesRef: false },
  { value: 'cloudflare:sdxl-lightning', label: 'Cloudflare · SDXL Lightning (free, filtered)', kind: 'image', provider: 'cloudflare', model: 'sdxl-lightning', usesRef: false },
  { value: 'cloudflare:sdxl', label: 'Cloudflare · SDXL Base (free, filtered)', kind: 'image', provider: 'cloudflare', model: 'sdxl', usesRef: false },
];

// maxSeconds is a per-model safety cap on the Length picker.
//
// It used to be bounded by Vercel: a single 5s Wan clip at 40 steps took 6m20s
// end to end, so four chained clips would have blown the 800s function timeout
// and died with the GPU time already spent. Video now goes through the async
// job API (?op=submit / ?op=result), so no single request has to outlive that
// timeout, and the binding constraint is the Modal apps' own 6-clip ceiling
// (~30s) and their 3600s function timeout.
//
// Six Wan clips at the old 40-step speed would be ~38min — inside Modal's
// timeout, but a long wait. The Lightning LoRA in modal/wan_app.py should cut
// that sharply; re-measure once it is deployed.
//
// These caps assume the job API. A Modal app deployed before modal/ existed
// has no submit endpoint, and the client falls back to one blocking request
// bounded by the 800s function timeout — where anything past ~10s of Wan will
// die. The fallback warns rather than silently letting it happen.
const VIDEO_MODELS = [
  { value: 'modal:wan2.2-5b', label: 'Wan 2.2 5B · Text → Video (self-hosted, slow)', kind: 'video', provider: 'modal', model: 'wan2.2-5b', usesRef: false, maxSeconds: 30, modes: ['text', 'restyle'] },
  { value: 'modal:ltx-video', label: 'LTX-Video · Text → Video (self-hosted, fast)', kind: 'video', provider: 'modal', model: 'ltx-video', usesRef: false, maxSeconds: 30, modes: ['text', 'keyframes'] },
  // fal.ai / NVIDIA / Cloudflare video removed - fal and NVIDIA both bill per
  // generation, and Cloudflare's Seedance models are a third-party pass-through
  // (not covered by the Workers AI free Neurons tier, not on Cloudflare's own
  // pricing page) - none of them are actually free.
];

const IMAGE_SIZES = [
  { value: '1024x1024', label: '1024 × 1024' },
  { value: '1280x720', label: '1280 × 720' },
  { value: '720x1280', label: '720 × 1280' },
];

const VIDEO_SIZES = [
  { value: '832x480', label: 'Landscape · 16:9' },
  { value: '480x832', label: 'Portrait · 9:16' },
];

// Filtered per-model by maxSeconds (see VIDEO_MODELS) in fillLengths().
const VIDEO_LENGTHS = [
  { value: '5', label: '5s' },
  { value: '10', label: '10s' },
  { value: '15', label: '15s' },
  { value: '20', label: '20s' },
  { value: '25', label: '25s' },
  { value: '30', label: '30s' },
];

/** Vercel Functions reject bodies over 4.5MB (HTTP 413). Keep refs well under. */
const REF_MAX_EDGE = 1024;
const REF_MAX_BYTES = 1_200_000;

const els = {
  tabs: [...document.querySelectorAll('.media-tab')],
  model: document.getElementById('mediaModel'),
  prompt: document.getElementById('mediaPrompt'),
  negative: document.getElementById('mediaNegative'),
  negativeWrap: document.getElementById('negativeWrap'),
  size: document.getElementById('mediaSize'),
  sizeWrap: document.getElementById('sizeWrap'),
  length: document.getElementById('mediaLength'),
  count: document.getElementById('mediaCount'),
  countWrap: document.getElementById('countWrap'),
  mode: document.getElementById('mediaMode'),
  modeWrap: document.getElementById('modeWrap'),
  strength: document.getElementById('mediaStrength'),
  strengthWrap: document.getElementById('strengthWrap'),
  expand: document.getElementById('mediaExpand'),
  expandWrap: document.getElementById('expandWrap'),
  poseSource: document.getElementById('mediaPoseSource'),
  poseWrap: document.getElementById('poseWrap'),
  videoMode: document.getElementById('mediaVideoMode'),
  videoModeWrap: document.getElementById('videoModeWrap'),
  srcVideo: document.getElementById('mediaSrcVideo'),
  srcVideoWrap: document.getElementById('srcVideoWrap'),
  keyframesWrap: document.getElementById('keyframesWrap'),
  keyframeRows: document.getElementById('keyframeRows'),
  addKeyframe: document.getElementById('addKeyframe'),
  lengthWrap: document.getElementById('lengthWrap'),
  ref: document.getElementById('mediaRef'),
  refWrap: document.getElementById('refWrap'),
  refPreview: document.getElementById('refPreview'),
  accessKey: document.getElementById('mediaAccessKey'),
  accessKeyWrap: document.getElementById('accessKeyWrap'),
  generate: document.getElementById('mediaGenerate'),
  status: document.getElementById('mediaStatus'),
  gallery: document.getElementById('mediaGallery'),
  empty: document.getElementById('mediaEmpty'),
};

let kind = 'image';
let refData = null; // { base64, mimeType }
let srcVideoData = null; // base64 data URL of a clip to restyle

const VIDEO_MODE_LABELS = {
  text: 'Text → Video',
  restyle: 'Restyle a video (keeps the motion)',
  keyframes: 'Timeline keyframes (guide the motion)',
};

/** Vercel rejects request bodies over 4.5MB, and a source clip has to fit
 *  inside one alongside everything else. Compressing video in the browser is
 *  not practical, so this is a hard limit the user is told about up front. */
const SRC_VIDEO_MAX_BYTES = 3_000_000;

function currentModels() {
  return kind === 'video' ? VIDEO_MODELS : IMAGE_MODELS;
}

function fillModels() {
  const list = currentModels();
  els.model.innerHTML = '';
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    els.model.appendChild(opt);
  }
}

function fillSizes() {
  const list = kind === 'video' ? VIDEO_SIZES : IMAGE_SIZES;
  els.size.innerHTML = '';
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.value;
    opt.textContent = s.label;
    els.size.appendChild(opt);
  }
}

function fillLengths() {
  const spec = selectedSpec();
  const maxSeconds = (kind === 'video' && spec?.maxSeconds) || 30;
  const prevValue = els.length.value;
  els.length.innerHTML = '';
  const list = VIDEO_LENGTHS.filter((l) => Number(l.value) <= maxSeconds);
  for (const l of list) {
    const opt = document.createElement('option');
    opt.value = l.value;
    opt.textContent = Number(l.value) === maxSeconds ? `${l.label} (max)` : l.label;
    els.length.appendChild(opt);
  }
  // Keep the previous choice if it's still valid for this model, else fall
  // back to the new max instead of silently resetting to 5s.
  if (list.some((l) => l.value === prevValue)) els.length.value = prevValue;
}

function selectedSpec() {
  const value = els.model.value;
  return currentModels().find((m) => m.value === value) || currentModels()[0];
}

/** The self-hosted video app's mode, or 'text' when the picker doesn't apply. */
function videoMode() {
  const spec = selectedSpec();
  if (kind !== 'video' || spec?.provider !== 'modal') return 'text';
  return els.videoMode.value || 'text';
}

function fillVideoModes() {
  const spec = selectedSpec();
  const modes = (kind === 'video' && spec?.modes) || ['text'];
  const prev = els.videoMode.value;
  els.videoMode.innerHTML = '';
  for (const m of modes) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = VIDEO_MODE_LABELS[m] || m;
    els.videoMode.appendChild(opt);
  }
  // Restyle and keyframes belong to different models, so a mode carried over
  // from the previous model is usually invalid — fall back rather than keep it.
  if (modes.includes(prev)) els.videoMode.value = prev;
}

/** The self-hosted image app's mode, or 'text' when the picker doesn't apply. */
function imageMode() {
  const spec = selectedSpec();
  if (kind !== 'image' || spec?.provider !== 'modal') return 'text';
  return els.mode.value || 'text';
}

function modelUsesRef(spec) {
  if (!spec) return false;
  if (spec.usesRef) return true;
  // Every self-hosted image mode except plain text-to-image works from a
  // source image the user supplies.
  if (imageMode() !== 'text') return true;
  return kind === 'video' && /i2v/i.test(spec.model || '');
}

function syncFields() {
  const spec = selectedSpec();
  // Always show negative prompt for images — never hide controls based on provider.
  els.negativeWrap.style.display = kind === 'image' ? '' : 'none';
  const usesRef = modelUsesRef(spec);
  // Only shown when the selected model actually consumes a reference image.
  els.refWrap.classList.toggle('hidden', !usesRef);
  const opt = els.refWrap.querySelector('.opt');
  if (opt) {
    // Name what the upload is actually for in this mode — "reference image"
    // means something different when outpainting than when matching a pose.
    opt.textContent =
      kind === 'video'
        ? '(required for image→video)'
        : {
            img2img: '(the image to restyle)',
            expand: '(the image to expand outward from)',
            pose: '(photo or stick figure to take the pose from)',
          }[imageMode()] || '(required for image→image)';
  }
  els.accessKeyWrap.classList.toggle('hidden', spec?.provider !== 'modal');
  // Batching is a self-hosted feature: it works by filling one GPU call, which
  // only applies to the Modal app. Hosted providers bill per image, so asking
  // for four there costs four times as much for no speed gain.
  const selfHostedImage = kind === 'image' && spec?.provider === 'modal';
  els.countWrap.classList.toggle('hidden', !selfHostedImage);
  els.modeWrap.classList.toggle('hidden', !selfHostedImage);

  // Each mode reveals only the controls it actually reads.
  const m = imageMode();
  const vm = videoMode();
  const selfHostedVideo = kind === 'video' && spec?.provider === 'modal';
  els.videoModeWrap.classList.toggle('hidden', !selfHostedVideo || (spec?.modes?.length || 1) < 2);
  els.srcVideoWrap.classList.toggle('hidden', vm !== 'restyle');
  els.keyframesWrap.classList.toggle('hidden', vm !== 'keyframes');
  // Length is chosen by the source clip when restyling, and by the last
  // keyframe when keyframing — neither reads the picker.
  els.lengthWrap.classList.toggle('hidden', kind !== 'video' || vm !== 'text');

  // Strength means "how far from the source" in both img2img and restyle.
  els.strengthWrap.classList.toggle('hidden', m !== 'img2img' && vm !== 'restyle');
  els.expandWrap.classList.toggle('hidden', m !== 'expand');
  els.poseWrap.classList.toggle('hidden', m !== 'pose');
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg || '';
  // Validation messages ("that clip is too big") read as failures, not
  // progress — they should not look like "Generating…".
  els.status.classList.toggle('is-error', !!msg && isError);
}

function loadImageElement(fileOrUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    if (typeof fileOrUrl === 'string') {
      img.src = fileOrUrl;
    } else {
      img.src = URL.createObjectURL(fileOrUrl);
    }
  });
}

function canvasToJpegDataUrl(canvas, quality) {
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Resize + JPEG-compress so reference uploads stay under Vercel’s 4.5MB body limit.
 */
async function compressImageFile(file) {
  const img = await loadImageElement(file);
  try {
    let scale = Math.min(1, REF_MAX_EDGE / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    let w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    let h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    let quality = 0.8;
    let dataUrl = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      dataUrl = canvasToJpegDataUrl(canvas, quality);
      if (dataUrl.length <= REF_MAX_BYTES) break;
      quality = Math.max(0.4, quality - 0.1);
      if (dataUrl.length > REF_MAX_BYTES) {
        w = Math.max(256, Math.round(w * 0.75));
        h = Math.max(256, Math.round(h * 0.75));
      }
    }
    if (dataUrl.length > REF_MAX_BYTES) {
      throw new Error('Image is still too large after compression (Vercel max ~3MB). Try a smaller photo.');
    }
    return { mimeType: 'image/jpeg', base64: dataUrl };
  } finally {
    if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  }
}

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    kind = tab.dataset.kind || 'image';
    els.tabs.forEach((t) => t.classList.toggle('active', t === tab));
    fillModels();
    fillSizes();
    fillLengths();
    fillVideoModes();
    syncFields();
  });
});

els.model.addEventListener('change', () => {
  fillLengths();
  fillVideoModes();
  syncFields();
});

// Switching mode changes which fields apply and whether a source is required.
els.mode.addEventListener('change', syncFields);
els.videoMode.addEventListener('change', syncFields);

// ---- Source video for restyling -----------------------------------------
els.srcVideo.addEventListener('change', async () => {
  const file = els.srcVideo.files?.[0];
  srcVideoData = null;
  if (!file) return;

  if (file.size > SRC_VIDEO_MAX_BYTES) {
    els.srcVideo.value = '';
    setStatus(
      `That clip is ${(file.size / 1_048_576).toFixed(1)}MB. The upload has to fit in a ` +
        `3MB request — try a few seconds at 480p.`,
      true,
    );
    return;
  }

  srcVideoData = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  if (srcVideoData) setStatus(`Loaded ${file.name} — its motion is kept, the look is replaced.`);
});

// ---- Timeline keyframes --------------------------------------------------
// Each row is one image pinned to a second in the clip. LTX invents the motion
// between them, so the rows are the whole point of the feature — kept as plain
// DOM rows rather than a canvas, since the data is just (image, time).
const MAX_KEYFRAMES = 4;
const keyframeState = [];

function renderKeyframeRows() {
  els.keyframeRows.innerHTML = '';
  keyframeState.forEach((kf, i) => {
    const row = document.createElement('div');
    row.className = 'keyframe-row';

    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        kf.image = (await compressImageFile(f)).base64;
      } catch (err) {
        kf.image = null;
        setStatus(err.message, true);
      }
    });

    const at = document.createElement('input');
    at.type = 'number';
    at.min = '0';
    at.step = '0.5';
    at.value = String(kf.at);
    at.title = 'Seconds into the clip';
    at.addEventListener('change', () => { kf.at = Math.max(0, Number(at.value) || 0); });

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'kf-drop';
    drop.textContent = '✕';
    drop.title = 'Remove this keyframe';
    drop.addEventListener('click', () => {
      keyframeState.splice(i, 1);
      renderKeyframeRows();
    });

    row.append(file, at, drop);
    els.keyframeRows.appendChild(row);
  });
  els.addKeyframe.disabled = keyframeState.length >= MAX_KEYFRAMES;
}

els.addKeyframe.addEventListener('click', () => {
  if (keyframeState.length >= MAX_KEYFRAMES) return;
  // Space new marks out rather than stacking them all on second 0.
  const last = keyframeState[keyframeState.length - 1];
  keyframeState.push({ image: null, at: last ? last.at + 2 : 0 });
  renderKeyframeRows();
});
renderKeyframeRows();

// ---- Cold-start warming --------------------------------------------------
// A Modal app that has scaled to zero spends ~60s loading weights before it
// generates anything. Firing that off when the prompt box is focused overlaps
// the load with the time someone spends typing, so the wait mostly disappears
// instead of landing on the Generate click.
//
// Fire-and-forget on purpose: the response is ignored, failures are silent,
// and a warm that does not land just means the generation pays the cold start
// it would have paid regardless. Only self-hosted models have a cold start,
// so hosted providers are skipped.
let warmedFor = null;

function warmSelectedModel() {
  const spec = selectedSpec();
  if (!spec || spec.provider !== 'modal') return;
  // Once per model per page load — refocusing the box must not re-ping.
  if (warmedFor === spec.value) return;
  warmedFor = spec.value;

  fetch(`/api/media-generate?op=warm&model=${encodeURIComponent(spec.model)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    keepalive: true,
  }).catch(() => {});
}

els.prompt.addEventListener('focus', warmSelectedModel);
// Switching model after focusing should warm the new one too.
els.model.addEventListener('change', () => {
  if (document.activeElement === els.prompt) warmSelectedModel();
});

// Remember the access key locally so friends don't retype it every visit.
try {
  const savedKey = localStorage.getItem('mediaAccessKey');
  if (savedKey) els.accessKey.value = savedKey;
} catch {}
els.accessKey.addEventListener('change', () => {
  try {
    localStorage.setItem('mediaAccessKey', els.accessKey.value.trim());
  } catch {}
});

els.ref.addEventListener('change', async () => {
  const file = els.ref.files?.[0];
  if (!file) {
    refData = null;
    els.refPreview.classList.add('hidden');
    els.refPreview.innerHTML = '';
    return;
  }
  if (file.size > 20_000_000) {
    alert('Image too large (max 20MB before compression)');
    els.ref.value = '';
    return;
  }
  try {
    setStatus('Compressing reference image…');
    refData = await compressImageFile(file);
    els.refPreview.classList.remove('hidden');
    els.refPreview.innerHTML = '';
    const img = document.createElement('img');
    img.src = refData.base64;
    img.alt = 'Reference';
    els.refPreview.appendChild(img);
    const spec = selectedSpec();
    if (kind === 'image' && refData && !modelUsesRef(spec)) {
      setStatus('Upload ready. Pick “Venice · Edit / Image→Image” to use this image.');
    } else {
      setStatus('');
    }
  } catch (err) {
    refData = null;
    els.ref.value = '';
    setStatus('');
    alert(err.message || 'Could not read image');
  }
});

function prependCard(node) {
  els.empty.classList.add('hidden');
  els.gallery.prepend(node);
}

function cardShell(metaLeft, metaRight) {
  const card = document.createElement('article');
  card.className = 'media-card';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const left = document.createElement('span');
  left.textContent = metaLeft;
  const right = document.createElement('span');
  if (typeof metaRight === 'string') right.textContent = metaRight;
  else if (metaRight) right.appendChild(metaRight);
  meta.appendChild(left);
  meta.appendChild(right);
  card.appendChild(meta);
  return { card, meta };
}

function friendlyHttpError(status, data) {
  if (status === 413 || status === 513 || data?.code === 'PAYLOAD_TOO_LARGE') {
    return (
      data?.error ||
      'Payload too large (HTTP 413). For image→image pick Venice · Edit and keep the JPEG small; clear the upload for text-to-image.'
    );
  }
  return data?.error || `HTTP ${status}`;
}

async function runSync(body) {
  const res = await fetch('/api/media-generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyHttpError(res.status, data));
  return data;
}

/** One blocking request, the way video worked before the job API existed.
 *  Bounded by the API's 800s function timeout, so long clips can still die
 *  here — which is exactly what the async route was built to fix. */
async function runSyncVideoFallback(body) {
  const seconds = Number(body.seconds) || 5;
  setStatus(
    `Generating… this Modal app has no job API yet, so it runs as one request ` +
      `(deploy modal/ to lift the limit). Leave this open.`,
  );
  if (seconds > 10) {
    setStatus(
      `Generating ${seconds}s as a single request — over ~10s this can hit the ` +
        `800s timeout. Deploy modal/ for long clips, or pick a shorter length.`,
    );
  }
  return runSync(body);
}

const POLL_MS = 5000;
/** Consecutive dropped polls before giving up. 24 x 5s = two minutes offline. */
const MAX_POLL_NETWORK_FAILURES = 24;
const PENDING_JOB_KEY = 'mediaPendingVideoJob';

function savePendingJob(job) {
  try { localStorage.setItem(PENDING_JOB_KEY, JSON.stringify(job)); } catch { /* private mode */ }
}

function clearPendingJob() {
  try { localStorage.removeItem(PENDING_JOB_KEY); } catch { /* private mode */ }
}

function readPendingJob() {
  try {
    const raw = localStorage.getItem(PENDING_JOB_KEY);
    if (!raw) return null;
    const job = JSON.parse(raw);
    // Modal drops uncollected results well before this; older is not worth offering.
    if (!job?.jobId || Date.now() - (job.startedAt || 0) > POLL_CEILING_MS) {
      clearPendingJob();
      return null;
    }
    return job;
  } catch {
    return null;
  }
}
// Ceiling matches the Modal apps' own 3600s timeout: past that the job is gone
// and there is nothing left to wait for.
const POLL_CEILING_MS = 3_600_000;

// The submit/result endpoints only exist on Modal apps deployed from modal/.
// Until those are deployed the apps expose `generate` alone, so the async
// route 404s and this falls back to the blocking one, which they do serve.
// Remembered per page load so the fallback costs one failed request, not one
// per generation.
let asyncVideoUnavailable = false;

async function runVideoJob(body) {
  if (asyncVideoUnavailable) return runSyncVideoFallback(body);

  const submitRes = await fetch('/api/media-generate?op=submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const job = await submitRes.json().catch(() => ({}));

  if (job.code === 'ASYNC_UNAVAILABLE') {
    asyncVideoUnavailable = true;
    return runSyncVideoFallback(body);
  }
  if (!submitRes.ok || !job.jobId) throw new Error(friendlyHttpError(submitRes.status, job));

  // Survives a reload: the clip keeps rendering on Modal whatever this page
  // does, so the id is worth more than the tab it was started in.
  savePendingJob({ jobId: job.jobId, model: body.model, startedAt: Date.now() });
  try {
    return await awaitVideoJob(job.jobId, body, Date.now());
  } finally {
    clearPendingJob();
  }
}

/** Poll one submitted job to completion. */
async function awaitVideoJob(jobId, body, started) {
  let networkFailures = 0;

  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    const elapsed = Math.round((Date.now() - started) / 1000);
    setStatus(`Generating… ${elapsed}s. Self-hosted video takes minutes; leave this open.`);

    // fetch REJECTS on a dropped connection - it does not return a response.
    // On mobile Safari a backgrounded tab does exactly that and reports
    // "Load failed", so an un-caught poll threw straight out of this loop and
    // abandoned a clip that was still rendering, and still billing. The job
    // lives on Modal; a failed poll says nothing about it.
    let out;
    try {
      const pollRes = await fetch('/api/media-generate?op=result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, model: body.model, accessKey: body.accessKey }),
      });
      out = await pollRes.json().catch(() => ({}));
      networkFailures = 0;
    } catch {
      networkFailures += 1;
      if (networkFailures >= MAX_POLL_NETWORK_FAILURES) {
        throw new Error(
          `Lost contact with the server for ${Math.round(
            (MAX_POLL_NETWORK_FAILURES * POLL_MS) / 1000,
          )}s. The clip may still be rendering — reload this page to pick it back up.`,
        );
      }
      setStatus(`Connection dropped (${networkFailures}) — still waiting, the clip keeps rendering…`);
      continue;
    }

    if (out.status === 'done') return out;
    // A transient poll failure is not a failed job — the generation is still
    // running on Modal. Only an explicit terminal status ends the wait.
    if (out.status && out.status !== 'running') {
      throw new Error(out.error || `Generation ${out.status}.`);
    }
    if (Date.now() - started > POLL_CEILING_MS) {
      throw new Error('Gave up waiting after an hour — the job outlived its Modal timeout.');
    }
  }
}

/** Render one finished clip. Shared by a live generation and a resumed one. */
function renderVideoResult(data) {
  if (data.fallbackNote) setStatus(data.fallbackNote);
  const open = document.createElement('a');
  open.href = data.videoUrl;
  if (String(data.videoUrl || '').startsWith('data:')) {
    open.download = `video-${Date.now()}.mp4`;
    open.textContent = 'Download';
  } else {
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open / download';
  }
  const { card } = cardShell(
    `${data.provider} · ${data.model}${data.fallbackFrom ? ' (fallback)' : ''}`,
    open,
  );
  const vid = document.createElement('video');
  vid.src = data.videoUrl;
  vid.controls = true;
  vid.playsInline = true;
  card.insertBefore(vid, card.firstChild);
  prependCard(card);
  if (data.billing) {
    setStatus(`Done. Charged $${data.billing.chargedUsd.toFixed(2)} · balance $${data.billing.balanceUsd.toFixed(2)}`);
  } else if (!data.fallbackNote) {
    setStatus('Done.');
  }
}

/**
 * Pick a clip back up after the page went away.
 *
 * A clip renders on Modal whatever this tab does: closing it, a phone
 * suspending it, or a reload does not stop the GPU. Without this the work was
 * paid for and then thrown away, which is what a "Load failed" at four
 * minutes actually cost.
 */
async function resumePendingVideoJob() {
  const pending = readPendingJob();
  if (!pending) return;

  const waited = Math.round((Date.now() - pending.startedAt) / 1000);
  setStatus(`Picking up a clip started ${waited}s ago…`);
  try {
    const out = await awaitVideoJob(
      pending.jobId,
      { model: pending.model, accessKey: (els.accessKey.value || '').trim() },
      pending.startedAt,
    );
    clearPendingJob();
    renderVideoResult(out);
  } catch (err) {
    clearPendingJob();
    setStatus(`Could not pick that clip back up: ${err.message || err}`, true);
  }
}

els.generate.addEventListener('click', async () => {
  const prompt = (els.prompt.value || '').trim();
  if (!prompt) {
    alert('Enter a prompt.');
    els.prompt.focus();
    return;
  }
  const spec = selectedSpec();
  const usesRef = modelUsesRef(spec);

  if (usesRef && !refData) {
    alert(kind === 'image' ? 'Venice · Edit needs an uploaded image.' : 'Image → Video needs a reference image.');
    return;
  }

  els.generate.disabled = true;
  els.generate.textContent = 'Generating…';
  setStatus(kind === 'video' ? 'Generating video (can take a few minutes)…' : 'Generating…');

  try {
    const body = {
      kind,
      provider: spec.provider,
      model: spec.model,
      prompt,
      size: els.size.value,
    };
    const neg = (els.negative.value || '').trim();
    if (neg && kind === 'image') {
      body.negativePrompt = neg;
    }
    if (kind === 'image' && spec.provider === 'modal') {
      body.count = Number(els.count.value) || 1;
      const m = imageMode();
      body.mode = m;
      if (m === 'img2img') {
        body.strength = (Number(els.strength.value) || 35) / 100;
      } else if (m === 'expand') {
        const [px, dir] = String(els.expand.value).split(':');
        const n = Number(px) || 256;
        body.expand = {
          left: dir === 'tall' ? 0 : n,
          right: dir === 'tall' ? 0 : n,
          top: dir === 'wide' ? 0 : n,
          bottom: dir === 'wide' ? 0 : n,
        };
      } else if (m === 'pose') {
        body.detectPose = els.poseSource.value === 'detect';
        body.controlScale = 0.8;
      }
    }
    if (kind === 'video') {
      body.seconds = Number(els.length.value) || 5;
      const vm = videoMode();
      if (vm === 'restyle') {
        if (!srcVideoData) throw new Error('Pick a source video to restyle.');
        body.video = srcVideoData;
        body.strength = (Number(els.strength.value) || 60) / 100;
      } else if (vm === 'keyframes') {
        // Frame index, not seconds: the app works in frames, and LTX runs at
        // 24fps. Doing the conversion here keeps the app's contract numeric.
        const ready = keyframeState.filter((kf) => kf.image);
        if (!ready.length) throw new Error('Add at least one keyframe with an image.');
        body.keyframes = ready.map((kf) => ({
          image: kf.image,
          frame: Math.round(kf.at * 24),
          strength: 1.0,
        }));
      }
    }
    if (spec.provider === 'modal') {
      body.accessKey = (els.accessKey.value || '').trim();
    }
    // ONLY attach the upload when the selected model actually uses it.
    // Sending it on text-to-image is what caused HTTP 413.
    if (refData && usesRef) {
      body.imageBase64 = refData.base64;
      body.mimeType = refData.mimeType;
    }

    // Self-hosted video goes through the async job API. One blocking request
    // would be bounded by the API's 800s function timeout, which is what caps
    // clip length — polling moves the ceiling to the Modal app's own timeout
    // and lets the UI show progress instead of hanging.
    const data =
      kind === 'video' && spec.provider === 'modal'
        ? await runVideoJob(body)
        : await runSync(body);

    if (data.kind === 'image') {
      if (data.note) setStatus(data.note);
      else if (data.fallbackNote) setStatus(data.fallbackNote);
      else setStatus('Done.');
      for (const img of data.images || []) {
        const { card, meta } = cardShell(
          `${data.provider} · ${data.model}${data.uncensored === false ? '' : data.provider === 'venice' ? ' · uncensored' : ''}${data.fallbackFrom ? ' (fallback)' : ''}`,
          new Date().toLocaleTimeString(),
        );
        const el = document.createElement('img');
        if (img.url) {
          el.src = img.url;
          const a = document.createElement('a');
          a.href = img.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = 'Open';
          meta.lastChild.replaceWith(a);
        } else if (img.base64) {
          el.src = `data:${img.mimeType || 'image/webp'};base64,${img.base64}`;
          const a = document.createElement('a');
          a.href = el.src;
          a.download = `media-${Date.now()}.webp`;
          a.textContent = 'Download';
          meta.lastChild.replaceWith(a);
        }
        card.insertBefore(el, card.firstChild);
        prependCard(card);
      }
      if (!data.note && !data.fallbackNote) setStatus('Done.');
    } else if (data.kind === 'video') {
      renderVideoResult(data);
    } else {
      // "Unexpected response" alone gives nothing to act on. The keys say
      // whether this is an error body, a stale API shape, or a cached client
      // talking to a newer server.
      const keys = Object.keys(data || {}).join(', ') || '(empty body)';
      setStatus(
        `Unexpected response — kind=${data?.kind ?? 'missing'}; keys: ${keys}` +
          (data?.error ? ` — ${data.error}` : ''),
        true,
      );
      console.error('media-generate returned:', data);
    }
  } catch (err) {
    console.error(err);
    setStatus('');
    alert(String(err.message || 'Generation failed').replace(/^(AIError:\s*)+/gi, ''));
  } finally {
    els.generate.disabled = false;
    els.generate.textContent = 'Generate';
  }
});

fillModels();
fillSizes();
fillLengths();
fillVideoModes();
syncFields();
void resumePendingVideoJob();
