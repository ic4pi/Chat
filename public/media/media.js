const IMAGE_MODELS = [
  { value: 'modal:lustify', label: 'Realistic · Text → Image (self-hosted)', kind: 'image', provider: 'modal', model: 'lustify', usesRef: false },
  { value: 'modal:wai-illustrious', label: 'Anime · Text → Image (self-hosted)', kind: 'image', provider: 'modal', model: 'wai-illustrious', usesRef: false },
  { value: 'cloudflare:flux-schnell', label: 'Cloudflare · FLUX.1 Schnell (free, filtered)', kind: 'image', provider: 'cloudflare', model: 'flux-schnell', usesRef: false },
  { value: 'cloudflare:sdxl-lightning', label: 'Cloudflare · SDXL Lightning (free, filtered)', kind: 'image', provider: 'cloudflare', model: 'sdxl-lightning', usesRef: false },
  { value: 'cloudflare:sdxl', label: 'Cloudflare · SDXL Base (free, filtered)', kind: 'image', provider: 'cloudflare', model: 'sdxl', usesRef: false },
];

// maxSeconds is a per-model safety cap on the Length picker, not a stylistic
// choice - measured live against the deployed site (not just Modal directly):
// a single 5s Wan clip at real settings (40 steps, 832x480) took 6m20s end to
// end, so 4 chained clips would run ~25min, way past Vercel's 800s function
// timeout - the request would die with the GPU time already spent and nothing
// delivered. LTX at 30 steps did the same job in ~2min, so it can safely go
// up to the Modal endpoint's own 6-clip/30s cap.
const VIDEO_MODELS = [
  { value: 'modal:wan2.2-5b', label: 'Wan 2.2 5B · Text → Video (self-hosted, slow)', kind: 'video', provider: 'modal', model: 'wan2.2-5b', usesRef: false, maxSeconds: 5 },
  { value: 'modal:ltx-video', label: 'LTX-Video · Text → Video (self-hosted, fast)', kind: 'video', provider: 'modal', model: 'ltx-video', usesRef: false, maxSeconds: 30 },
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

function modelUsesRef(spec) {
  if (!spec) return false;
  if (spec.usesRef) return true;
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
    opt.textContent = kind === 'image' ? '(required for image→image)' : '(required for image→video)';
  }
  els.accessKeyWrap.classList.toggle('hidden', spec?.provider !== 'modal');
  els.lengthWrap.classList.toggle('hidden', kind !== 'video');
}

function setStatus(msg) {
  els.status.textContent = msg || '';
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
    syncFields();
  });
});

els.model.addEventListener('change', () => {
  fillLengths();
  syncFields();
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
    if (kind === 'video') {
      body.seconds = Number(els.length.value) || 5;
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

    const res = await fetch('/api/media-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(friendlyHttpError(res.status, data));

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
    } else {
      setStatus('Unexpected response.');
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
syncFields();
