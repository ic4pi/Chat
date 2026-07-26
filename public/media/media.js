const IMAGE_MODELS = [
  { value: 'gemini:nano-banana', label: 'Gemini · Nano Banana (free tier)', kind: 'image', provider: 'gemini', model: 'nano-banana' },
  { value: 'nvidia:qwen-image', label: 'NVIDIA · Qwen Image', kind: 'image', provider: 'nvidia', model: 'qwen-image' },
];

const VIDEO_MODELS = [
  { value: 'nvidia:wan2.2-t2v', label: 'NVIDIA · Wan 2.2 · Text → Video', kind: 'video', provider: 'nvidia', model: 'wan2.2-t2v' },
  { value: 'nvidia:wan2.2-i2v', label: 'NVIDIA · Wan 2.2 · Image → Video', kind: 'video', provider: 'nvidia', model: 'wan2.2-i2v' },
];

const IMAGE_SIZES = [
  { value: '1024x1024', label: '1024 × 1024' },
  { value: '1280x720', label: '1280 × 720' },
  { value: '720x1280', label: '720 × 1280' },
];

const VIDEO_SIZES = [
  { value: '832x480', label: '480p · 832×480' },
  { value: '480x832', label: 'Portrait · 480×832' },
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
  const nvidiaImage = kind === 'image' && spec?.provider === 'nvidia';
  const i2v = kind === 'video' && /i2v/i.test(spec?.model || '');
  els.negativeWrap.style.display = nvidiaImage ? '' : 'none';
  els.refWrap.querySelector('.opt').textContent = i2v
    ? '(required for image→video)'
    : '(optional)';
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
  if (kind === 'video' && /i2v/i.test(spec.model) && !refData) {
    alert('Image → Video needs a reference image.');
    return;
  }

  els.generate.disabled = true;
  setStatus(kind === 'video' ? 'Generating video (can take a few minutes)…' : 'Generating…');

  try {
    const body = {
      kind,
      provider: spec.provider,
      model: spec.model,
      prompt,
      size: els.size.value,
    };
    if (spec.provider === 'nvidia' && kind === 'image') {
      const neg = (els.negative.value || '').trim();
      if (neg) body.negativePrompt = neg;
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
      for (const img of data.images || []) {
        const { card, meta } = cardShell(
          `${data.provider} · ${data.model}`,
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
      setStatus('Done.');
    } else if (data.kind === 'video') {
      const open = document.createElement('a');
      open.href = data.videoUrl;
      if (String(data.videoUrl || '').startsWith('data:')) {
        open.download = `wan-${Date.now()}.mp4`;
        open.textContent = 'Download';
      } else {
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = 'Open / download';
      }
      const { card } = cardShell(`${data.provider} · ${data.model}`, open);
      const vid = document.createElement('video');
      vid.src = data.videoUrl;
      vid.controls = true;
      vid.playsInline = true;
      card.insertBefore(vid, card.firstChild);
      prependCard(card);
      setStatus('Done.');
    } else {
      setStatus('Unexpected response.');
    }
  } catch (err) {
    console.error(err);
    setStatus('');
    alert(err.message || 'Generation failed');
  } finally {
    els.generate.disabled = false;
  }
});

fillModels();
fillSizes();
syncFields();
