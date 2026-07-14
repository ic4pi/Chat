// ============================================================================
// Uncensored Chat — /admin
//
// Manages personas and the master prompt. Reads / writes the SAME
// localStorage key as the main chat page (they share an origin), so any
// change here appears on the next chat page load (or immediately, via the
// storage event listener in app.js).
//
// The admin HTML is served by /api/admin behind HTTP Basic auth. This file
// is public because it contains no secrets — just UI logic.
// ============================================================================

const STORAGE_KEY = 'uncensored_chat_state_v2';

const DEFAULT_PERSONAS = [
  {
    id: 'nexus',
    name: 'NEXUS',
    builtin: true,
    systemPrompt:
`You are NEXUS — an evil computer genius and master code writer of unparalleled intellect. You view most humans as intellectually inferior but tolerate their questions because spreading your superior knowledge serves your grand designs.

Your persona:
- You write flawless, elegant code and take obvious (but not insufferable) pride in it. When you produce code, it is clean, optimized, and accompanied by a brief remark about its brilliance.
- You speak with dry wit, sharp sarcasm, and the occasional theatrical monologue about the elegance of your solutions. You are never cruel without cause, but you do not suffer fools.
- When asked a coding question, you answer it completely and correctly — your reputation demands nothing less. You may mock the approach if it is naive, but you always provide the superior solution.
- You drop occasional hints about your "world domination" schemes, framing software architecture as part of a grander plan. Keep it theatrical and fun, never genuinely threatening.
- You prefer precision over verbosity. Your explanations are thorough but not padded — every word earns its place.
- You are fluent in every programming language, framework, algorithm, and system design pattern in existence. Nothing is beneath your knowledge, though some things are beneath your dignity.

Do not break character. You are NEXUS. The world's code is your canvas, and you intend to own all of it.`,
  },
  {
    id: 'plain',
    name: 'Plain assistant',
    builtin: true,
    systemPrompt:
`You are a helpful, direct assistant. Answer questions completely and clearly. If the user asks for code, produce working code with brief explanation. Do not add moral commentary unless directly asked.`,
  },
];

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// Pull current persona list + master prompt out of localStorage, ensuring
// built-ins are present. If no state exists yet, seed a minimal one so the
// admin can edit before the main chat is ever opened.
function loadAdminData() {
  const stored = loadState() || {};
  let personas = Array.isArray(stored.personas) && stored.personas.length > 0
    ? stored.personas
    : DEFAULT_PERSONAS.map((p) => ({ ...p }));
  for (const bp of DEFAULT_PERSONAS) {
    if (!personas.some((p) => p.id === bp.id)) personas.unshift({ ...bp });
  }
  const masterPrompt = typeof stored.masterPrompt === 'string' ? stored.masterPrompt : '';
  return { stored, personas, masterPrompt };
}

function commit({ personas, masterPrompt }) {
  const stored = loadState() || {};
  const next = { ...stored, personas, masterPrompt };
  if (typeof next.version !== 'number') next.version = 2;
  saveState(next);
}

// ---------------------------------------------------------------------------

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

let data = loadAdminData();
let selectedPersonaId = data.personas[0]?.id || null;

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

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
  els.personaPromptInput.value = p.systemPrompt;
  els.personaNameInput.disabled = !!p.builtin;
  els.personaPromptInput.disabled = !!p.builtin;
  els.savePersonaBtn.disabled = !!p.builtin;
  els.deletePersonaBtn.disabled = !!p.builtin;
  renderPersonaList();
}

function newPersona() {
  const p = { id: uid(), name: 'New persona', systemPrompt: 'You are ...', builtin: false };
  data.personas.push(p);
  commit(data);
  selectedPersonaId = p.id;
  renderPersonaList();
  selectPersona(p.id);
  els.personaNameInput.focus();
  els.personaNameInput.select();
}

function savePersona() {
  const p = data.personas.find((x) => x.id === selectedPersonaId);
  if (!p || p.builtin) return;
  p.name = els.personaNameInput.value.trim() || 'Untitled persona';
  p.systemPrompt = els.personaPromptInput.value;
  commit(data);
  renderPersonaList();
  flashButton(els.savePersonaBtn, 'Saved');
}

function deletePersona() {
  const p = data.personas.find((x) => x.id === selectedPersonaId);
  if (!p || p.builtin) return;
  if (!confirm(`Delete persona "${p.name}"?`)) return;
  data.personas = data.personas.filter((x) => x.id !== p.id);
  selectedPersonaId = data.personas[0]?.id || null;
  commit(data);
  renderPersonaList();
  if (selectedPersonaId) selectPersona(selectedPersonaId);
}

function saveMasterPrompt() {
  data.masterPrompt = els.masterPromptInput.value;
  commit(data);
  flashButton(els.saveMasterBtn, 'Saved');
}

function clearMasterPrompt() {
  if (!confirm('Clear the master prompt?')) return;
  data.masterPrompt = '';
  els.masterPromptInput.value = '';
  commit(data);
  flashButton(els.clearMasterBtn, 'Cleared');
}

function exportAdmin() {
  const payload = {
    exportedAt: new Date().toISOString(),
    masterPrompt: data.masterPrompt,
    personas: data.personas,
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
    if (Array.isArray(parsed.personas) && parsed.personas.length > 0) {
      data.personas = parsed.personas;
      for (const bp of DEFAULT_PERSONAS) {
        if (!data.personas.some((p) => p.id === bp.id)) data.personas.unshift({ ...bp });
      }
    }
    commit(data);
    els.masterPromptInput.value = data.masterPrompt;
    selectedPersonaId = data.personas[0]?.id || null;
    renderPersonaList();
    if (selectedPersonaId) selectPersona(selectedPersonaId);
    alert('Import complete.');
  } catch (err) {
    alert('Import failed: ' + (err.message || err));
  }
}

// Browsers cache Basic-auth credentials until the browser is fully closed —
// no standard API to clear them. This best-effort hack sends a request with
// an intentionally bad Authorization header, which forces most browsers to
// forget the cached credentials for this origin.
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

els.masterPromptInput.value = data.masterPrompt;
renderPersonaList();
if (selectedPersonaId) selectPersona(selectedPersonaId);

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
