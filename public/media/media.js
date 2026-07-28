const IMAGE_MODELS = [
  // fal returns HTTPS URLs — safe under Vercel’s 4.5MB limit (no HTTP 413).
  { value: 'fal:flux-schnell', label: 'fal · FLUX.1 Schnell (recommended)', kind: 'image', provider: 'fal', model: 'flux-schnell' },
  { value: 'fal:flux-dev', label: 'fal · FLUX.1 Dev', kind: 'image', provider: 'fal', model: 'flux-dev' },
  { value: 'fal:fast-sdxl', label: 'fal · Fast SDXL', kind: 'image', provider: 'fal', model: 'fast-sdxl' },
  // Cloudflare kept — auto-falls back to fal if the PNG/JPEG would 413.
  { value: 'cloudflare:flux-schnell', label: 'Cloudflare · FLUX.1 Schnell', kind: 'image', provider: 'cloudflare', model: 'flux-schnell' },
  { value: 'cloudflare:sdxl-lightning', label: 'Cloudflare · SDXL Lightning', kind: 'image', provider: 'cloudflare', model: 'sdxl-lightning' },
  { value: 'cloudflare:sdxl', label: 'Cloudflare · SDXL Base', kind: 'image', provider: 'cloudflare', model: 'sdxl' },
  // Keep NVIDIA in the list (strict safety filter; not deleted).
  { value: 'nvidia:flux-schnell', label: 'NVIDIA · FLUX.1 Schnell (strict filter)', kind: 'image', provider: 'nvidia', model: 'flux-schnell' },
  { value: 'nvidia:sdxl', label: 'NVIDIA · SDXL (strict filter)', kind: 'image', provider: 'nvidia', model: 'sdxl' },
];

const VIDEO_MODELS = [
  { value: 'fal:ltx-video', label: 'fal · LTX Video (fast / cheap)', kind: 'video', provider: 'fal', model: 'ltx-video' },
  { value: 'fal:wan2.2-t2v', label: 'fal · Wan 2.2 Text → Video', kind: 'video', provider: 'fal', model: 'wan2.2-t2v' },
  { value: 'fal:wan2.2-i2v', label: 'fal · Wan 2.2 Image → Video', kind: 'video', provider: 'fal', model: 'wan2.2-i2v' },
  { value: 'cloudflare:seedance-mini', label: 'Cloudflare · Seedance 2.0 Mini', kind: 'video', provider: 'cloudflare', model: 'seedance-mini' },
  { value: 'cloudflare:seedance-fast', label: 'Cloudflare · Seedance 2.0 Fast', kind: 'video', provider: 'cloudflare', model: 'seedance-fast' },
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

/** Vercel Functions reject bodies over 4.5MB (HTTP 413). Keep refs well under. */
const REF_MAX_EDGE = 1280;
const REF_MAX_BYTES = 2_200_000;

const els = {
  tabs: [...document.querySelectorAll('.media-tab')],
  model: document.getElementById('mediaModel'),
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

function selectedSpec() {
  const value = els.model.value;
  return currentModels().find((m) => m.value === value) || currentModels()[0];
}

function syncFields() {
  const spec = selectedSpec();
  // Always show negative prompt for images — never hide by provider.
  els.negativeWrap.style.display = kind === 'image' ? '' : 'none';
  const i2v = kind === 'video' && (/i2v/i.test(spec?.model || '') || /wan2\.2-i2v/i.test(spec?.value || ''));
  const opt = els.refWrap.querySelector('.opt');
  if (opt) opt.textContent = i2v ? '(required for image→video)' : '(optional · image→video)';
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
    const scale = Math.min(1, REF_MAX_EDGE / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    let quality = 0.85;
    let dataUrl = canvasToJpegDataUrl(canvas, quality);
    while (dataUrl.length > REF_MAX_BYTES && quality > 0.45) {
      quality -= 0.1;
      dataUrl = canvasToJpegDataUrl(canvas, quality);
    }
    if (dataUrl.length > REF_MAX_BYTES) {
      // Last resort: shrink further.
      canvas.width = Math.max(1, Math.round(w * 0.7));
      canvas.height = Math.max(1, Math.round(h * 0.7));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      dataUrl = canvasToJpegDataUrl(canvas, 0.7);
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
    setStatus('');
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
  if (status === 413 || data?.code === 'PAYLOAD_TOO_LARGE') {
    return (
      data?.error ||
      'Payload too large (HTTP 413). Vercel caps bodies at 4.5MB — pick fal · FLUX (URL) or a smaller size/reference.'
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
  if (kind === 'video' && /i2v/i.test(spec?.model || '') && !refData) {
    alert('Image → Video needs a reference image.');
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
    if (refData) {
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
      if (data.fallbackNote) {
        setStatus(data.fallbackNote);
      } else {
        setStatus('Done.');
      }
      for (const img of data.images || []) {
        const { card, meta } = cardShell(
          `${data.provider} · ${data.model}${data.fallbackFrom ? ' (fallback)' : ''}`,
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
          el.src = `data:${img.mimeType || 'image/png'};base64,${img.base64}`;
          const a = document.createElement('a');
          a.href = el.src;
          a.download = `media-${Date.now()}.jpg`;
          a.textContent = 'Download';
          meta.lastChild.replaceWith(a);
        }
        card.insertBefore(el, card.firstChild);
        prependCard(card);
      }
      if (!data.fallbackNote) setStatus('Done.');
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
      if (!data.fallbackNote) setStatus('Done.');
    } else {
      setStatus('Unexpected response.');
    }
  } catch (err) {
    console.error(err);
    setStatus('');
    const msg = String(err.message || 'Generation failed').replace(/^(AIError:\s*)+/gi, '');
    alert(msg);
  } finally {
    els.generate.disabled = false;
    els.generate.textContent = 'Generate';
  }
});

fillModels();
fillSizes();
syncFields();
