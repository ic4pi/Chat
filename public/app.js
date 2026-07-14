// ============================================================================
// Uncensored Chat — frontend logic
//
// Responsibilities:
//   - Persistent chats + personas + artifacts in localStorage.
//   - Live-fetch Venice model catalog from /api/models?provider=venice.
//   - Persona manager (hidden screen) opened via ⚙ button or ⌘/Ctrl+K.
//   - Artifact extraction: any fenced code block > 3 lines in a bot reply is
//     surfaced in the right sidebar with copy + download.
//   - No silent model swapping — errors from the selected provider/model are
//     shown verbatim.
// ============================================================================

const STORAGE_KEY = 'uncensored_chat_state_v3';

// Personas now live on the server (see /api/public-config). This is only a
// bootstrap fallback used before the first /api/public-config response
// arrives, and if the site is loaded while offline. Descriptions are
// user-facing metadata; system prompts are NEVER sent to the browser.
const FALLBACK_PERSONAS = [
  { id: 'nexus', name: 'NEXUS', description: 'An evil-genius coder who writes flawless code with theatrical flair.', builtin: true },
  { id: 'plain', name: 'Plain assistant', description: 'A neutral, no-nonsense assistant.', builtin: true },
];

// Only used if the live /api/models call fails (e.g. VENICE_API_KEY missing).
// All Venice text models are uncensored — Venice does not moderate outputs.
const VENICE_FALLBACK_MODELS = [
  { id: 'venice-uncensored', name: 'Venice Uncensored (Dolphin-Mistral 24B)', description: 'Venice\'s flagship uncensored fine-tune.' },
  { id: 'olafangensan-glm-4.7-flash-heretic', name: 'GLM 4.7 Flash Heretic (200k)', description: 'Decensored GLM-4.7-Flash 30B-A3B MoE.' },
  { id: 'dolphin-2.9.2-qwen2-72b', name: 'Dolphin 2.9.2 Qwen2 72B', description: 'Dolphin uncensored fine-tune of Qwen2 72B.' },
  { id: 'hermes-3-llama-3.1-405b', name: 'Hermes 3 Llama 3.1 405B', description: 'Nous Hermes 3, steerable uncensored fine-tune.' },
  { id: 'qwen3-235b-a22b-instruct-2507', name: 'Qwen3 235B Instruct', description: 'Qwen3 235B (MoE, 22B active) instruct.' },
  { id: 'qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B', description: 'Qwen3 coder MoE, strong on code.' },
  { id: 'qwen3-next-80b', name: 'Qwen3 Next 80B', description: 'Qwen3 Next general model.' },
  { id: 'qwen3-4b', name: 'Qwen3 4B (Venice Small)', description: 'Small, fast Qwen3.' },
  { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', description: 'General-purpose Llama 3.3.' },
  { id: 'mistral-31-24b', name: 'Mistral 3.1 24B (Venice Medium)', description: 'Mistral 3.1 with vision.' },
];

// Static OpenRouter model list. Venice models come from /api/models live.
// Only uncensored fine-tunes are listed — the previous Gemma entry was pulled
// because google/gemma is safety-tuned and refuses on-topic prompts, which is
// exactly the behavior this app exists to avoid. Add more slugs here if you
// want; anything from https://openrouter.ai/models works.
const OPENROUTER_MODELS = [
  { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', name: 'Dolphin-Mistral 24B Venice Edition (free)' },
  { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Hermes 3 405B (free)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct (free)' },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Explicit per-model fallback map. Only these very specific (provider, model)
// pairs get a silent retry, and only to the paired (provider, model). We do
// NOT fall back to a random OpenRouter free-tier model — that was the
// original bug that produced censored refusals from models the user never
// picked. The only fallback we do is same-spirit: the free OpenRouter mirror
// of Venice's Dolphin-Mistral falls back to Venice's own copy, funded by the
// user's Venice credits.
const MODEL_FALLBACKS = {
  openrouter: {
    'cognitivecomputations/dolphin-mistral-24b-venice-edition:free': {
      provider: 'venice',
      model: 'venice-uncensored',
      reason: 'OpenRouter free Dolphin-Venice unavailable — used your Venice key on venice-uncensored instead.',
    },
  },
};

function freshState() {
  return {
    version: 3,
    chats: [],
    activeChatId: null,
    activePersonaId: 'nexus',
    activeProvider: 'openrouter',
    activeModel: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    chatsCollapsed: false,
    chatsCollapsedExplicit: false,
    artifactsCollapsed: true,
  };
}

// Persona list is populated by fetchPersonas() from /api/public-config.
// Not persisted — always fetched fresh so admin edits show up on next load.
let personas = FALLBACK_PERSONAS.slice();

const MOBILE_QUERY = '(max-width: 900px)';
function isMobileViewport() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia(MOBILE_QUERY).matches;
}

// If the user has never touched the chats-sidebar toggle, its collapsed state
// is decided by the viewport: collapsed on mobile, open on desktop. Once the
// user clicks the toggle even once, their choice is remembered.
function effectiveChatsCollapsed() {
  return state.chatsCollapsedExplicit ? !!state.chatsCollapsed : isMobileViewport();
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch (err) {
    console.warn('Failed to parse stored state, starting fresh:', err);
    return freshState();
  }
}

function migrate(s) {
  const base = freshState();
  const merged = { ...base, ...s };
  // Drop any legacy personas / masterPrompt kept in localStorage from
  // pre-v3 (they now live server-side in KV, exposed via /api/public-config
  // and applied by /api/chat).
  delete merged.personas;
  delete merged.masterPrompt;
  merged.version = 3;
  merged.chats = Array.isArray(s.chats) ? s.chats : [];
  merged.chats = merged.chats.map((c) => ({
    id: c.id,
    name: c.name || 'Untitled',
    provider: c.provider || 'venice',
    model: c.model || 'venice-uncensored',
    personaId: c.personaId || 'nexus',
    messages: Array.isArray(c.messages) ? c.messages : [],
    artifacts: Array.isArray(c.artifacts) ? c.artifacts : [],
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now(),
  }));
  return merged;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Failed to save state (localStorage full?):', err);
  }
}

const state = loadState();

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function activeChat() {
  return state.chats.find((c) => c.id === state.activeChatId) || null;
}

function ensureActiveChat() {
  let chat = activeChat();
  if (!chat) {
    chat = createChat();
  }
  return chat;
}

function createChat() {
  const chat = {
    id: uid(),
    name: 'New chat',
    provider: state.activeProvider,
    model: state.activeModel,
    personaId: state.activePersonaId,
    messages: [],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  saveState();
  return chat;
}

function deleteChat(id) {
  const idx = state.chats.findIndex((c) => c.id === id);
  if (idx === -1) return;
  state.chats.splice(idx, 1);
  if (state.activeChatId === id) {
    state.activeChatId = state.chats[0]?.id || null;
  }
  saveState();
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  app: $('app'),
  chatsSidebar: $('chatsSidebar'),
  artifactsSidebar: $('artifactsSidebar'),
  closeChats: $('closeChats'),
  backdrop: $('backdrop'),
  chatList: $('chatList'),
  newChatBtn: $('newChatBtn'),
  newChatTopBtn: $('newChatTopBtn'),
  toggleChats: $('toggleChats'),
  toggleArtifacts: $('toggleArtifacts'),
  closeArtifacts: $('closeArtifacts'),
  chatTitle: $('chatTitle'),
  providerSelect: $('providerSelect'),
  modelSelect: $('modelSelect'),
  personaSelect: $('personaSelect'),
  personaDescription: $('personaDescription'),
  artifactList: $('artifactList'),
  artifactModal: $('artifactModal'),
  artifactModalTitle: $('artifactModalTitle'),
  artifactModalContent: $('artifactModalContent'),
  artifactCopyBtn: $('artifactCopyBtn'),
  artifactDownloadBtn: $('artifactDownloadBtn'),
  closeArtifactModal: $('closeArtifactModal'),
  chat: $('chat'),
  typing: $('typing'),
  inputForm: $('inputForm'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
  clearAllBtn: $('clearAllBtn'),
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function applySidebarState() {
  const chatsCollapsed = effectiveChatsCollapsed();
  const artifactsCollapsed = !!state.artifactsCollapsed;
  els.app.classList.toggle('chats-collapsed', chatsCollapsed);
  els.app.classList.toggle('artifacts-collapsed', artifactsCollapsed);
  els.chatsSidebar.classList.toggle('collapsed', chatsCollapsed);
  els.artifactsSidebar.classList.toggle('collapsed', artifactsCollapsed);
  const anySidebarOpen = !chatsCollapsed || !artifactsCollapsed;
  els.backdrop.classList.toggle('visible', isMobileViewport() && anySidebarOpen);
}

function closeChatsSidebar() {
  state.chatsCollapsed = true;
  state.chatsCollapsedExplicit = true;
  saveState();
  applySidebarState();
}
function closeArtifactsSidebar() {
  state.artifactsCollapsed = true;
  saveState();
  applySidebarState();
}
function closeAllSidebars() {
  closeChatsSidebar();
  closeArtifactsSidebar();
}

function renderChatList() {
  els.chatList.innerHTML = '';
  for (const c of state.chats) {
    const li = document.createElement('li');
    if (c.id === state.activeChatId) li.classList.add('active');

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = c.name || 'Untitled';
    nameEl.title = c.name || 'Untitled';
    nameEl.addEventListener('click', () => {
      state.activeChatId = c.id;
      state.activeProvider = c.provider;
      state.activeModel = c.model;
      state.activePersonaId = c.personaId;
      if (isMobileViewport()) {
        state.chatsCollapsed = true;
        state.chatsCollapsedExplicit = true;
      }
      saveState();
      renderAll();
    });

    const save = document.createElement('button');
    save.className = 'chat-action save-chat';
    save.textContent = '⤓';
    save.title = 'Save chat to file (JSON)';
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadChat(c);
    });

    const del = document.createElement('button');
    del.className = 'chat-action delete-chat';
    del.textContent = '×';
    del.title = 'Delete chat';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${c.name}"?`)) {
        deleteChat(c.id);
        renderAll();
      }
    });

    li.appendChild(nameEl);
    li.appendChild(save);
    li.appendChild(del);
    els.chatList.appendChild(li);
  }
  if (state.chats.length === 0) {
    const hint = document.createElement('li');
    hint.className = 'chat-hint';
    hint.textContent = 'Chats you start will appear here. They\'re saved to this browser automatically.';
    els.chatList.appendChild(hint);
  }
}

function downloadChat(chat) {
  const blob = new Blob([JSON.stringify(chat, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const safeName = (chat.name || 'chat').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'chat';
  link.href = url;
  link.download = `${safeName}-${new Date(chat.updatedAt || Date.now()).toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function renderChatTitle() {
  const chat = activeChat();
  els.chatTitle.textContent = chat ? chat.name : 'Untitled';
}

function renderMessages() {
  els.chat.innerHTML = '';
  const chat = activeChat();
  if (!chat) return;
  for (const m of chat.messages) {
    renderMessageInto(els.chat, m);
  }
  els.chat.scrollTop = els.chat.scrollHeight;
}

function renderMessageInto(container, m) {
  const cls =
    m.role === 'user' ? 'user' :
    m.role === 'error' ? 'error' :
    m.role === 'info' ? 'info' :
    'bot';

  const div = document.createElement('div');
  div.className = 'msg ' + cls;

  const label = document.createElement('span');
  label.className = 'role';
  label.textContent =
    m.role === 'user' ? 'you' :
    m.role === 'error' ? 'error' :
    m.role === 'info' ? 'notice' :
    m.role === 'assistant' ? (m.model ? `model · ${m.model}` : 'model') :
    m.role;
  div.appendChild(label);

  const content = document.createElement('div');
  content.className = 'content';

  if (m.role === 'assistant') {
    renderMarkdownInto(content, m.content || '');
  } else {
    content.textContent = m.content || '';
  }
  div.appendChild(content);
  container.appendChild(div);
}

// Minimal markdown-esque renderer for the bot output. Only handles fenced code
// blocks (```lang ... ```) — everything else is inserted as plain text nodes so
// there is no XSS surface. Code blocks become <pre class="code-block"> elements.
function renderMarkdownInto(container, text) {
  const parts = splitByCodeFences(text);
  for (const part of parts) {
    if (part.type === 'code') {
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      if (part.lang) {
        const lang = document.createElement('span');
        lang.className = 'code-lang';
        lang.textContent = part.lang;
        pre.appendChild(lang);
      }
      const code = document.createElement('code');
      code.textContent = part.content;
      pre.appendChild(code);
      container.appendChild(pre);
    } else if (part.content.length > 0) {
      const p = document.createElement('p');
      p.textContent = part.content;
      container.appendChild(p);
    }
  }
}

// Split "hello ```py\ncode\n``` there" into [{type:text}, {type:code}, {type:text}]
function splitByCodeFences(text) {
  const out = [];
  const re = /```([a-zA-Z0-9_+\-.]*)\s*\n([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', content: text.slice(last, m.index) });
    out.push({ type: 'code', lang: m[1] || '', content: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', content: text.slice(last) });
  return out;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

const LANG_EXT = {
  python: 'py', py: 'py',
  javascript: 'js', js: 'js',
  typescript: 'ts', ts: 'ts',
  jsx: 'jsx', tsx: 'tsx',
  html: 'html', css: 'css',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
  json: 'json', yaml: 'yml', yml: 'yml',
  markdown: 'md', md: 'md',
  rust: 'rs', rs: 'rs',
  go: 'go',
  java: 'java', kotlin: 'kt', swift: 'swift',
  cpp: 'cpp', 'c++': 'cpp',
  c: 'c', h: 'h',
  csharp: 'cs', cs: 'cs',
  ruby: 'rb', rb: 'rb',
  php: 'php',
  sql: 'sql',
  toml: 'toml', ini: 'ini',
  xml: 'xml', svg: 'svg',
  dockerfile: 'Dockerfile',
  lua: 'lua', r: 'r',
};

function extensionForLang(lang) {
  if (!lang) return 'txt';
  const l = lang.toLowerCase();
  return LANG_EXT[l] || 'txt';
}

// Detect artifacts in a bot response. Rules:
//   - Any fenced code block >= 3 lines becomes an artifact.
//   - If the block is preceded by a "```lang title=xyz" or a hint line like
//     `File: name.ext` on the previous line, use that as the title.
function extractArtifacts(text) {
  const artifacts = [];
  const re = /(?:^|\n)([^\n]*)\n```([a-zA-Z0-9_+\-.]*)\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const hint = (m[1] || '').trim();
    const lang = (m[2] || '').trim();
    const content = m[3];
    const lines = content.split('\n').length;
    if (lines < 3) continue;
    let title = '';
    const fileMatch = hint.match(/(?:file|filename|path)\s*[:=]\s*[`'"]?([^\s`'"]+)[`'"]?/i);
    if (fileMatch) title = fileMatch[1];
    if (!title) {
      const firstLine = content.split('\n').find((ln) => ln.trim().length > 0) || '';
      const commentPath = firstLine.match(/(?:#|\/\/|--)\s*(?:file|filename|path)?\s*[:=]?\s*([\w\-./]+\.[a-zA-Z0-9]+)/);
      if (commentPath) title = commentPath[1];
    }
    if (!title) {
      const ext = extensionForLang(lang);
      title = `snippet-${artifacts.length + 1}.${ext}`;
    }
    artifacts.push({
      id: uid(),
      title,
      language: lang || 'text',
      content,
      createdAt: Date.now(),
    });
  }
  return artifacts;
}

function renderArtifacts() {
  els.artifactList.innerHTML = '';
  const chat = activeChat();
  if (!chat) return;
  for (const a of chat.artifacts) {
    const li = document.createElement('li');
    li.dataset.id = a.id;

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = a.title;
    title.title = a.title;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const langSpan = document.createElement('span');
    langSpan.textContent = a.language || 'text';
    const linesSpan = document.createElement('span');
    linesSpan.textContent = `${a.content.split('\n').length} lines`;
    meta.appendChild(langSpan);
    meta.appendChild(linesSpan);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', (e) => { e.stopPropagation(); openArtifactModal(a); });

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(a.content).then(() => flashButton(copyBtn, 'Copied'));
    });

    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', (e) => { e.stopPropagation(); downloadArtifact(a); });

    actions.appendChild(viewBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(dlBtn);

    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(actions);
    li.addEventListener('click', () => openArtifactModal(a));

    els.artifactList.appendChild(li);
  }
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

function downloadArtifact(a) {
  const blob = new Blob([a.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = a.title;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

let currentArtifact = null;
function openArtifactModal(a) {
  currentArtifact = a;
  els.artifactModalTitle.textContent = `${a.title}  ·  ${a.language}`;
  els.artifactModalContent.textContent = a.content;
  els.artifactModal.classList.remove('hidden');
}
function closeArtifactModal() {
  currentArtifact = null;
  els.artifactModal.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

// Pulls the current persona list from /api/public-config. Only IDs and names
// come back — persona system prompts and the master prompt are secrets kept
// server-side. Falls back to FALLBACK_PERSONAS on any failure so the UI
// remains usable even without a network / with KV unconfigured.
async function fetchPersonas() {
  try {
    const res = await fetch('/api/public-config');
    if (!res.ok) throw new Error(`public-config HTTP ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data.personas) && data.personas.length > 0) {
      personas = data.personas.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        builtin: !!p.builtin,
      }));
    }
  } catch (err) {
    console.warn('Failed to fetch personas from server:', err);
  }
  if (!personas.some((p) => p.id === state.activePersonaId)) {
    state.activePersonaId = personas[0]?.id || 'nexus';
    saveState();
  }
  renderPersonaSelect();
}

function renderPersonaSelect() {
  els.personaSelect.innerHTML = '';
  for (const p of personas) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.description) opt.title = p.description;
    els.personaSelect.appendChild(opt);
  }
  els.personaSelect.value = state.activePersonaId;
  renderPersonaDescription();
}

function renderPersonaDescription() {
  const p = personas.find((x) => x.id === state.activePersonaId);
  const text = (p && p.description) || '';
  if (text) {
    els.personaDescription.textContent = text;
    els.personaDescription.hidden = false;
  } else {
    els.personaDescription.textContent = '';
    els.personaDescription.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

let veniceModelsCache = null;

async function loadVeniceModels() {
  if (veniceModelsCache) return veniceModelsCache;
  try {
    const res = await fetch('/api/models?provider=venice');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load Venice models');
    veniceModelsCache = data.models || [];
    return veniceModelsCache;
  } catch (err) {
    console.warn('Could not fetch Venice model list:', err);
    return null;
  }
}

async function renderModelSelect() {
  els.modelSelect.innerHTML = '';
  const provider = state.activeProvider;

  if (provider === 'venice') {
    const models = await loadVeniceModels();
    if (!models) {
      const grp = document.createElement('optgroup');
      grp.label = 'Venice — all uncensored (fallback list, /api/models unreachable)';
      for (const fallback of VENICE_FALLBACK_MODELS) {
        const opt = document.createElement('option');
        opt.value = fallback.id;
        opt.textContent = fallback.name;
        opt.title = fallback.description || '';
        grp.appendChild(opt);
      }
      els.modelSelect.appendChild(grp);
    } else {
      // All Venice text models are uncensored — Venice does not apply
      // server-side moderation. Show them in one flat group; sort so
      // dedicated uncensored fine-tunes (Heretic, Dolphin, abliterated…)
      // appear first for discoverability, then everything else by name.
      const sorted = models.slice().sort((a, b) => {
        if (a.uncensored !== b.uncensored) return a.uncensored ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const grp = document.createElement('optgroup');
      grp.label = 'Venice — all uncensored';
      for (const m of sorted) grp.appendChild(makeModelOption(m));
      els.modelSelect.appendChild(grp);
    }
  } else {
    for (const m of OPENROUTER_MODELS) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      els.modelSelect.appendChild(opt);
    }
  }

  const available = Array.from(els.modelSelect.options).map((o) => o.value);
  if (!available.includes(state.activeModel)) {
    state.activeModel = available[0] || state.activeModel;
    saveState();
  }
  els.modelSelect.value = state.activeModel;
}

function makeModelOption(m) {
  const opt = document.createElement('option');
  opt.value = m.id;
  const traitStr = m.traits && m.traits.length ? `  [${m.traits.join(', ')}]` : '';
  opt.textContent = `${m.name}${traitStr}`;
  if (m.description) opt.title = m.description;
  return opt;
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

async function callChat(provider, model, messages, personaId) {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model, provider, personaId }),
    });
    let data = null;
    let errText = null;
    try { data = await res.json(); } catch { errText = 'Non-JSON response'; }
    return { ok: res.ok, status: res.status, data, errText };
  } catch (err) {
    return { ok: false, status: 0, data: null, errText: err?.message || 'Network error' };
  }
}

// Only retry on transient / provider-side failures. Never retry on 400 (bad
// request), 401 (bad key), 402 (payment/credit), 403 (forbidden) — those are
// configuration issues the user needs to see.
function shouldFallback(attempt) {
  if (attempt.status === 0) return true;
  if (attempt.status >= 500) return true;
  if (attempt.status === 408 || attempt.status === 425 || attempt.status === 429) return true;
  const msg = (attempt.data?.error || attempt.errText || '').toString().toLowerCase();
  if (/provider returned error|no endpoints|temporarily unavailable|timed out|timeout|rate limit/.test(msg)) return true;
  return false;
}

async function sendMessage(text) {
  const chat = ensureActiveChat();

  chat.messages.push({ role: 'user', content: text, ts: Date.now() });
  if (chat.name === 'New chat' || chat.name === 'Untitled') {
    chat.name = text.slice(0, 40).trim() || 'Untitled';
  }
  chat.provider = state.activeProvider;
  chat.model = state.activeModel;
  chat.personaId = state.activePersonaId;
  chat.updatedAt = Date.now();
  saveState();
  renderChatList();
  renderChatTitle();
  renderMessages();

  els.sendBtn.disabled = true;
  els.typing.style.display = 'block';

  const apiMessages = chat.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    let attempt = await callChat(state.activeProvider, state.activeModel, apiMessages, state.activePersonaId);
    let usedFallback = null;

    if (!attempt.ok && shouldFallback(attempt)) {
      const fb = MODEL_FALLBACKS?.[state.activeProvider]?.[state.activeModel];
      if (fb) {
        const retry = await callChat(fb.provider, fb.model, apiMessages, state.activePersonaId);
        if (retry.ok) {
          attempt = retry;
          usedFallback = fb;
        }
      }
    }

    if (!attempt.ok) {
      const data = attempt.data || {};
      const where = data.provider ? ` [${data.provider} · ${data.model || state.activeModel}]` : '';
      chat.messages.push({ role: 'error', content: (data.error || attempt.errText || 'Request failed') + where, ts: Date.now() });
    } else {
      const data = attempt.data || {};
      if (usedFallback) {
        chat.messages.push({
          role: 'info',
          content: usedFallback.reason,
          ts: Date.now(),
        });
      }
      const reply = data.reply || '(empty response)';
      chat.messages.push({
        role: 'assistant',
        content: reply,
        ts: Date.now(),
        provider: data.provider,
        model: data.model,
      });
      const newArts = extractArtifacts(reply);
      if (newArts.length) {
        chat.artifacts.push(...newArts);
        if (state.artifactsCollapsed) {
          state.artifactsCollapsed = false;
          applySidebarState();
        }
      }
    }
    chat.updatedAt = Date.now();
    saveState();
    renderMessages();
    renderArtifacts();
  } catch (err) {
    chat.messages.push({ role: 'error', content: err.message || 'Network error', ts: Date.now() });
    saveState();
    renderMessages();
  } finally {
    els.sendBtn.disabled = false;
    els.typing.style.display = 'none';
    els.input.focus();
  }
}

// ---------------------------------------------------------------------------
// Export / import / clear
// ---------------------------------------------------------------------------

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `uncensored-chat-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const migrated = migrate(parsed);
    Object.assign(state, migrated);
    saveState();
    await renderAll();
    alert('Import complete.');
  } catch (err) {
    alert('Import failed: ' + (err.message || err));
  }
}

function clearAll() {
  if (!confirm('Delete ALL chats, personas, and settings from this browser?')) return;
  localStorage.removeItem(STORAGE_KEY);
  Object.assign(state, freshState());
  renderAll();
}

// ---------------------------------------------------------------------------
// Renderers wiring
// ---------------------------------------------------------------------------

async function renderAll() {
  ensureActiveChat();
  applySidebarState();
  renderChatList();
  renderChatTitle();
  renderPersonaSelect();
  els.providerSelect.value = state.activeProvider;
  await Promise.all([renderModelSelect(), fetchPersonas()]);
  renderMessages();
  renderArtifacts();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

els.inputForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  els.input.style.height = 'auto';
  sendMessage(text);
});

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.inputForm.requestSubmit();
  }
});

function handleNewChat() {
  createChat();
  if (isMobileViewport()) {
    state.chatsCollapsed = true;
    state.chatsCollapsedExplicit = true;
    saveState();
  }
  renderAll().catch((err) => console.error(err));
  els.input.focus();
}
els.newChatBtn.addEventListener('click', handleNewChat);
els.newChatTopBtn.addEventListener('click', handleNewChat);

els.toggleChats.addEventListener('click', () => {
  state.chatsCollapsed = !effectiveChatsCollapsed();
  state.chatsCollapsedExplicit = true;
  saveState();
  applySidebarState();
});

if (typeof window !== 'undefined' && window.matchMedia) {
  const mql = window.matchMedia(MOBILE_QUERY);
  const onChange = () => {
    if (!state.chatsCollapsedExplicit) applySidebarState();
  };
  if (mql.addEventListener) mql.addEventListener('change', onChange);
  else if (mql.addListener) mql.addListener(onChange);
}
els.toggleArtifacts.addEventListener('click', () => {
  state.artifactsCollapsed = !state.artifactsCollapsed;
  saveState();
  applySidebarState();
});
els.closeArtifacts.addEventListener('click', closeArtifactsSidebar);
els.closeChats.addEventListener('click', closeChatsSidebar);
els.backdrop.addEventListener('click', closeAllSidebars);

els.chatTitle.addEventListener('blur', () => {
  const chat = activeChat();
  if (!chat) return;
  const text = els.chatTitle.textContent.trim() || 'Untitled';
  chat.name = text;
  chat.updatedAt = Date.now();
  saveState();
  renderChatList();
});
els.chatTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.chatTitle.blur(); }
});

els.providerSelect.addEventListener('change', async () => {
  state.activeProvider = els.providerSelect.value;
  saveState();
  await renderModelSelect();
  saveState();
});
els.modelSelect.addEventListener('change', () => {
  state.activeModel = els.modelSelect.value;
  const chat = activeChat();
  if (chat) { chat.model = state.activeModel; chat.provider = state.activeProvider; }
  saveState();
});
els.personaSelect.addEventListener('change', () => {
  state.activePersonaId = els.personaSelect.value;
  const chat = activeChat();
  if (chat) chat.personaId = state.activePersonaId;
  saveState();
  renderPersonaDescription();
});

els.closeArtifactModal.addEventListener('click', closeArtifactModal);
els.artifactCopyBtn.addEventListener('click', () => {
  if (!currentArtifact) return;
  navigator.clipboard.writeText(currentArtifact.content).then(() => flashButton(els.artifactCopyBtn, 'Copied'));
});
els.artifactDownloadBtn.addEventListener('click', () => {
  if (currentArtifact) downloadArtifact(currentArtifact);
});

els.exportBtn.addEventListener('click', exportData);
els.importBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) importData(file);
  e.target.value = '';
});
els.clearAllBtn.addEventListener('click', clearAll);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.artifactModal.classList.contains('hidden')) closeArtifactModal();
  }
});

els.artifactModal.addEventListener('click', (e) => {
  if (e.target === els.artifactModal) closeArtifactModal();
});

// Refresh the persona list when this tab regains focus, in case the admin
// updated it in another tab / on another device.
window.addEventListener('focus', () => { fetchPersonas(); });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function showBootError(msg) {
  const el = document.getElementById('bootError');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = 'Boot error: ' + msg + '\n\nTry a hard refresh, or open the ⚙ menu → Clear all to reset local state.';
}

renderAll().catch((err) => {
  console.error('renderAll failed:', err);
  showBootError(err?.stack || err?.message || String(err));
});
