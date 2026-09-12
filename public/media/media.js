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
// A14B is single-clip only — T2V-A14B and I2V-A14B are separate 14B models and
// holding both resident for chaining would need ~110GB of VRAM, so its app has
// no num_clips at all. Longer than 5s there means more frames in one pass
// instead of chained clips - slower per second and past the model's own ~5s
// training length, so untested for coherence beyond that. maxSeconds 20 is a
// cautious ceiling, not a measured one; dial it back if quality falls apart.
const VIDEO_MODELS = [
  { value: 'modal:wan2.2-5b', label: 'Wan 2.2 5B · Text → Video (self-hosted, A10G)', kind: 'video', provider: 'modal', model: 'wan2.2-5b', fps: 16, usesRef: false, maxSeconds: 30, modes: ['text', 'image', 'keyframes', 'restyle'] },
  { value: 'modal:wan2.2-a14b', label: 'Wan 2.2 A14B · NSFW · Text → Video (best quality, single pass, A100)', kind: 'video', provider: 'modal', model: 'wan2.2-a14b', fps: 16, usesRef: false, maxSeconds: 20, modes: ['text'] },
  { value: 'modal:ltx-video', label: 'LTX-Video · Text → Video (self-hosted, fast)', kind: 'video', provider: 'modal', model: 'ltx-video', fps: 24, usesRef: false, maxSeconds: 30, modes: ['text', 'image', 'keyframes'] },
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
  character: document.getElementById('mediaCharacter'),
  characterWrap: document.getElementById('characterWrap'),
  charEditor: document.getElementById('charEditor'),
  charEdit: document.getElementById('charEdit'),
  charNew: document.getElementById('charNew'),
  charName: document.getElementById('charName'),
  charLook: document.getElementById('charLook'),
  charStyle: document.getElementById('charStyle'),
  charSeed: document.getElementById('charSeed'),
  charSave: document.getElementById('charSave'),
  charDelete: document.getElementById('charDelete'),
  charReseed: document.getElementById('charReseed'),
  charImage: document.getElementById('charImage'),
  charImageState: document.getElementById('charImageState'),
  charImagePreview: document.getElementById('charImagePreview'),
  charVoice: document.getElementById('charVoice'),
  charVoiceState: document.getElementById('charVoiceState'),
  dialogue: document.getElementById('mediaDialogue'),
  dialogueWrap: document.getElementById('dialogueWrap'),
  dialogueState: document.getElementById('dialogueState'),
  speakBtn: document.getElementById('speakBtn'),
  audio: document.getElementById('mediaAudio'),
  audioWrap: document.getElementById('audioWrap'),
  series: document.getElementById('mediaSeries'),
  seriesWrap: document.getElementById('seriesWrap'),
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
let audioData = null; // base64 data URL of an audio track to lay over the result
let pendingVoice = null; // voice sample staged in the character editor, saved with it
let pendingImage = null; // reference image staged the same way

const VIDEO_MODE_LABELS = {
  text: 'Text → Video',
  image: 'Start from an image',
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
  if (kind === 'image' && imageMode() !== 'text') return true;
  // In video, the upload is the first frame the clip grows out of.
  return kind === 'video' && videoMode() === 'image';
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
  // Never hidden any more. It used to follow the main picker, but every stage
  // of the episode pipeline is self-hosted — stills, clips, voice and assembly
  // are all Modal — so hiding the key because the picker happens to sit on
  // Cloudflare left no way to type the one thing an episode needs.
  els.accessKeyWrap.classList.remove('hidden');
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
  els.lengthWrap.classList.toggle('hidden', kind !== 'video' || (vm !== 'text' && vm !== 'image'));

  // Strength means "how far from the source" in both img2img and restyle.
  // A shot list only makes sense for plain text/image video — restyle takes
  // its length and subject from the source clip, and keyframes pin it to
  // supplied images, so neither can run a list of shots.
  const seriesable = selfHostedVideo && (vm === 'text' || vm === 'image');
  els.audioWrap.classList.toggle('hidden', !selfHostedVideo);
  // The character is never hidden: a saved character is injected into every
  // generation, in every mode and both kinds. Even where the picture comes
  // from somewhere else — a source clip to restyle, supplied keyframes, an
  // uploaded still — the description still names who is in the frame, and
  // that is the only thing keeping them the same person shot to shot.
  els.characterWrap.classList.remove('hidden');
  els.dialogueWrap.classList.toggle('hidden', !seriesable);
  els.seriesWrap.classList.toggle('hidden', !seriesable);

  els.strengthWrap.classList.toggle('hidden', m !== 'img2img' && vm !== 'restyle');
  els.expandWrap.classList.toggle('hidden', m !== 'expand');
  els.poseWrap.classList.toggle('hidden', m !== 'pose');
}

// ---- Characters -----------------------------------------------------------
// A recurring character is two things the model cannot remember on its own:
// a description repeated verbatim into every prompt, and a fixed seed. Each
// generation is an independent call with no memory of the last, so "the same
// bear as before" means nothing to it — only the same words and the same
// starting noise reproduce the same character.
//
// Kept in localStorage: this is a personal library on one device, not shared
// state, and it must survive a reload without needing an account.
const CHARACTERS_KEY = 'mediaStudio.characters';

function loadCharacters() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHARACTERS_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveCharacters(list) {
  try {
    localStorage.setItem(CHARACTERS_KEY, JSON.stringify(list));
  } catch {
    // A full or disabled store just means the library does not persist.
  }
}

let characters = loadCharacters();

/** Rebuild the cast list, keeping whoever is already cast.
 *
 *  Setting `.value` on a multi-select replaces the whole selection, so saving
 *  one character used to drop everyone else out of the scene. The current
 *  selection is read back and restored instead, with `selectId` added to it. */
function fillCharacters(selectId) {
  const keep = new Set(
    Array.from(els.character.selectedOptions || [])
      .map((o) => o.value)
      .filter(Boolean),
  );
  if (selectId) keep.add(selectId);

  els.character.innerHTML = '';
  // Still offered: a plain click on it is the one-gesture way to clear the
  // cast, where deselecting the last name otherwise needs a modifier.
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  els.character.appendChild(none);
  for (const c of characters) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name || '(unnamed)';
    opt.selected = keep.has(c.id);
    els.character.appendChild(opt);
  }
}

/** Everyone cast in this generation, in bank order.
 *
 *  A scene with two characters talking needs both looks in the prompt or the
 *  second one is re-invented per clip, so the picker is a multi-select and
 *  the cast is a list everywhere except the editor. */
function selectedCast() {
  const picked = new Set(
    Array.from(els.character.selectedOptions || [])
      .map((o) => o.value)
      .filter(Boolean),
  );
  return characters.filter((c) => picked.has(c.id));
}

/** The one character the editor acts on: the first of the cast. */
function selectedCharacter() {
  return selectedCast()[0] || null;
}

/** The cast member who speaks a line, matched by name from the script. */
function castMemberNamed(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return characters.find((c) => String(c.name || '').trim().toLowerCase() === key) || null;
}

function newSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

function showCharacterInEditor(c) {
  els.charName.value = c?.name || '';
  els.charLook.value = c?.look || '';
  els.charStyle.value = c?.style || '';
  els.charSeed.value = c?.seed ?? newSeed();
  els.charVoice.value = '';
  els.charImage.value = '';
  pendingVoice = null;
  pendingImage = null;
  els.charVoiceState.textContent = c?.voice ? 'Voice sample saved.' : 'No voice sample yet.';
  els.charImageState.textContent = c?.image ? 'Reference image saved.' : 'No reference image yet.';
  els.charImagePreview.innerHTML = '';
  els.charImagePreview.classList.toggle('hidden', !c?.image);
  if (c?.image) {
    const img = document.createElement('img');
    img.src = c.image;
    img.alt = c.name || 'Reference';
    els.charImagePreview.appendChild(img);
  }
}

/** The prompt actually sent: the shot, then every cast member verbatim, then
 *  the style once. Order matters less than the repetition — every clip has to
 *  carry the full description or the model re-invents the character.
 *
 *  The style is taken from the first cast member that has one and written
 *  once: an episode is a single look, and repeating "2D cartoon, flat colors"
 *  per character only dilutes the rest of the prompt. */
function composePrompt(shot, cast) {
  const list = Array.isArray(cast) ? cast : cast ? [cast] : [];
  const looks = list.map((c) => String(c?.look || '').trim()).filter(Boolean);
  const style = list.map((c) => String(c?.style || '').trim()).find(Boolean) || '';
  return [shot, ...looks, style]
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .join(', ');
}

/** The style string alone — the still renderer needs it without a shot. */
function castStyle(cast) {
  return (Array.isArray(cast) ? cast : [])
    .map((c) => String(c?.style || '').trim())
    .find(Boolean) || '';
}

/** Offer to join a finished series into one clip.
 *
 *  Only URLs are sent: the stitching app fetches them itself, so the bytes go
 *  storage -> Modal and never pass through the browser or the API function.
 *  Without storage configured the clips come back as data: URLs instead, and
 *  several of those exceed the request limit — hence the check rather than a
 *  button that fails on click. */
function offerStitch(clipUrls, accessKey, audio) {
  // One clip is only worth assembling when there is audio to lay over it.
  if (clipUrls.length < 2 && !audio) return;
  const joining = clipUrls.length > 1;
  const label = joining
    ? `Join ${clipUrls.length} clips${audio ? ' and add audio' : ''}`
    : 'Add audio to this clip';
  const { card } = cardShell(joining ? `${clipUrls.length} clips ready` : 'Clip ready', '');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'text-btn media-generate';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Working…';
    setStatus(joining ? 'Joining clips…' : 'Adding audio…');
    try {
      const joined = await runSync({
        __op: 'stitch',
        clips: clipUrls,
        ...(audio ? { audio } : {}),
        accessKey,
      });
      renderVideoResult(joined);
      card.remove();
    } catch (err) {
      console.error(err);
      setStatus(err.message || 'Assembly failed.', true);
      btn.disabled = false;
      btn.textContent = label;
    }
  });
  card.appendChild(btn);
  prependCard(card);
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
els.charEdit.addEventListener('click', () => {
  const open = els.charEditor.classList.toggle('hidden');
  if (!open) showCharacterInEditor(selectedCharacter());
});

els.charNew.addEventListener('click', () => {
  els.character.value = '';
  showCharacterInEditor(null);
  els.charEditor.classList.remove('hidden');
  els.charName.focus();
});

els.character.addEventListener('change', () => {
  if (!els.charEditor.classList.contains('hidden')) showCharacterInEditor(selectedCharacter());
});

els.charReseed.addEventListener('click', () => {
  els.charSeed.value = newSeed();
});

els.charSave.addEventListener('click', () => {
  const name = (els.charName.value || '').trim();
  if (!name) {
    alert('Give the character a name.');
    els.charName.focus();
    return;
  }
  const existing = selectedCharacter();
  const record = {
    id: existing?.id || `c${Date.now()}`,
    name,
    look: (els.charLook.value || '').trim(),
    style: (els.charStyle.value || '').trim(),
    seed: Number(els.charSeed.value) || newSeed(),
    // Kept unless a new sample was staged, so editing the look does not
    // silently drop the voice.
    voice: pendingVoice ?? existing?.voice ?? '',
    image: pendingImage ?? existing?.image ?? '',
  };
  characters = existing
    ? characters.map((c) => (c.id === existing.id ? record : c))
    : [...characters, record];
  saveCharacters(characters);
  fillCharacters(record.id);
  els.charEditor.classList.add('hidden');
  setStatus(`Saved “${record.name}”.`);
});

els.charDelete.addEventListener('click', () => {
  const existing = selectedCharacter();
  if (!existing) {
    els.charEditor.classList.add('hidden');
    return;
  }
  if (!confirm(`Delete “${existing.name}”?`)) return;
  characters = characters.filter((c) => c.id !== existing.id);
  saveCharacters(characters);
  fillCharacters('');
  showCharacterInEditor(null);
  els.charEditor.classList.add('hidden');
});

els.mode.addEventListener('change', syncFields);
els.videoMode.addEventListener('change', syncFields);

// ---- Character voice -----------------------------------------------------
// A sample is staged here and written onto the character by Save, so an
// abandoned edit does not modify the stored voice.
els.charVoice.addEventListener('change', async () => {
  const file = els.charVoice.files?.[0];
  pendingVoice = null;
  if (!file) {
    els.charVoiceState.textContent = 'No new sample staged.';
    return;
  }
  if (file.size > SRC_VIDEO_MAX_BYTES) {
    els.charVoice.value = '';
    els.charVoiceState.textContent = `${(file.size / 1_048_576).toFixed(1)}MB is too big — a few seconds is plenty.`;
    return;
  }
  pendingVoice = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  els.charVoiceState.textContent = pendingVoice
    ? `Staged ${file.name} — press Save to keep it.`
    : 'Could not read that file.';
});

els.charImage.addEventListener('change', async () => {
  const file = els.charImage.files?.[0];
  pendingImage = null;
  if (!file) {
    els.charImageState.textContent = 'No new image staged.';
    return;
  }
  try {
    const compressed = await compressImageFile(file);
    pendingImage = compressed.base64;
    els.charImageState.textContent = `Staged ${file.name} — press Save to keep it.`;
    els.charImagePreview.innerHTML = '';
    els.charImagePreview.classList.remove('hidden');
    const img = document.createElement('img');
    img.src = pendingImage;
    img.alt = 'Reference';
    els.charImagePreview.appendChild(img);
  } catch (err) {
    els.charImage.value = '';
    els.charImageState.textContent = err.message || 'Could not read that image.';
  }
});

// Speaking fills the same audio slot an uploaded track would, so the voice
// is laid over the video by exactly the path that already works.
els.speakBtn.addEventListener('click', async () => {
  const text = (els.dialogue.value || '').trim();
  if (!text) {
    els.dialogue.focus();
    return;
  }
  const character = selectedCharacter();
  els.speakBtn.disabled = true;
  els.speakBtn.textContent = 'Speaking…';
  els.dialogueState.textContent = '';
  try {
    const spoken = await runSync({
      __op: 'speak',
      text,
      ...(character?.voice ? { voice: character.voice } : {}),
      accessKey: (els.accessKey.value || '').trim(),
    });
    audioData = spoken.audioUrl;
    // Clearing the file input keeps it honest: the audio slot now holds the
    // generated line, not whatever was picked there earlier.
    els.audio.value = '';
    const who = spoken.cloned ? `${character.name}'s voice` : 'the default voice';
    els.dialogueState.textContent = `${spoken.seconds}s in ${who} — ready to lay over the video.`;

    const { card } = cardShell(`voice · ${spoken.cloned ? character.name : 'default'}`, `${spoken.seconds}s`);
    const player = document.createElement('audio');
    player.src = spoken.audioUrl;
    player.controls = true;
    card.insertBefore(player, card.firstChild);
    prependCard(card);
    setStatus('Voice ready. Generate a clip and it will be offered as the audio track.');
  } catch (err) {
    console.error(err);
    els.dialogueState.textContent = err.message || 'Voice generation failed.';
    setStatus(err.message || 'Voice generation failed.', true);
  } finally {
    els.speakBtn.disabled = false;
    els.speakBtn.textContent = 'Generate voice';
  }
});

// ---- Audio track ---------------------------------------------------------
// Read once here rather than at generate time: the file has to survive as a
// data URL across a whole series, and the input itself can be cleared by the
// browser between clips.
els.audio.addEventListener('change', async () => {
  const file = els.audio.files?.[0];
  audioData = null;
  if (!file) {
    setStatus('');
    return;
  }
  if (file.size > SRC_VIDEO_MAX_BYTES) {
    els.audio.value = '';
    setStatus(
      `That track is ${(file.size / 1_048_576).toFixed(1)}MB. It has to fit in a 3MB ` +
        `request — try a shorter clip or a lower bitrate mp3.`,
      true,
    );
    return;
  }
  audioData = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  if (audioData) {
    setStatus(`Loaded ${file.name} — it will be offered once the video is generated.`);
  }
});

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
  const { __op, ...payload } = body;
  const res = await fetch(`/api/media-generate${__op ? `?op=${__op}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
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
// Ceiling matches the Modal apps' own 3600s timeout: past that the job is gone
// and there is nothing left to wait for.
const POLL_CEILING_MS = 3_600_000;

// The submit/result endpoints only exist on Modal apps deployed from modal/.
// Until those are deployed the apps expose `generate` alone, so the async
// route 404s and this falls back to the blocking one, which they do serve.
// Remembered per page load so the fallback costs one failed request, not one
// per generation.
let asyncVideoUnavailable = false;

// The job itself runs server-side on Modal regardless of whether this tab
// stays open — closing it never kills the generation. What used to get lost
// was the jobId: it only lived in this function's local variables, so
// leaving the page meant losing the only handle to a job that was still
// finishing successfully in the background. Saved here instead, so a reload
// (or coming back later) can pick the same job back up rather than starting
// over or losing the result entirely.
const PENDING_JOB_KEY = 'mediaStudio.pendingVideoJob';

function savePendingJob(jobId, model, accessKey) {
  try {
    localStorage.setItem(PENDING_JOB_KEY, JSON.stringify({ jobId, model, accessKey }));
  } catch {
    // Best-effort — a full quota or disabled storage just means no resume.
  }
}

function loadPendingJob() {
  try {
    const raw = localStorage.getItem(PENDING_JOB_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearPendingJob() {
  try {
    localStorage.removeItem(PENDING_JOB_KEY);
  } catch {
    // Nothing to do if storage is unavailable.
  }
}

/** Renders a finished video job's result into a result card. */
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

/** Polls an already-submitted job to completion. Shared by a fresh submit
 *  and by resuming a job left over from a previous page load. */
async function pollJob(jobId, model, accessKey) {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));

    const elapsed = Math.round((Date.now() - started) / 1000);
    setStatus(`Generating… ${elapsed}s. Self-hosted video takes minutes — safe to close this tab, come back anytime.`);

    // A mobile connection dropping momentarily (locking the phone, switching
    // wifi/cellular, backgrounding the tab) throws here — "Load failed" in
    // Safari — before there is even a response to read. That is not the job
    // failing, it is this one HTTP request failing; the generation is still
    // running on Modal either way. Treated as transient like a "running"
    // status: retry on the next tick rather than ending the wait.
    let out;
    try {
      const pollRes = await fetch('/api/media-generate?op=result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, model, accessKey }),
      });
      out = await pollRes.json().catch(() => ({}));
    } catch {
      if (Date.now() - started > POLL_CEILING_MS) {
        clearPendingJob();
        throw new Error('Gave up waiting after an hour — the job outlived its Modal timeout.');
      }
      continue;
    }

    if (out.status === 'done') {
      clearPendingJob();
      return out;
    }
    // A transient poll failure is not a failed job — the generation is still
    // running on Modal. Only an explicit terminal status ends the wait.
    if (out.status && out.status !== 'running') {
      clearPendingJob();
      throw new Error(out.error || `Generation ${out.status}.`);
    }
    if (Date.now() - started > POLL_CEILING_MS) {
      clearPendingJob();
      throw new Error('Gave up waiting after an hour — the job outlived its Modal timeout.');
    }
  }
}

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

  savePendingJob(job.jobId, body.model, body.accessKey);
  return pollJob(job.jobId, body.model, body.accessKey);
}

/** On page load, pick back up a job left over from a previous visit instead
 *  of it just being silently lost. The job itself never depended on the tab
 *  staying open — only the ability to find out it finished did. */
async function resumePendingJobOnLoad() {
  const pending = loadPendingJob();
  if (!pending || !pending.jobId) return;

  els.generate.disabled = true;
  els.generate.textContent = 'Resuming…';
  setStatus('Resuming a video generation left over from earlier…');
  try {
    const data = await pollJob(pending.jobId, pending.model, pending.accessKey);
    if (data.kind === 'video' || data.videoUrl) renderVideoResult(data);
  } catch (err) {
    console.error(err);
    setStatus(`Previous job: ${String(err.message || 'failed').replace(/^(AIError:\s*)+/gi, '')}`, true);
  } finally {
    els.generate.disabled = false;
    els.generate.textContent = 'Generate';
  }
}

els.generate.addEventListener('click', async () => {
  const prompt = (els.prompt.value || '').trim();
  const spec = selectedSpec();
  // Always read: the cast rides along with every generation now, so there is
  // no mode in which the selection is silently dropped.
  const cast = selectedCast();
  // The first cast member owns the seed and the fallback reference image —
  // one clip can only start from one picture, and one seed pins the whole run.
  const character = cast[0] || null;

  // A shot list replaces the single prompt: one line per clip, each expanded
  // with the character and style. The prompt box still works on its own when
  // the list is empty, so nothing changes for one-off generations.
  const seriesLines = els.seriesWrap.classList.contains('hidden')
    ? []
    : (els.series.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const shots = seriesLines.length ? seriesLines : prompt ? [prompt] : [];

  if (!shots.length) {
    alert(els.seriesWrap.classList.contains('hidden') ? 'Enter a prompt.' : 'Enter a prompt, or one shot per line under Series.');
    (seriesLines.length ? els.series : els.prompt).focus();
    return;
  }
  const usesRef = modelUsesRef(spec);

  const castRef = cast.find((c) => c.image) || null;
  if (usesRef && !refData && !castRef?.image) {
    alert(
      kind === 'image'
        ? 'This mode needs a source image — upload one, or give the character one.'
        : 'Image → Video needs a reference image — upload one, or give the character one.',
    );
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
        // Frame index, not seconds: the apps work in frames. The rate is the
        // model's own — LTX runs at 24fps and Wan at 16, so a fixed 24 here
        // put every Wan keyframe half again too late.
        const ready = keyframeState.filter((kf) => kf.image);
        if (!ready.length) throw new Error('Add at least one keyframe with an image.');
        body.keyframes = ready.map((kf) => ({
          image: kf.image,
          frame: Math.round(kf.at * (spec.fps || 24)),
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
    } else if (usesRef && castRef?.image) {
      // The character's own reference, so a saved character starts every shot
      // from the same picture without re-uploading it each time — for image
      // modes (edit, img2img, expand, pose) as well as image→video. A manual
      // upload still wins: it is the more specific choice. Modes that take
      // their picture from elsewhere (restyle, keyframes, plain text→image)
      // report usesRef false and are left alone — only the description and
      // seed reach those.
      // compressImageFile() always re-encodes to JPEG, so the type is known.
      body.imageBase64 = castRef.image;
      body.mimeType = 'image/jpeg';
    }

    // Shots run one after another rather than in parallel: they share a single
    // Modal container, and the cold start plus the app's idle window is paid
    // once for the whole list instead of once per clip. Firing them together
    // would start a container each and cost the overhead every time.
    const seriesClips = [];
    for (const [i, shot] of shots.entries()) {
      const perShot = { ...body, prompt: composePrompt(shot, cast) };
      // One seed across the series is half of what keeps a character stable;
      // the repeated description in composePrompt() is the other half. Both
      // now apply to images too, not just video.
      if (character && Number.isFinite(Number(character.seed))) perShot.seed = Number(character.seed);
      if (shots.length > 1) setStatus(`Shot ${i + 1} of ${shots.length}… ${shot}`);

      // Self-hosted video goes through the async job API. One blocking request
      // would be bounded by the API's 800s function timeout, which is what caps
      // clip length — polling moves the ceiling to the Modal app's own timeout
      // and lets the UI show progress instead of hanging.
      let data;
      try {
        data =
          kind === 'video' && spec.provider === 'modal'
            ? await runVideoJob(perShot)
            : await runSync(perShot);
      } catch (shotErr) {
        // One failed shot must not discard the clips already generated and
        // paid for, so the run continues and reports at the end.
        if (shots.length === 1) throw shotErr;
        console.error(shotErr);
        setStatus(`Shot ${i + 1} failed: ${shotErr.message}`, true);
        continue;
      }

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
        if (data.videoUrl) seriesClips.push(data.videoUrl);
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
    }

    if (shots.length > 1) setStatus(`Done — ${shots.length} shots.`);

    // Assembly passes links, not bytes. Inline clips (no storage configured)
    // would blow the request limit, so the offer is only made when there is
    // something linkable to send. A lone clip is only worth assembling when
    // there is audio to lay over it.
    const linkable = seriesClips.filter((u) => !String(u).startsWith('data:'));
    if (linkable.length > 1 || (linkable.length === 1 && audioData)) {
      offerStitch(linkable, body.accessKey || '', audioData);
    } else if (seriesClips.length > 1 || (seriesClips.length === 1 && audioData)) {
      setStatus(
        `Done. Joining and adding audio need storage configured ` +
          `(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) so clips come back as URLs rather than inline data.`,
      );
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


// ---- Episode pipeline ------------------------------------------------------
// Five stages, each one writing its result back onto the same row: script ->
// still -> clip -> line -> assembly. A shot is therefore never in two states
// at once, and a failed stage leaves the rows before it intact, so a retry
// repeats only what actually failed.
//
// The stages are separate buttons on purpose. Rendering eight shots is eight
// GPU video generations, and a script that reads wrong is far cheaper to fix
// before that than after. Auto-run chains 2-5 for when the script is already
// trusted.

// Still and clip are generated at one geometry so the still is exactly the
// frame the video grows out of — a mismatch gets letterboxed into the clip.
const EP_SIZE = '832x480';
const EP_SECONDS = 5;
// Illustration model for the stills (a cartoon series is not photographic),
// and the video model that accepts a starting frame. Both self-hosted, so an
// episode costs GPU time rather than per-generation billing.
const EP_STILL_SPEC = IMAGE_MODELS.find((m) => m.value === 'modal:wai-illustrious') || IMAGE_MODELS[0];
const EP_VIDEO_SPEC =
  VIDEO_MODELS.find((m) => Array.isArray(m.modes) && m.modes.includes('image')) || VIDEO_MODELS[0];
const EP_NEGATIVE = 'text, watermark, signature, photorealistic, 3d render, extra limbs, deformed';

// Mirrors lib/providers.js. The catalogue behind each is fetched live from
// /api/models, so only the ids have to stay in step.
const EP_PROVIDERS = [
  { id: 'venice', label: 'Venice' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'groq', label: 'Groq' },
  { id: 'xai', label: 'xAI' },
  { id: 'nvidia', label: 'NVIDIA' },
];

const EPISODE_KEY = 'mediaStudio.episode';

const epEls = {
  box: document.getElementById('episodeBox'),
  series: document.getElementById('epSeries'),
  style: document.getElementById('epStyle'),
  shots: document.getElementById('epShots'),
  provider: document.getElementById('epProvider'),
  model: document.getElementById('epModel'),
  premise: document.getElementById('epPremise'),
  write: document.getElementById('epWrite'),
  stills: document.getElementById('epStills'),
  animate: document.getElementById('epAnimate'),
  voice: document.getElementById('epVoice'),
  assemble: document.getElementById('epAssemble'),
  auto: document.getElementById('epAuto'),
  status: document.getElementById('epStatus'),
  script: document.getElementById('epScript'),
};

/** scene: { shot, speaker, line, still, clip, audio, state, error } */
let episode = loadEpisode();
let epRunning = false;

function blankEpisode() {
  return { title: '', series: '', style: '', premise: '', shots: 8, provider: '', model: '', scenes: [] };
}

/** Only the script is persisted. Stills, clips and voice lines are megabytes
 *  of data URLs each — they would blow the localStorage quota on the first
 *  episode and take the script down with them. */
function loadEpisode() {
  try {
    const raw = JSON.parse(localStorage.getItem(EPISODE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return blankEpisode();
    return {
      ...blankEpisode(),
      ...raw,
      scenes: Array.isArray(raw.scenes)
        ? raw.scenes.map((s) => ({
            shot: String(s?.shot || ''),
            speaker: String(s?.speaker || ''),
            line: String(s?.line || ''),
            still: '',
            clip: '',
            audio: '',
            state: '',
            error: '',
          }))
        : [],
    };
  } catch {
    return blankEpisode();
  }
}

function saveEpisode() {
  try {
    localStorage.setItem(
      EPISODE_KEY,
      JSON.stringify({
        title: episode.title,
        series: episode.series,
        style: episode.style,
        premise: episode.premise,
        shots: episode.shots,
        provider: episode.provider,
        model: episode.model,
        scenes: episode.scenes.map(({ shot, speaker, line }) => ({ shot, speaker, line })),
      }),
    );
  } catch {
    // A full store costs persistence, never the episode in front of you.
  }
}

function epStatus(msg, isError = false) {
  epEls.status.textContent = msg || '';
  epEls.status.classList.toggle('is-error', !!msg && isError);
}

/** The cast for this episode, with the style box folded in.
 *
 *  The style lives on the episode rather than per character: one series is one
 *  look, and typing it into every character would let them drift apart. The
 *  bank's own style is the fallback so a character built before the episode
 *  panel existed still renders the way it always did. */
function epCast() {
  const picked = selectedCast();
  const style = String(epEls.style.value || '').trim();
  if (!style) return picked;
  return picked.map((c) => ({ ...c, style }));
}

/** One seed for the whole episode, from the first cast member. Stills that
 *  share a seed share a palette and a drawing style even as the prompt moves
 *  from shot to shot. */
function epSeed(cast) {
  const n = Number(cast.find((c) => Number.isFinite(Number(c.seed)))?.seed);
  return Number.isFinite(n) ? n : undefined;
}

function epAccessKey() {
  return (els.accessKey.value || '').trim();
}

/** Whatever the image API returned, as something the video app can decode.
 *  It only reads base64 and data: URLs (modal/wan_app.py `_decode_image`), so
 *  a stored image has to come back through the browser as bytes. */
async function epAsDataUrl(img) {
  if (img?.base64) {
    return String(img.base64).startsWith('data:') ? img.base64 : `data:image/png;base64,${img.base64}`;
  }
  if (!img?.url) throw new Error('The still came back empty.');
  const res = await fetch(img.url);
  if (!res.ok) throw new Error(`Could not read the still back (HTTP ${res.status}).`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the still back.'));
    reader.readAsDataURL(blob);
  });
}

// ---- Script table ----------------------------------------------------------

function epRenderScript() {
  epEls.script.innerHTML = '';
  const names = characters.map((c) => c.name).filter(Boolean);

  episode.scenes.forEach((scene, i) => {
    const row = document.createElement('div');
    row.className = 'ep-row';

    const num = document.createElement('div');
    num.className = 'ep-num';
    num.textContent = String(i + 1);
    row.appendChild(num);

    const thumb = document.createElement('img');
    thumb.className = 'ep-thumb';
    thumb.alt = '';
    if (scene.still) thumb.src = scene.still;
    row.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'ep-body';

    const shot = document.createElement('textarea');
    shot.rows = 2;
    shot.value = scene.shot;
    shot.placeholder = 'What the camera sees';
    shot.addEventListener('input', () => {
      scene.shot = shot.value;
      saveEpisode();
    });
    body.appendChild(shot);

    const lineRow = document.createElement('div');
    lineRow.className = 'ep-line';

    const who = document.createElement('select');
    const silent = document.createElement('option');
    silent.value = '';
    silent.textContent = '— silent —';
    who.appendChild(silent);
    for (const n of names) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      who.appendChild(o);
    }
    who.value = names.includes(scene.speaker) ? scene.speaker : '';
    who.addEventListener('change', () => {
      scene.speaker = who.value;
      saveEpisode();
    });
    lineRow.appendChild(who);

    const line = document.createElement('input');
    line.type = 'text';
    line.value = scene.line;
    line.placeholder = 'Spoken line';
    line.addEventListener('input', () => {
      scene.line = line.value;
      saveEpisode();
    });
    lineRow.appendChild(line);
    body.appendChild(lineRow);

    const state = document.createElement('div');
    state.className = 'ep-state';
    if (scene.error) {
      state.classList.add('is-error');
      state.textContent = scene.error;
    } else if (scene.state) {
      if (scene.clip || scene.audio) state.classList.add('is-done');
      state.textContent = scene.state;
    }
    body.appendChild(state);

    row.appendChild(body);
    epEls.script.appendChild(row);
  });

  epSyncButtons();
}

function epSyncButtons() {
  const hasScript = episode.scenes.length > 0;
  const hasStills = episode.scenes.some((s) => s.still);
  const hasLines = episode.scenes.some((s) => s.speaker && s.line.trim());
  epEls.write.disabled = epRunning;
  epEls.stills.disabled = epRunning || !hasScript;
  epEls.animate.disabled = epRunning || !hasStills;
  // Voice needs lines, not clips: hearing a character read the script back is
  // the cheapest way to catch a wrong voice, and it should not cost eight video
  // generations first.
  epEls.voice.disabled = epRunning || !hasLines;
  // Assembly needs two clips, or one clip carrying a line.
  const clips = episode.scenes.filter((s) => s.clip);
  epEls.assemble.disabled =
    epRunning || !(clips.length > 1 || (clips.length === 1 && clips[0].audio));
}

// ---- Stage 1 · script ------------------------------------------------------

async function epFillModels() {
  const provider = epEls.provider.value;
  epEls.model.innerHTML = '<option>Loading…</option>';
  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`);
    const data = await res.json().catch(() => ({}));
    const list = Array.isArray(data.models) ? data.models : [];
    epEls.model.innerHTML = '';
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name || m.id;
      epEls.model.appendChild(o);
    }
    if (!list.length) epEls.model.innerHTML = '<option value="">No models available</option>';
    if (episode.model && list.some((m) => m.id === episode.model)) epEls.model.value = episode.model;
  } catch {
    epEls.model.innerHTML = '<option value="">Could not load models</option>';
  }
}

async function epWriteScript() {
  const cast = epCast();
  if (!cast.length) {
    epStatus('Pick at least one character in Cast above — the writer casts from the bank.', true);
    return;
  }
  const premise = (epEls.premise.value || '').trim();
  if (!premise) {
    epStatus('Give the episode a premise.', true);
    epEls.premise.focus();
    return;
  }

  epStatus('Writing the script…');
  const res = await fetch('/api/assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'episode',
      provider: epEls.provider.value,
      model: epEls.model.value,
      premise,
      shots: Number(epEls.shots.value) || 8,
      series: { title: (epEls.series.value || '').trim(), style: (epEls.style.value || '').trim() },
      cast: cast.map((c) => ({ name: c.name, look: c.look })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Script generation failed (HTTP ${res.status}).`);

  episode = {
    ...episode,
    title: data.title || '',
    series: (epEls.series.value || '').trim(),
    style: (epEls.style.value || '').trim(),
    premise,
    shots: Number(epEls.shots.value) || 8,
    provider: epEls.provider.value,
    model: epEls.model.value,
    scenes: (data.scenes || []).map((s) => ({
      shot: s.shot,
      speaker: s.speaker || '',
      line: s.line || '',
      still: '',
      clip: '',
      audio: '',
      state: '',
      error: '',
    })),
  };
  saveEpisode();
  epRenderScript();
  epStatus(`“${episode.title}” — ${episode.scenes.length} shots. Edit anything, then render.`);
}

// ---- Stage 2 · stills ------------------------------------------------------

async function epRenderStills() {
  const cast = epCast();
  if (!cast.length) throw new Error('Pick at least one character in Cast above.');
  const seed = epSeed(cast);
  const accessKey = epAccessKey();

  for (const [i, scene] of episode.scenes.entries()) {
    if (!scene.shot.trim()) continue;
    scene.error = '';
    scene.state = 'Drawing…';
    epRenderScript();
    epStatus(`Still ${i + 1} of ${episode.scenes.length}…`);
    try {
      const out = await runSync({
        kind: 'image',
        provider: EP_STILL_SPEC.provider,
        model: EP_STILL_SPEC.model,
        prompt: composePrompt(scene.shot, cast),
        negativePrompt: EP_NEGATIVE,
        size: EP_SIZE,
        count: 1,
        mode: 'text',
        ...(seed != null ? { seed } : {}),
        accessKey,
      });
      scene.still = await epAsDataUrl((out.images || [])[0]);
      scene.state = 'Still ready.';
    } catch (err) {
      scene.error = `Still failed: ${err.message}`;
      scene.state = '';
    }
    epRenderScript();
  }
  const done = episode.scenes.filter((s) => s.still).length;
  epStatus(`${done} of ${episode.scenes.length} stills rendered.`);
}

// ---- Stage 3 · animate -----------------------------------------------------

async function epAnimateShots() {
  const cast = epCast();
  const seed = epSeed(cast);
  const accessKey = epAccessKey();

  for (const [i, scene] of episode.scenes.entries()) {
    if (!scene.still) continue;
    scene.error = '';
    scene.state = 'Animating…';
    epRenderScript();
    epStatus(`Clip ${i + 1} of ${episode.scenes.length} — this is the slow stage.`);
    try {
      const out = await runVideoJob({
        kind: 'video',
        provider: EP_VIDEO_SPEC.provider,
        model: EP_VIDEO_SPEC.model,
        prompt: composePrompt(scene.shot, cast),
        negativePrompt: EP_NEGATIVE,
        size: EP_SIZE,
        seconds: EP_SECONDS,
        // The still is this shot's first frame, which is what makes the clip
        // continue the drawing rather than invent a new one.
        imageBase64: scene.still,
        mimeType: 'image/jpeg',
        ...(seed != null ? { seed } : {}),
        accessKey,
      });
      scene.clip = out.videoUrl || '';
      scene.state = scene.clip ? 'Clip ready.' : '';
      if (!scene.clip) scene.error = 'The clip came back empty.';
    } catch (err) {
      scene.error = `Clip failed: ${err.message}`;
      scene.state = '';
    }
    epRenderScript();
  }
  const done = episode.scenes.filter((s) => s.clip).length;
  epStatus(`${done} of ${episode.scenes.length} clips animated.`);
}

// ---- Stage 4 · voice -------------------------------------------------------

async function epVoiceLines() {
  const accessKey = epAccessKey();
  const speaking = episode.scenes.filter((s) => s.speaker && s.line.trim());
  if (!speaking.length) {
    epStatus('No spoken lines in this script — nothing to voice.');
    return;
  }

  let n = 0;
  for (const scene of episode.scenes) {
    if (!scene.speaker || !scene.line.trim()) continue;
    const member = castMemberNamed(scene.speaker);
    scene.error = '';
    scene.state = 'Speaking…';
    epRenderScript();
    n += 1;
    epStatus(`Line ${n} of ${speaking.length} — ${scene.speaker}…`);
    try {
      const spoken = await runSync({
        __op: 'speak',
        text: scene.line.trim(),
        // Without a saved sample this is the default voice, which is still
        // better than a silent shot — the bank just has no clone for them yet.
        ...(member?.voice ? { voice: member.voice } : {}),
        accessKey,
      });
      scene.audio = spoken.audioUrl || '';
      scene.state = scene.audio
        ? `Voiced${member?.voice ? ` as ${scene.speaker}` : ' (default voice)'}.`
        : '';
      if (!scene.audio) scene.error = 'The voice came back empty.';
    } catch (err) {
      scene.error = `Voice failed: ${err.message}`;
      scene.state = '';
    }
    epRenderScript();
  }
  const done = episode.scenes.filter((s) => s.audio).length;
  epStatus(`${done} of ${speaking.length} lines voiced.`);
}

// ---- Stage 5 · assemble ----------------------------------------------------

async function epAssembleEpisode() {
  const withClips = episode.scenes.filter((s) => s.clip);
  if (!withClips.length) throw new Error('Nothing to assemble — animate the shots first.');

  // Inline clips cannot be joined: the payload would be tens of megabytes and
  // Vercel rejects it. Storage turns every clip into a URL, which is why the
  // API asks for it before video works at all.
  const inline = withClips.filter((s) => String(s.clip).startsWith('data:'));
  if (inline.length) {
    throw new Error(
      'Clips came back inline rather than as URLs, so they cannot be joined. ' +
        'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  epStatus(`Assembling ${withClips.length} shots…`);
  const joined = await runSync({
    __op: 'stitch',
    // Each shot carries its own line, so the stitcher keeps the dialogue on
    // the shot it belongs to instead of laying one track over the episode.
    clips: withClips.map((s) => (s.audio ? { video: s.clip, audio: s.audio } : s.clip)),
    accessKey: epAccessKey(),
  });
  renderVideoResult(joined);
  epStatus(`“${episode.title || 'Episode'}” assembled — ${withClips.length} shots.`);
}

// ---- Wiring ----------------------------------------------------------------

/** One guard for every stage: no two stages run at once, failures surface in
 *  the status line rather than the console, and the buttons come back. */
function epStage(fn, label) {
  return async () => {
    if (epRunning) return;
    epRunning = true;
    epSyncButtons();
    try {
      await fn();
    } catch (err) {
      console.error(err);
      epStatus(err.message || `${label} failed.`, true);
    } finally {
      epRunning = false;
      epSyncButtons();
    }
  };
}

epEls.write.addEventListener(
  'click',
  epStage(async () => {
    await epWriteScript();
    // Auto-run starts only after the script exists, so the one stage worth
    // reading before spending GPU time is always the one you get to see.
    if (epEls.auto.checked) {
      await epRenderStills();
      await epAnimateShots();
      await epVoiceLines();
      await epAssembleEpisode();
    }
  }, 'Script'),
);

epEls.stills.addEventListener('click', epStage(epRenderStills, 'Stills'));
epEls.animate.addEventListener('click', epStage(epAnimateShots, 'Animation'));
epEls.voice.addEventListener('click', epStage(epVoiceLines, 'Voice'));
epEls.assemble.addEventListener('click', epStage(epAssembleEpisode, 'Assembly'));

epEls.provider.addEventListener('change', epFillModels);
for (const [el, key] of [
  [epEls.series, 'series'],
  [epEls.style, 'style'],
  [epEls.premise, 'premise'],
  [epEls.shots, 'shots'],
]) {
  el.addEventListener('input', () => {
    episode[key] = key === 'shots' ? Number(el.value) || 8 : el.value;
    saveEpisode();
  });
}

// A new or renamed character has to reach the speaker dropdowns, or a script
// written before the rename silently loses its voices.
els.charSave.addEventListener('click', () => {
  if (episode.scenes.length) epRenderScript();
});

function epInit() {
  for (const p of EP_PROVIDERS) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    epEls.provider.appendChild(o);
  }
  epEls.provider.value = episode.provider || 'venice';
  epEls.series.value = episode.series || '';
  epEls.style.value = episode.style || '';
  epEls.premise.value = episode.premise || '';
  epEls.shots.value = episode.shots || 8;
  epRenderScript();
  epFillModels();
}

const BUILD = 'b8';
const hint = document.querySelector('.media-top-hint');
if (hint) hint.textContent = `Image · Video · ${BUILD}`;

fillCharacters();
epInit();
fillModels();
fillSizes();
fillLengths();
fillVideoModes();
syncFields();
resumePendingJobOnLoad();
