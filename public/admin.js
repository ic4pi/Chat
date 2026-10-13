// ============================================================================
// Uncensored Chat — /admin
//
// Reads and writes the master prompt + personas via /api/admin-config, which
// stores them in Vercel KV. The admin HTML itself is served by /api/admin
// behind HTTP Basic auth, so by the time this script runs the browser has
// already cached the credentials and same-origin fetches to /api/admin-config
// automatically carry them.
// ============================================================================

const $ = (id) => document.getElementById(id);

const els = {
  masterPromptInput: $('masterPromptInput'),
  saveMasterBtn: $('saveMasterBtn'),
  clearMasterBtn: $('clearMasterBtn'),
  personaList: $('personaList'),
  newPersonaBtn: $('newPersonaBtn'),
  personaNameInput: $('personaNameInput'),
  personaDescriptionInput: $('personaDescriptionInput'),
  personaPromptInput: $('personaPromptInput'),
  savePersonaBtn: $('savePersonaBtn'),
  deletePersonaBtn: $('deletePersonaBtn'),
  exportAdminBtn: $('exportAdminBtn'),
  importAdminBtn: $('importAdminBtn'),
  importAdminFile: $('importAdminFile'),
  signOutBtn: $('signOutBtn'),
  refreshMediaBtn: $('refreshMediaBtn'),
  mediaList: $('mediaList'),
  accountList: $('accountList'),
  newAccountBtn: $('newAccountBtn'),
  accountLabelInput: $('accountLabelInput'),
  accountPlatformInput: $('accountPlatformInput'),
  accountMetaFields: $('accountMetaFields'),
  accountPageIdInput: $('accountPageIdInput'),
  accountPageTokenInput: $('accountPageTokenInput'),
  accountIgUserField: $('accountIgUserField'),
  accountIgUserInput: $('accountIgUserInput'),
  accountTwitterFields: $('accountTwitterFields'),
  accountConsumerKeyInput: $('accountConsumerKeyInput'),
  accountConsumerSecretInput: $('accountConsumerSecretInput'),
  accountAccessTokenInput: $('accountAccessTokenInput'),
  accountAccessTokenSecretInput: $('accountAccessTokenSecretInput'),
  accountEmailFields: $('accountEmailFields'),
  accountResendApiKeyInput: $('accountResendApiKeyInput'),
  accountFromEmailInput: $('accountFromEmailInput'),
  saveAccountBtn: $('saveAccountBtn'),
  deleteAccountBtn: $('deleteAccountBtn'),
  dailyStatus: $('dailyStatus'), dailyEnabled: $('dailyEnabled'), dailyBrief: $('dailyBrief'),
  dailyHours: $('dailyHours'), dailyTimezone: $('dailyTimezone'), dailyProvider: $('dailyProvider'),
  dailyModel: $('dailyModel'), dailyTargetType: $('dailyTargetType'),
  dailyGithubFields: $('dailyGithubFields'), dailyWebhookFields: $('dailyWebhookFields'),
  dailyRepo: $('dailyRepo'), dailyBranch: $('dailyBranch'), dailyDir: $('dailyDir'), dailyGhToken: $('dailyGhToken'),
  dailyHookUrl: $('dailyHookUrl'), dailyHookToken: $('dailyHookToken'), dailySiteUrl: $('dailySiteUrl'),
  dailySaveBtn: $('dailySaveBtn'), dailyPreviewBtn: $('dailyPreviewBtn'), dailyRunBtn: $('dailyRunBtn'),
  dailyResult: $('dailyResult'), dailyPreview: $('dailyPreview'), dailyHistory: $('dailyHistory'),
};

let data = { masterPrompt: '', personas: [], socialAccounts: [] };
let selectedPersonaId = null;
let selectedAccountId = null;

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

function showBootError(msg) {
  const el = document.getElementById('bootError');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = msg;
}

async function apiGet() {
  const res = await fetch('/api/admin-config', { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    throw new Error(body?.error || `Server returned HTTP ${res.status}`);
  }
  return await res.json();
}

async function apiPut(payload) {
  const res = await fetch('/api/admin-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    throw new Error(body?.error || `Server returned HTTP ${res.status}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------

function renderPersonaList() {
  els.personaList.innerHTML = '';
  for (const p of data.personas) {
    const li = document.createElement('li');
    if (p.id === selectedPersonaId) li.classList.add('active');
    if (p.builtin) li.classList.add('builtin');
    const span = document.createElement('span');
    span.textContent = p.name;
    li.appendChild(span);
    li.addEventListener('click', () => selectPersona(p.id));
    els.personaList.appendChild(li);
  }
}

function selectPersona(id) {
  selectedPersonaId = id;
  const p = data.personas.find((x) => x.id === id);
  if (!p) return;
  els.personaNameInput.value = p.name;
  els.personaDescriptionInput.value = p.description || '';
  els.personaPromptInput.value = p.systemPrompt || '';
  // Built-ins are editable — your saved prompt is what chat uses.
  els.personaNameInput.disabled = false;
  els.personaDescriptionInput.disabled = false;
  els.personaPromptInput.disabled = false;
  els.savePersonaBtn.disabled = false;
  // Keep built-ins from being deleted; clear/replace their prompt instead.
  els.deletePersonaBtn.disabled = !!p.builtin;
  renderPersonaList();
}

async function refresh() {
  try {
    const fresh = await apiGet();
    data = {
      masterPrompt: fresh.masterPrompt || '',
      personas: fresh.personas || [],
      socialAccounts: fresh.socialAccounts || [],
    };
    els.masterPromptInput.value = data.masterPrompt;
    if (!data.personas.some((p) => p.id === selectedPersonaId)) {
      selectedPersonaId = data.personas[0]?.id || null;
    }
    renderPersonaList();
    if (selectedPersonaId) selectPersona(selectedPersonaId);
    if (!data.socialAccounts.some((a) => a.id === selectedAccountId)) {
      selectedAccountId = data.socialAccounts[0]?.id || null;
    }
    renderAccountList();
    if (selectedAccountId) selectAccount(selectedAccountId);
  } catch (err) {
    showBootError(err.message);
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function renderMediaList(files) {
  els.mediaList.innerHTML = '';
  if (!files.length) {
    const li = document.createElement('li');
    li.className = 'media-recent-empty';
    li.textContent = 'Nothing generated yet.';
    els.mediaList.appendChild(li);
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'media-recent-item';
    const when = f.createdAt ? new Date(f.createdAt).toLocaleString() : '';
    const kind = f.path.startsWith('video/') ? 'video' : 'image';
    li.innerHTML = `
      <a href="${f.url}" target="_blank" rel="noopener">${kind === 'video' ? '🎬' : '🖼️'} ${f.path}</a>
      <span class="media-recent-meta">${when}${f.size != null ? ' · ' + formatBytes(f.size) : ''}</span>
    `;
    els.mediaList.appendChild(li);
  }
}

async function refreshMedia() {
  try {
    const res = await fetch('/api/admin-media', { cache: 'no-store', credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `Server returned HTTP ${res.status}`);
    renderMediaList(body.files || []);
  } catch (err) {
    els.mediaList.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'media-recent-empty';
    li.textContent = err.message || 'Could not load media.';
    els.mediaList.appendChild(li);
  }
}

async function commit() {
  try {
    const updated = await apiPut({
      masterPrompt: data.masterPrompt,
      // Save every persona, including NEXUS / Plain overrides.
      personas: data.personas,
      socialAccounts: data.socialAccounts,
    });
    data = {
      masterPrompt: updated.masterPrompt || '',
      personas: updated.personas || [],
      socialAccounts: updated.socialAccounts || [],
    };
    if (!data.personas.some((p) => p.id === selectedPersonaId)) {
      selectedPersonaId = data.personas[0]?.id || null;
    }
    renderPersonaList();
    if (selectedPersonaId) selectPersona(selectedPersonaId);
    if (!data.socialAccounts.some((a) => a.id === selectedAccountId)) {
      selectedAccountId = data.socialAccounts[0]?.id || null;
    }
    renderAccountList();
    if (selectedAccountId) selectAccount(selectedAccountId);
  } catch (err) {
    alert('Save failed: ' + err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Social accounts — same list/edit pattern as personas above.
// ---------------------------------------------------------------------------

function renderAccountList() {
  if (!els.accountList) return;
  els.accountList.innerHTML = '';
  for (const a of data.socialAccounts) {
    const li = document.createElement('li');
    if (a.id === selectedAccountId) li.classList.add('active');
    const span = document.createElement('span');
    span.textContent = `${a.label} (${a.platform})`;
    li.appendChild(span);
    li.addEventListener('click', () => selectAccount(a.id));
    els.accountList.appendChild(li);
  }
}

function syncAccountFieldVisibility() {
  const platform = els.accountPlatformInput.value;
  if (els.accountIgUserField) els.accountIgUserField.style.display = platform === 'instagram' ? '' : 'none';
  if (els.accountMetaFields) {
    els.accountMetaFields.style.display = (platform === 'twitter' || platform === 'email') ? 'none' : '';
  }
  if (els.accountTwitterFields) els.accountTwitterFields.style.display = platform === 'twitter' ? '' : 'none';
  if (els.accountEmailFields) els.accountEmailFields.style.display = platform === 'email' ? '' : 'none';
}

function selectAccount(id) {
  selectedAccountId = id;
  const a = data.socialAccounts.find((x) => x.id === id);
  if (!a) return;
  els.accountLabelInput.value = a.label;
  els.accountPlatformInput.value = a.platform;
  els.accountPageIdInput.value = a.pageId || '';
  els.accountPageTokenInput.value = a.pageToken || '';
  els.accountIgUserInput.value = a.igUserId || '';
  els.accountConsumerKeyInput.value = a.consumerKey || '';
  els.accountConsumerSecretInput.value = a.consumerSecret || '';
  els.accountAccessTokenInput.value = a.accessToken || '';
  els.accountAccessTokenSecretInput.value = a.accessTokenSecret || '';
  els.accountResendApiKeyInput.value = a.resendApiKey || '';
  els.accountFromEmailInput.value = a.fromEmail || '';
  syncAccountFieldVisibility();
  renderAccountList();
}

function newAccount() {
  const a = {
    id: uid(), label: 'New account', platform: 'facebook',
    pageId: '', pageToken: '', igUserId: '',
    consumerKey: '', consumerSecret: '', accessToken: '', accessTokenSecret: '',
    resendApiKey: '', fromEmail: '',
  };
  data.socialAccounts.push(a);
  selectedAccountId = a.id;
  renderAccountList();
  selectAccount(a.id);
  els.accountLabelInput.focus();
  els.accountLabelInput.select();
}

async function saveAccount() {
  const a = data.socialAccounts.find((x) => x.id === selectedAccountId);
  if (!a) return;
  a.label = els.accountLabelInput.value.trim() || 'Untitled account';
  a.platform = ['instagram', 'twitter', 'email'].includes(els.accountPlatformInput.value)
    ? els.accountPlatformInput.value
    : 'facebook';
  a.pageId = els.accountPageIdInput.value.trim();
  a.pageToken = els.accountPageTokenInput.value.trim();
  a.igUserId = els.accountIgUserInput.value.trim();
  a.consumerKey = els.accountConsumerKeyInput.value.trim();
  a.consumerSecret = els.accountConsumerSecretInput.value.trim();
  a.accessToken = els.accountAccessTokenInput.value.trim();
  a.accessTokenSecret = els.accountAccessTokenSecretInput.value.trim();
  a.resendApiKey = els.accountResendApiKeyInput.value.trim();
  a.fromEmail = els.accountFromEmailInput.value.trim();
  await commit();
  flashButton(els.saveAccountBtn, 'Saved');
}

async function deleteAccount() {
  const a = data.socialAccounts.find((x) => x.id === selectedAccountId);
  if (!a) return;
  if (!confirm(`Delete account "${a.label}"?`)) return;
  data.socialAccounts = data.socialAccounts.filter((x) => x.id !== a.id);
  selectedAccountId = data.socialAccounts[0]?.id || null;
  await commit();
}

function newPersona() {
  const p = { id: uid(), name: 'New persona', description: '', systemPrompt: 'You are ...', builtin: false };
  data.personas.push(p);
  selectedPersonaId = p.id;
  renderPersonaList();
  selectPersona(p.id);
  els.personaNameInput.focus();
  els.personaNameInput.select();
}

async function savePersona() {
  const p = data.personas.find((x) => x.id === selectedPersonaId);
  if (!p) return;
  p.name = els.personaNameInput.value.trim() || 'Untitled persona';
  p.description = els.personaDescriptionInput.value.trim();
  p.systemPrompt = els.personaPromptInput.value;
  await commit();
  flashButton(els.savePersonaBtn, 'Saved');
}

async function deletePersona() {
  const p = data.personas.find((x) => x.id === selectedPersonaId);
  if (!p || p.builtin) return;
  if (!confirm(`Delete persona "${p.name}"?`)) return;
  data.personas = data.personas.filter((x) => x.id !== p.id);
  selectedPersonaId = data.personas[0]?.id || null;
  await commit();
}

async function saveMasterPrompt() {
  data.masterPrompt = els.masterPromptInput.value;
  await commit();
  flashButton(els.saveMasterBtn, 'Saved');
}

async function clearMasterPrompt() {
  if (!confirm('Clear the master prompt?')) return;
  data.masterPrompt = '';
  els.masterPromptInput.value = '';
  await commit();
  flashButton(els.clearMasterBtn, 'Cleared');
}

function exportAdmin() {
  const payload = {
    exportedAt: new Date().toISOString(),
    masterPrompt: data.masterPrompt,
    personas: data.personas.filter((p) => !p.builtin),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `uncensored-chat-admin-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function importAdmin(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (typeof parsed.masterPrompt === 'string') data.masterPrompt = parsed.masterPrompt;
    if (Array.isArray(parsed.personas)) {
      const imported = parsed.personas
        .filter((p) => p && !p.builtin && typeof p.id === 'string')
        .map((p) => ({
          id: p.id,
          name: p.name || 'Imported',
          description: p.description || '',
          systemPrompt: p.systemPrompt || '',
          builtin: false,
        }));
      const existingCustom = data.personas.filter((p) => !p.builtin && !imported.some((i) => i.id === p.id));
      data.personas = [
        ...data.personas.filter((p) => p.builtin),
        ...existingCustom,
        ...imported,
      ];
    }
    await commit();
    els.masterPromptInput.value = data.masterPrompt;
    alert('Import complete.');
  } catch (err) {
    alert('Import failed: ' + (err.message || err));
  }
}

async function signOut() {
  if (!confirm('Sign out and forget cached admin credentials for this browser?')) return;
  try {
    await fetch('/admin', {
      method: 'GET',
      headers: { Authorization: 'Basic ' + btoa('signout:signout') },
      cache: 'no-store',
    });
  } catch {}
  location.href = '/admin?logout=' + Date.now();
}

// ---------------------------------------------------------------------------

els.saveMasterBtn.addEventListener('click', saveMasterPrompt);
els.clearMasterBtn.addEventListener('click', clearMasterPrompt);
els.newPersonaBtn.addEventListener('click', newPersona);
els.savePersonaBtn.addEventListener('click', savePersona);
els.deletePersonaBtn.addEventListener('click', deletePersona);
els.exportAdminBtn.addEventListener('click', exportAdmin);
els.importAdminBtn.addEventListener('click', () => els.importAdminFile.click());
els.importAdminFile.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importAdmin(file);
  e.target.value = '';
});
els.signOutBtn.addEventListener('click', signOut);
els.refreshMediaBtn?.addEventListener('click', refreshMedia);
els.newAccountBtn?.addEventListener('click', newAccount);
els.saveAccountBtn?.addEventListener('click', saveAccount);
els.deleteAccountBtn?.addEventListener('click', deleteAccount);
els.accountPlatformInput?.addEventListener('change', syncAccountFieldVisibility);

// ---------------------------------------------------------------------------
// Daily pages: the settings, a preview that posts nothing, and a log.
// ---------------------------------------------------------------------------

async function dailyApi(method, query = '', body) {
  const res = await fetch(`/api/admin-daily-pages${query}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error || `Server returned HTTP ${res.status}`);
  return json;
}

function syncDailyTarget() {
  const hook = els.dailyTargetType.value === 'webhook';
  els.dailyGithubFields.hidden = hook;
  els.dailyWebhookFields.hidden = !hook;
}

function dailyWhen(iso) {
  try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return iso || ''; }
}

function renderDaily(payload) {
  const c = payload.config;
  const s = payload.status || {};
  els.dailyEnabled.checked = !!c.enabled;
  els.dailyBrief.value = c.brief || '';
  els.dailyHours.value = (c.hours || []).join(', ');
  els.dailyTimezone.value = c.timezone || 'UTC';
  els.dailyProvider.value = c.provider || 'openrouter';
  els.dailyModel.value = c.model || '';
  els.dailyTargetType.value = c.target?.type || 'github';
  els.dailyRepo.value = c.target?.repo || '';
  els.dailyBranch.value = c.target?.branch || 'main';
  els.dailyDir.value = c.target?.dir ?? 'docs';
  els.dailyHookUrl.value = c.target?.url || '';
  els.dailySiteUrl.value = c.target?.siteUrl || '';
  const hasToken = !!c.target?.hasToken;
  els.dailyGhToken.value = '';
  els.dailyHookToken.value = '';
  els.dailyGhToken.placeholder = hasToken ? 'saved — leave blank to keep it' : 'github_pat_…';
  els.dailyHookToken.placeholder = hasToken ? 'saved — leave blank to keep it' : 'optional';
  syncDailyTarget();

  const lines = [];
  let bad = false;
  if (!s.hasProviderKey) { lines.push(`No ${s.providerKeyName || 'API key'} is set in Vercel — pages cannot be written until it is.`); bad = true; }
  if (s.problem) { lines.push(s.problem); bad = true; }
  if (c.enabled && !bad && s.next) lines.push(`On. Next page: ${s.next.replace('@', ' at ')}:00 (${c.timezone}).`);
  if (!c.enabled) lines.push('Off. Nothing will be made or posted until you turn it on.');
  if (s.lastRun) {
    lines.push(s.lastRun.ok
      ? `Last run ${dailyWhen(s.lastRun.at)}: posted "${s.lastRun.title}".`
      : `Last run ${dailyWhen(s.lastRun.at)} FAILED: ${s.lastRun.error}`);
    if (!s.lastRun.ok) bad = true;
  }
  els.dailyStatus.textContent = lines.join('\n');
  els.dailyStatus.style.whiteSpace = 'pre-wrap';
  els.dailyStatus.classList.toggle('bad', bad);

  els.dailyHistory.innerHTML = '';
  if (!(s.history || []).length) {
    const li = document.createElement('li');
    li.className = 'media-recent-empty';
    li.textContent = 'No pages posted yet.';
    els.dailyHistory.appendChild(li);
  }
  for (const h of s.history || []) {
    const li = document.createElement('li');
    li.className = 'media-recent-item';
    const a = document.createElement('a');
    a.textContent = h.title;
    if (h.url) { a.href = h.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    const meta = document.createElement('span');
    meta.className = 'media-recent-meta';
    meta.textContent = dailyWhen(h.at);
    li.append(a, meta);
    els.dailyHistory.appendChild(li);
  }
}

function dailyForm() {
  const type = els.dailyTargetType.value;
  return {
    enabled: els.dailyEnabled.checked,
    brief: els.dailyBrief.value,
    hours: els.dailyHours.value.split(/[\s,;]+/).filter(Boolean).map(Number),
    timezone: els.dailyTimezone.value.trim() || 'UTC',
    provider: els.dailyProvider.value,
    model: els.dailyModel.value.trim(),
    target: {
      type,
      repo: els.dailyRepo.value.trim(),
      branch: els.dailyBranch.value.trim() || 'main',
      dir: els.dailyDir.value,
      token: (type === 'webhook' ? els.dailyHookToken.value : els.dailyGhToken.value).trim(),
      url: els.dailyHookUrl.value.trim(),
      siteUrl: els.dailySiteUrl.value.trim(),
    },
  };
}

function dailyMessage(text, bad = false) {
  els.dailyResult.textContent = text;
  els.dailyResult.classList.toggle('bad', bad);
}

async function loadDaily() {
  try {
    renderDaily(await dailyApi('GET'));
  } catch (err) {
    els.dailyStatus.textContent = err.message || 'Could not load daily pages.';
    els.dailyStatus.classList.add('bad');
  }
}

async function saveDaily() {
  try {
    renderDaily(await dailyApi('PUT', '', dailyForm()));
    dailyMessage('Saved.');
    flashButton(els.dailySaveBtn, 'Saved ✓');
  } catch (err) {
    dailyMessage(`Save failed: ${err.message}`, true);
  }
}

async function runDaily(dry) {
  const btn = dry ? els.dailyPreviewBtn : els.dailyRunBtn;
  if (!dry && !confirm('Make one page and post it to the live destination now?')) return;
  els.dailyPreview.hidden = true;
  btn.disabled = true;
  dailyMessage(dry ? 'Making a page… this takes 1–3 minutes.' : 'Making a page and posting it… this takes 1–3 minutes.');
  try {
    // Save first so the run uses what is on screen.
    await dailyApi('PUT', '', dailyForm());
    const out = await dailyApi('POST', `?action=run${dry ? '&dry=1' : ''}`);
    const r = out.result;
    if (dry) {
      els.dailyPreview.srcdoc = r.html;
      els.dailyPreview.hidden = false;
      dailyMessage(`Preview: "${r.title}" (${Math.round(r.bytes / 1000)} KB, ${r.model}). It passed every check and nothing was posted. Try the controls below.`);
    } else {
      dailyMessage(`Posted "${r.title}".${r.url ? ` ${r.url}` : ''}`);
    }
    renderDaily(await dailyApi('GET'));
  } catch (err) {
    dailyMessage(err.message || 'Run failed.', true);
    loadDaily();
  } finally {
    btn.disabled = false;
  }
}

els.dailyTargetType?.addEventListener('change', syncDailyTarget);
els.dailySaveBtn?.addEventListener('click', saveDaily);
els.dailyPreviewBtn?.addEventListener('click', () => runDaily(true));
els.dailyRunBtn?.addEventListener('click', () => runDaily(false));

refresh();
refreshMedia();
loadDaily();
