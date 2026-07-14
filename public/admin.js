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
  personaPromptInput: $('personaPromptInput'),
  savePersonaBtn: $('savePersonaBtn'),
  deletePersonaBtn: $('deletePersonaBtn'),
  exportAdminBtn: $('exportAdminBtn'),
  importAdminBtn: $('importAdminBtn'),
  importAdminFile: $('importAdminFile'),
  signOutBtn: $('signOutBtn'),
};

let data = { masterPrompt: '', personas: [] };
let selectedPersonaId = null;

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
  els.personaPromptInput.value = p.systemPrompt || '';
  els.personaNameInput.disabled = !!p.builtin;
  els.personaPromptInput.disabled = !!p.builtin;
  els.savePersonaBtn.disabled = !!p.builtin;
  els.deletePersonaBtn.disabled = !!p.builtin;
  renderPersonaList();
}

async function refresh() {
  try {
    const fresh = await apiGet();
    data = { masterPrompt: fresh.masterPrompt || '', personas: fresh.personas || [] };
    els.masterPromptInput.value = data.masterPrompt;
    if (!data.personas.some((p) => p.id === selectedPersonaId)) {
      selectedPersonaId = data.personas[0]?.id || null;
    }
    renderPersonaList();
    if (selectedPersonaId) selectPersona(selectedPersonaId);
  } catch (err) {
    showBootError(err.message);
  }
}

async function commit() {
  try {
    const updated = await apiPut({
      masterPrompt: data.masterPrompt,
      personas: data.personas.filter((p) => !p.builtin),
    });
    data = { masterPrompt: updated.masterPrompt || '', personas: updated.personas || [] };
    if (!data.personas.some((p) => p.id === selectedPersonaId)) {
      selectedPersonaId = data.personas[0]?.id || null;
    }
    renderPersonaList();
    if (selectedPersonaId) selectPersona(selectedPersonaId);
  } catch (err) {
    alert('Save failed: ' + err.message);
    throw err;
  }
}

function newPersona() {
  const p = { id: uid(), name: 'New persona', systemPrompt: 'You are ...', builtin: false };
  data.personas.push(p);
  selectedPersonaId = p.id;
  renderPersonaList();
  selectPersona(p.id);
  els.personaNameInput.focus();
  els.personaNameInput.select();
}

async function savePersona() {
  const p = data.personas.find((x) => x.id === selectedPersonaId);
  if (!p || p.builtin) return;
  p.name = els.personaNameInput.value.trim() || 'Untitled persona';
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
        .map((p) => ({ id: p.id, name: p.name || 'Imported', systemPrompt: p.systemPrompt || '', builtin: false }));
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

refresh();
