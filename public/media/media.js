// `best: true` models are the curated default set shown until "Show all
// models" is turned on. Order matters — the first best-flagged entry per
// kind becomes the pre-selected option, so lead with a plain text-to-X model
// (not one that requires a reference image) for a friction-free default.
const IMAGE_MODELS = [
  { value: 'venice:z-image-turbo', label: 'Venice · Z-Image Turbo (uncensored)', kind: 'image', provider: 'venice', model: 'z-image-turbo', usesRef: false, best: true, note: 'Fast, high quality, uncensored — the default for most prompts.' },
  { value: 'venice:flux-2-pro', label: 'Venice · Flux 2 Pro (uncensored)', kind: 'image', provider: 'venice', model: 'flux-2-pro', usesRef: false, best: true, note: 'Best overall image quality (uncensored); slower than Z-Image Turbo.' },
  { value: 'venice:qwen-edit', label: 'Venice · Edit / Image→Image (uncensored)', kind: 'image', provider: 'venice', model: 'qwen-edit', usesRef: true, best: true, note: 'Required for editing an uploaded reference image.' },
  { value: 'cloudflare:flux-schnell', label: 'Cloudflare · FLUX.1 Schnell (filtered)', kind: 'image', provider: 'cloudflare', model: 'flux-schnell', usesRef: false, best: true, note: 'Free-tier fallback if you don’t have a Venice key (safety-filtered).' },
  { value: 'venice:lustify-sdxl', label: 'Venice · Lustify SDXL (uncensored)', kind: 'image', provider: 'venice', model: 'lustify-sdxl', usesRef: false, note: 'NSFW-leaning fine-tune.' },
  { value: 'venice:lustify-v8', label: 'Venice · Lustify v8 (uncensored)', kind: 'image', provider: 'venice', model: 'lustify-v8', usesRef: false, note: 'Newer Lustify fine-tune.' },
  { value: 'venice:wai-Illustrious', label: 'Venice · Anime WAI (uncensored)', kind: 'image', provider: 'venice', model: 'wai-Illustrious', usesRef: false, note: 'Anime / illustration style.' },
  { value: 'venice:chroma', label: 'Venice · Chroma (uncensored)', kind: 'image', provider: 'venice', model: 'chroma', usesRef: false, note: 'Stylized, high-contrast look.' },
  { value: 'venice:venice-sd35', label: 'Venice · SD3.5 (uncensored)', kind: 'image', provider: 'venice', model: 'venice-sd35', usesRef: false, note: 'Stable Diffusion 3.5.' },
  { value: 'venice:qwen-image', label: 'Venice · Qwen Image (uncensored)', kind: 'image', provider: 'venice', model: 'qwen-image', usesRef: false, note: 'Qwen’s text-to-image model.' },
  { value: 'cloudflare:sdxl-lightning', label: 'Cloudflare · SDXL Lightning (filtered)', kind: 'image', provider: 'cloudflare', model: 'sdxl-lightning', usesRef: false, note: '4-step fast SDXL, safety-filtered.' },
  { value: 'cloudflare:sdxl', label: 'Cloudflare · SDXL Base (filtered)', kind: 'image', provider: 'cloudflare', model: 'sdxl', usesRef: false, note: 'Standard SDXL, safety-filtered.' },
  { value: 'nvidia:flux-schnell', label: 'NVIDIA · FLUX.1 Schnell (filtered)', kind: 'image', provider: 'nvidia', model: 'flux-schnell', usesRef: false, note: 'Hosted FLUX Schnell, safety-filtered.' },
  { value: 'nvidia:sdxl', label: 'NVIDIA · SDXL (filtered)', kind: 'image', provider: 'nvidia', model: 'sdxl', usesRef: false, note: 'Hosted SDXL, safety-filtered.' },
  { value: 'nvidia:qwen-image', label: 'NVIDIA · Qwen Image (filtered)', kind: 'image', provider: 'nvidia', model: 'qwen-image', usesRef: false, note: 'Hosted Qwen Image, safety-filtered.' },
];

const VIDEO_MODELS = [
  { value: 'cloudflare:seedance-fast', label: 'Cloudflare · Seedance 2.0 Fast', kind: 'video', provider: 'cloudflare', model: 'seedance-fast', usesRef: false, best: true, note: 'Fast, hosted — the default for video.' },
  { value: 'cloudflare:seedance-mini', label: 'Cloudflare · Seedance 2.0 Mini', kind: 'video', provider: 'cloudflare', model: 'seedance-mini', usesRef: false, note: 'Smaller/cheaper Seedance variant.' },
  { value: 'nvidia:wan2.2-t2v', label: 'NVIDIA · Wan 2.2 · Text → Video', kind: 'video', provider: 'nvidia', model: 'wan2.2-t2v', usesRef: false, best: true, note: 'Self-hosted Wan NIM (NVIDIA_MEDIA_BASE_URL) — no third-party hosting.' },
  { value: 'nvidia:wan2.2-i2v', label: 'NVIDIA · Wan 2.2 · Image → Video', kind: 'video', provider: 'nvidia', model: 'wan2.2-i2v', usesRef: true, best: true, note: 'Self-hosted Wan NIM (NVIDIA_MEDIA_BASE_URL) — no third-party hosting.' },
];

const MEDIA_SHOW_ALL_STORAGE = 'uncensored_media_show_all_v1';
function loadShowAllModels() {
  try { return localStorage.getItem(MEDIA_SHOW_ALL_STORAGE) === '1'; } catch { return false; }
}
function saveShowAllModels(v) {
  try { localStorage.setItem(MEDIA_SHOW_ALL_STORAGE, v ? '1' : '0'); } catch { /* ignore */ }
}
let showAllModels = loadShowAllModels();

const IMAGE_SIZES = [
  { value: '1024x1024', label: '1024 × 1024' },
  { value: '1280x720', label: '1280 × 720' },
  { value: '720x1280', label: '720 × 1280' },
];

const VIDEO_SIZES = [
  { value: '832x480', label: 'Landscape · 16:9' },
  { value: '480x832', label: 'Portrait · 9:16' },
];

/** Vercel Functions reject bodies over 4.5MB (HTTP 413). Keep refs well under. */
const REF_MAX_EDGE = 1024;
const REF_MAX_BYTES = 1_200_000;

const els = {
  tabs: [...document.querySelectorAll('.media-tab')],
  model: document.getElementById('mediaModel'),
  modelNote: document.getElementById('mediaModelNote'),
  showAll: document.getElementById('mediaShowAll'),
  prompt: document.getElementById('mediaPrompt'),
  negative: document.getElementById('mediaNegative'),
  negativeWrap: document.getElementById('negativeWrap'),
  size: document.getElementById('mediaSize'),
  sizeWrap: document.getElementById('sizeWrap'),
  ref: document.getElementById('mediaRef'),
  refWrap: document.getElementById('refWrap'),
  refPreview: document.getElementById('refPreview'),
  generate: document.getElementById('mediaGenerate'),
  status: document.getElementById('mediaStatus'),
  gallery: document.getElementById('mediaGallery'),
  empty: document.getElementById('mediaEmpty'),
};

let kind = 'image';
let refData = null; // { base64, mimeType }

function allModelsForKind() {
  return kind === 'video' ? VIDEO_MODELS : IMAGE_MODELS;
}

/** The curated set unless "Show all models" is on. */
function currentModels() {
  const all = allModelsForKind();
  if (showAllModels) return all;
  const best = all.filter((m) => m.best);
  return best.length ? best : all;
}

function fillModels() {
  const list = currentModels();
  const prevValue = els.model.value;
  els.model.innerHTML = '';
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    els.model.appendChild(opt);
  }
  // Keep the current pick if it's still in the (possibly narrowed) list.
  if (prevValue && list.some((m) => m.value === prevValue)) els.model.value = prevValue;
  updateModelNote();
}

function updateModelNote() {
  if (!els.modelNote) return;
  const spec = selectedSpec();
  els.modelNote.textContent = spec?.note || '';
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
  updateModelNote();
  const spec = selectedSpec();
  // Always show negative prompt for images — never hide controls based on provider.
  els.negativeWrap.style.display = kind === 'image' ? '' : 'none';
  const usesRef = modelUsesRef(spec);
  const opt = els.refWrap.querySelector('.opt');
  if (opt) {
    if (kind === 'image' && usesRef) opt.textContent = '(required for Edit / image→image)';
    else if (kind === 'image') opt.textContent = '(only for Venice · Edit — ignored otherwise)';
    else if (usesRef) opt.textContent = '(required for image→video)';
    else opt.textContent = '(optional · image→video)';
  }
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
    syncFields();
  });
});

els.model.addEventListener('change', syncFields);

if (els.showAll) {
  els.showAll.checked = showAllModels;
  els.showAll.addEventListener('change', () => {
    showAllModels = !!els.showAll.checked;
    saveShowAllModels(showAllModels);
    fillModels();
    syncFields();
  });
}

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
      vid.addEventListener('error', () => {
        const code = vid.error?.code;
        const codeName = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' }[code] || code;
        console.error('Video failed to load:', {
          codeName,
          message: vid.error?.message,
          provider: data.provider,
          model: data.model,
          urlPrefix: String(data.videoUrl || '').slice(0, 80),
        });
        setStatus(`Video failed to load (${codeName}) — the ${data.provider} URL may be broken or expired. Check console for details.`);
      });
      card.insertBefore(vid, card.firstChild);
      prependCard(card);
      if (!data.fallbackNote) setStatus('Done.');
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
syncFields();
