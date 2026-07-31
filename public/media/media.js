const IMAGE_MODELS = [
  { value: 'venice:z-image-turbo', label: 'Venice · Z-Image Turbo (uncensored)', kind: 'image', provider: 'venice', model: 'z-image-turbo' },
  { value: 'venice:lustify-sdxl', label: 'Venice · Lustify SDXL (uncensored)', kind: 'image', provider: 'venice', model: 'lustify-sdxl' },
  { value: 'venice:lustify-v8', label: 'Venice · Lustify v8 (uncensored)', kind: 'image', provider: 'venice', model: 'lustify-v8' },
  { value: 'venice:wai-Illustrious', label: 'Venice · Anime WAI (uncensored)', kind: 'image', provider: 'venice', model: 'wai-Illustrious' },
  { value: 'venice:chroma', label: 'Venice · Chroma (uncensored)', kind: 'image', provider: 'venice', model: 'chroma' },
  { value: 'venice:venice-sd35', label: 'Venice · SD3.5 (uncensored)', kind: 'image', provider: 'venice', model: 'venice-sd35' },
  { value: 'venice:flux-2-pro', label: 'Venice · Flux 2 Pro (uncensored)', kind: 'image', provider: 'venice', model: 'flux-2-pro' },
  { value: 'venice:qwen-image', label: 'Venice · Qwen Image (uncensored)', kind: 'image', provider: 'venice', model: 'qwen-image' },
  { value: 'cloudflare:flux-schnell', label: 'Cloudflare · FLUX.1 Schnell (filtered)', kind: 'image', provider: 'cloudflare', model: 'flux-schnell' },
  { value: 'cloudflare:sdxl-lightning', label: 'Cloudflare · SDXL Lightning (filtered)', kind: 'image', provider: 'cloudflare', model: 'sdxl-lightning' },
  { value: 'cloudflare:sdxl', label: 'Cloudflare · SDXL Base (filtered)', kind: 'image', provider: 'cloudflare', model: 'sdxl' },
  { value: 'nvidia:flux-schnell', label: 'NVIDIA · FLUX.1 Schnell (filtered)', kind: 'image', provider: 'nvidia', model: 'flux-schnell' },
  { value: 'nvidia:sdxl', label: 'NVIDIA · SDXL (filtered)', kind: 'image', provider: 'nvidia', model: 'sdxl' },
  { value: 'nvidia:qwen-image', label: 'NVIDIA · Qwen Image (filtered)', kind: 'image', provider: 'nvidia', model: 'qwen-image' },
];

const VIDEO_MODELS = [
  { value: 'fal:wan2.2-t2v', label: 'Wan 2.2 · Text → Video (fal.ai)', kind: 'video', provider: 'fal', model: 'wan2.2-t2v' },
  { value: 'fal:wan2.2-i2v', label: 'Wan 2.2 · Image → Video (fal.ai)', kind: 'video', provider: 'fal', model: 'wan2.2-i2v' },
  { value: 'nvidia:wan2.2-t2v', label: 'NVIDIA · Wan 2.2 · Text → Video', kind: 'video', provider: 'nvidia', model: 'wan2.2-t2v' },
  { value: 'nvidia:wan2.2-i2v', label: 'NVIDIA · Wan 2.2 · Image → Video', kind: 'video', provider: 'nvidia', model: 'wan2.2-i2v' },
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
  // Always show negative prompt for images — never hide controls based on provider.
  els.negativeWrap.style.display = kind === 'image' ? '' : 'none';
  const i2v = kind === 'video' && (/i2v/i.test(spec?.model || '') || /wan2\.2-i2v/i.test(spec?.value || ''));
  const opt = els.refWrap.querySelector('.opt');
  if (opt) opt.textContent = i2v ? '(required for image→video)' : '(optional · image→video)';
}

function setStatus(msg) {
  els.status.textContent = msg || '';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Failed to read image'));
    r.readAsDataURL(file);
  });
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
  if (file.size > 8_000_000) {
    alert('Image too large (max 8MB)');
    els.ref.value = '';
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    refData = { mimeType: m?.[1] || file.type || 'image/png', base64: dataUrl };
    els.refPreview.classList.remove('hidden');
    els.refPreview.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = 'Reference';
    els.refPreview.appendChild(img);
  } catch (err) {
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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

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
        if (img.base64) {
          el.src = `data:${img.mimeType || 'image/png'};base64,${img.base64}`;
          const a = document.createElement('a');
          a.href = el.src;
          a.download = `media-${Date.now()}.png`;
          a.textContent = 'Download';
          meta.lastChild.replaceWith(a);
        } else if (img.url) {
          el.src = img.url;
          const a = document.createElement('a');
          a.href = img.url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = 'Open';
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
    alert(String(err.message || 'Generation failed').replace(/^(AIError:\s*)+/gi, ''));
  } finally {
    els.generate.disabled = false;
    els.generate.textContent = 'Generate';
  }
});

fillModels();
fillSizes();
syncFields();
