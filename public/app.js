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

// Static fallback model lists when /api/models is unreachable.
const PROVIDER_FALLBACKS = {
  venice: VENICE_FALLBACK_MODELS,
  openrouter: [
    { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', name: 'Dolphin-Mistral 24B Venice Edition (free)' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b:free', name: 'Hermes 3 405B (free)' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct (free)' },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)' },
  ],
  cerebras: [
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    { id: 'qwen-3-32b', name: 'Qwen 3 32B' },
    { id: 'llama3.1-8b', name: 'Llama 3.1 8B' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
    { id: 'qwen/qwen3-32b', name: 'Qwen3 32B' },
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct' },
  ],
  nvidia: [
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'meta/llama-3.1-405b-instruct', name: 'Llama 3.1 405B Instruct' },
    { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B' },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B Instruct' },
  ],
};

const DEFAULT_MODELS = {
  venice: 'venice-uncensored',
  openrouter: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
  cerebras: 'llama-3.3-70b',
  groq: 'llama-3.3-70b-versatile',
  nvidia: 'meta/llama-3.3-70b-instruct',
};

const PROVIDER_IDS = ['venice', 'openrouter', 'cerebras', 'groq', 'nvidia'];
const PROVIDER_LABELS = {
  venice: 'Venice', openrouter: 'OpenRouter', cerebras: 'Cerebras', groq: 'Groq', nvidia: 'NVIDIA',
};

const KEYS_STORAGE = 'uncensored_provider_keys_v1';
const ROLES_STORAGE = 'uncensored_role_models_v1';

const DEFAULT_ROLE_MODELS = {
  write:  { provider: 'venice', model: 'venice-uncensored' },
  review: { provider: 'venice', model: 'olafangensan-glm-4.7-flash-heretic' },
  plan:   { provider: 'venice', model: 'qwen3-235b-a22b-instruct-2507' },
};

function loadProviderKeys() {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}
function saveProviderKeys(keys) {
  try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys)); } catch { /* ignore */ }
}
function loadRoleModels() {
  try {
    const raw = localStorage.getItem(ROLES_STORAGE);
    if (!raw) return { ...DEFAULT_ROLE_MODELS };
    const parsed = JSON.parse(raw) || {};
    return {
      write:  { ...DEFAULT_ROLE_MODELS.write,  ...parsed.write },
      review: { ...DEFAULT_ROLE_MODELS.review, ...parsed.review },
      plan:   { ...DEFAULT_ROLE_MODELS.plan,   ...parsed.plan },
    };
  } catch {
    return { ...DEFAULT_ROLE_MODELS };
  }
}
function saveRoleModels(roles) {
  try { localStorage.setItem(ROLES_STORAGE, JSON.stringify(roles)); } catch { /* ignore */ }
}

let providerKeys = loadProviderKeys();
let roleModels = loadRoleModels();
let pendingUploads = []; // { kind, name, content }
const modelsCache = {};

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
    activeRole: 'plan',
    // Venice by default — OpenRouter free-tier models routinely hang / 429,
    // which on iOS shows up as a multi-minute "thinking…" then "Load failed".
    activeProvider: 'venice',
    activeModel: 'venice-uncensored',
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
  roleSelect: $('roleSelect'),
  personaSelect: $('personaSelect'),
  voiceSelect: $('voiceSelect'),
  toneBtn: $('toneBtn'),
  toneModal: $('toneModal'),
  closeToneModal: $('closeToneModal'),
  toneRoleSelect: $('toneRoleSelect'),
  tonePersonaSelect: $('tonePersonaSelect'),
  toneVoiceSelect: $('toneVoiceSelect'),
  previewVoiceBtn: $('previewVoiceBtn'),
  saveToneBtn: $('saveToneBtn'),
  keysBtn: $('keysBtn'),
  keysModal: $('keysModal'),
  keysForm: $('keysForm'),
  closeKeysModal: $('closeKeysModal'),
  workspaceBtn: $('workspaceBtn'),
  attachBtn: $('attachBtn'),
  attachInput: $('attachInput'),
  attachPreview: $('attachPreview'),
  micBtn: $('micBtn'),
  speakBtn: $('speakBtn'),
  artifactList: $('artifactList'),
  artifactModal: $('artifactModal'),
  artifactModalTitle: $('artifactModalTitle'),
  artifactModalContent: $('artifactModalContent'),
  artifactCopyBtn: $('artifactCopyBtn'),
  artifactDownloadBtn: $('artifactDownloadBtn'),
  closeArtifactModal: $('closeArtifactModal'),
  chat: $('chat'),
  typing: $('typing'),
  typingStatus: $('typingStatus'),
  typingThoughts: $('typingThoughts'),
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

/** @param {{ scroll?: 'bottom' | 'assistant-start' | 'none', pinMsgTs?: number }} [opts] */
function renderMessages(opts = {}) {
  const scroll = opts.scroll || 'bottom';
  els.chat.innerHTML = '';
  const chat = activeChat();
  if (!chat) return;
  let pinEl = null;
  for (const m of chat.messages) {
    const el = renderMessageInto(els.chat, m);
    if (opts.pinMsgTs && m.ts === opts.pinMsgTs && m.role === 'assistant') {
      pinEl = el;
    }
  }
  // Default pin: latest assistant message
  if (scroll === 'assistant-start' && !pinEl) {
    const bots = els.chat.querySelectorAll('.msg.bot');
    pinEl = bots.length ? bots[bots.length - 1] : null;
  }
  if (scroll === 'assistant-start' && pinEl) {
    // Put the start of the reply near the top of the chat viewport
    requestAnimationFrame(() => {
      pinEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  } else if (scroll === 'bottom') {
    els.chat.scrollTop = els.chat.scrollHeight;
  }
}

function renderMessageInto(container, m) {
  const cls =
    m.role === 'user' ? 'user' :
    m.role === 'error' ? 'error' :
    m.role === 'info' ? 'info' :
    'bot';

  const div = document.createElement('div');
  div.className = 'msg ' + cls + (m.streaming ? ' streaming' : '');
  if (m.ts) div.dataset.ts = String(m.ts);

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
    renderMarkdownInto(content, m.content || (m.streaming ? '…' : ''));
    if (m.content && !m.streaming) {
      const speak = document.createElement('button');
      speak.type = 'button';
      speak.className = 'text-btn msg-speak';
      speak.textContent = 'Read aloud';
      speak.title = 'Speak this reply (works on iPhone)';
      speak.addEventListener('click', (e) => {
        e.preventDefault();
        unlockTts();
        setTimeout(() => speakReply(m.content, { force: true }), 120);
      });
      div.appendChild(speak);
    }
  } else {
    content.textContent = m.content || '';
  }
  div.appendChild(content);
  container.appendChild(div);
  return div;
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
  const fill = (selectEl) => {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    for (const p of personas) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.description) opt.title = p.description;
      selectEl.appendChild(opt);
    }
    selectEl.value = state.activePersonaId;
  };
  fill(els.personaSelect);
  fill(els.tonePersonaSelect);
  syncVoiceSelectToPersona();
}


// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

async function loadProviderModels(provider) {
  const key = (providerKeys[provider] || '').trim();
  const cacheKey = `${provider}:${key ? 'byok' : 'env'}`;
  if (modelsCache[cacheKey] && !key) return modelsCache[cacheKey];

  const headers = {};
  if (key) headers['X-Provider-Key'] = key;

  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load models');
    const models = data.models || [];
    if (!key) modelsCache[cacheKey] = models;
    return models.length ? models : (PROVIDER_FALLBACKS[provider] || []);
  } catch (err) {
    console.warn(`Could not fetch ${provider} model list:`, err);
    return PROVIDER_FALLBACKS[provider] || [];
  }
}

async function renderModelSelect() {
  els.modelSelect.innerHTML = '';
  const provider = state.activeProvider;
  const models = await loadProviderModels(provider);

  const sorted = models.slice().sort((a, b) => {
    if (!!a.uncensored !== !!b.uncensored) return a.uncensored ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });

  const grp = document.createElement('optgroup');
  grp.label = `${PROVIDER_LABELS[provider] || provider}${provider === 'venice' ? ' — all uncensored' : ''}`;
  for (const m of sorted) grp.appendChild(makeModelOption(m));
  els.modelSelect.appendChild(grp);

  const available = Array.from(els.modelSelect.options).map((o) => o.value);
  if (!available.includes(state.activeModel)) {
    state.activeModel = available[0] || DEFAULT_MODELS[provider] || state.activeModel;
    saveState();
  }
  els.modelSelect.value = state.activeModel;
}

function makeModelOption(m) {
  const opt = document.createElement('option');
  opt.value = m.id;
  const traitStr = m.traits && m.traits.length ? `  [${m.traits.join(', ')}]` : '';
  opt.textContent = `${m.name || m.id}${traitStr}`;
  if (m.description) opt.title = m.description;
  return opt;
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

// iOS Safari reports dropped/timed-out fetches as the useless string
// "Load failed". Map that (and similar) to something the user can act on.
function friendlyNetworkError(err) {
  const raw = (err?.message || String(err || 'Network error')).trim();
  const lower = raw.toLowerCase();
  if (
    lower === 'load failed' ||
    lower === 'failed to fetch' ||
    lower.includes('networkerror') ||
    lower.includes('the internet connection appears to be offline')
  ) {
    return 'Connection dropped before the model replied (often a timeout or flaky network). Try again, or pick a faster model.';
  }
  if (lower.includes('aborted') || lower.includes('timeout')) {
    return 'Request timed out waiting for the model. Try a faster model or a shorter prompt.';
  }
  return raw || 'Network error';
}

// Client cap sits under the server's 120s maxDuration so we surface a clean
// error instead of waiting on a dead socket. Free-tier OpenRouter gets a
// shorter leash so a dead free model doesn't burn two minutes before fallback.
const CHAT_CLIENT_TIMEOUT_MS = 115_000;
const CHAT_FREE_TIER_TIMEOUT_MS = 45_000;

function timeoutFor(provider, model) {
  if (provider === 'openrouter' && /:free$/i.test(model || '')) return CHAT_FREE_TIER_TIMEOUT_MS;
  return CHAT_CLIENT_TIMEOUT_MS;
}

async function callChat(provider, model, messages, personaId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(provider, model));
  const apiKey = (providerKeys[provider] || '').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Provider-Key'] = apiKey;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages,
        model,
        provider,
        personaId,
        role: state.activeRole || 'plan',
        apiKey: apiKey || undefined,
        stream: false,
      }),
      signal: controller.signal,
    });
    let data = null;
    let errText = null;
    try { data = await res.json(); } catch { errText = 'Non-JSON response'; }
    return { ok: res.ok, status: res.status, data, errText };
  } catch (err) {
    return { ok: false, status: 0, data: null, errText: friendlyNetworkError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream a chat completion. onEvent({type, ...}) for status/token/thinking/done/error.
 * Returns { ok, status, data, errText } shaped like callChat for fallbacks.
 */
async function callChatStream(provider, model, messages, personaId, onEvent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFor(provider, model));
  const apiKey = (providerKeys[provider] || '').trim();
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (apiKey) headers['X-Provider-Key'] = apiKey;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages,
        model,
        provider,
        personaId,
        role: state.activeRole || 'plan',
        apiKey: apiKey || undefined,
        stream: true,
      }),
      signal: controller.signal,
    });

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    // Non-SSE error JSON from our server
    if (!res.ok && !ctype.includes('text/event-stream')) {
      let data = null;
      let errText = null;
      try { data = await res.json(); } catch { errText = 'Non-JSON response'; }
      return { ok: false, status: res.status, data, errText };
    }

    if (!res.body) {
      return { ok: false, status: res.status, data: null, errText: 'No response body' };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let donePayload = null;
    let streamError = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (typeof onEvent === 'function') onEvent(evt);
        if (evt.type === 'done') donePayload = evt;
        if (evt.type === 'error') streamError = evt;
      }
    }

    if (streamError) {
      return {
        ok: false,
        status: 502,
        data: { error: streamError.error, provider: streamError.provider, model: streamError.model },
        errText: streamError.error,
      };
    }
    if (!donePayload) {
      return { ok: false, status: 502, data: null, errText: 'Stream ended without a reply' };
    }
    return {
      ok: true,
      status: 200,
      data: {
        reply: donePayload.reply || '',
        reasoning: donePayload.reasoning,
        provider: donePayload.provider,
        model: donePayload.model,
      },
      errText: null,
    };
  } catch (err) {
    return { ok: false, status: 0, data: null, errText: friendlyNetworkError(err) };
  } finally {
    clearTimeout(timer);
  }
}

function setTypingActive(on, statusText) {
  if (!els.typing) return;
  if (on) {
    els.typing.hidden = false;
    els.typing.dataset.active = '1';
    els.typing.style.display = 'block';
    if (els.typingStatus && statusText) els.typingStatus.textContent = statusText;
  } else {
    els.typing.dataset.active = '0';
    els.typing.style.display = 'none';
    els.typing.hidden = true;
    if (els.typingThoughts) {
      els.typingThoughts.textContent = '';
      els.typingThoughts.classList.add('hidden');
    }
  }
}

function appendTypingThought(text) {
  if (!els.typingThoughts || !text) return;
  els.typingThoughts.classList.remove('hidden');
  els.typingThoughts.textContent += text;
  els.typingThoughts.scrollTop = els.typingThoughts.scrollHeight;
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
  const uploads = pendingUploads.slice();
  pendingUploads = [];
  renderAttachPreview();

  let displayText = text;
  const imageParts = [];
  for (const u of uploads) {
    if (u.kind === 'text') {
      displayText += `\n\n[Uploaded file: ${u.name}]\n\`\`\`\n${u.content.slice(0, 80_000)}\n\`\`\``;
    } else {
      displayText += `\n\n[Uploaded image: ${u.name}]`;
      imageParts.push({ type: 'image_url', image_url: { url: u.content } });
    }
  }
  if (!displayText.trim() && imageParts.length === 0) return;

  chat.messages.push({ role: 'user', content: displayText, ts: Date.now() });
  if (chat.name === 'New chat' || chat.name === 'Untitled') {
    chat.name = (text || uploads[0]?.name || 'Untitled').slice(0, 40).trim() || 'Untitled';
  }
  chat.provider = state.activeProvider;
  chat.model = state.activeModel;
  chat.personaId = state.activePersonaId;
  chat.updatedAt = Date.now();
  saveState();
  renderChatList();
  renderChatTitle();
  renderMessages({ scroll: 'bottom' });

  els.sendBtn.disabled = true;
  const startedAt = Date.now();
  let tickTimer = null;
  const updateStatusClock = (base) => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    setTypingActive(true, `${base} · ${secs}s`);
  };
  setTypingActive(true, 'Sending…');
  tickTimer = setInterval(() => {
    const cur = els.typingStatus?.textContent || 'Waiting…';
    const base = cur.replace(/\s·\s\d+s$/, '');
    updateStatusClock(base);
  }, 1000);

  const apiMessages = chat.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => !m.streaming)
    .map((m, idx, arr) => {
      if (
        imageParts.length
        && idx === arr.length - 1
        && m.role === 'user'
      ) {
        return {
          role: 'user',
          content: [
            { type: 'text', text: m.content },
            ...imageParts,
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

  const assistantTs = Date.now();
  let pinnedToStart = false;
  let streamBuf = '';
  chat.messages.push({
    role: 'assistant',
    content: '',
    ts: assistantTs,
    streaming: true,
    model: state.activeModel,
    provider: state.activeProvider,
  });
  renderMessages({ scroll: 'assistant-start', pinMsgTs: assistantTs });
  pinnedToStart = true;

  const refreshStreamingBubble = () => {
    const msg = chat.messages.find((m) => m.ts === assistantTs && m.role === 'assistant');
    if (!msg) return;
    msg.content = streamBuf;
    // Update DOM in place to avoid scroll jumps
    const el = els.chat.querySelector(`.msg.bot[data-ts="${assistantTs}"] .content`);
    if (el) {
      el.innerHTML = '';
      renderMarkdownInto(el, streamBuf || '…');
    } else {
      renderMessages({ scroll: 'none' });
    }
  };

  try {
    updateStatusClock('Waiting for model');
    let attempt = await callChatStream(
      state.activeProvider,
      state.activeModel,
      apiMessages,
      state.activePersonaId,
      (evt) => {
        if (evt.type === 'status') {
          updateStatusClock(evt.message || 'Working…');
        } else if (evt.type === 'thinking') {
          appendTypingThought(evt.text || '');
          updateStatusClock('Thinking');
        } else if (evt.type === 'token') {
          streamBuf += evt.text || '';
          updateStatusClock('Writing');
          refreshStreamingBubble();
          if (!pinnedToStart) {
            renderMessages({ scroll: 'assistant-start', pinMsgTs: assistantTs });
            pinnedToStart = true;
          }
        }
      },
    );
    let usedFallback = null;

    if (!attempt.ok && shouldFallback(attempt)) {
      const fb = MODEL_FALLBACKS?.[state.activeProvider]?.[state.activeModel];
      if (fb) {
        updateStatusClock('Retrying on backup model');
        streamBuf = '';
        refreshStreamingBubble();
        const retry = await callChatStream(
          fb.provider,
          fb.model,
          apiMessages,
          state.activePersonaId,
          (evt) => {
            if (evt.type === 'status') updateStatusClock(evt.message || 'Working…');
            else if (evt.type === 'thinking') appendTypingThought(evt.text || '');
            else if (evt.type === 'token') {
              streamBuf += evt.text || '';
              updateStatusClock('Writing');
              refreshStreamingBubble();
            }
          },
        );
        if (retry.ok) {
          attempt = retry;
          usedFallback = fb;
        }
      }
    }

    // Remove streaming placeholder
    const idx = chat.messages.findIndex((m) => m.ts === assistantTs && m.role === 'assistant');
    if (idx !== -1) chat.messages.splice(idx, 1);

    if (!attempt.ok) {
      const data = attempt.data || {};
      const where = data.provider ? ` [${data.provider} · ${data.model || state.activeModel}]` : '';
      const rawErr = data.error || attempt.errText || 'Request failed';
      const errMsg = friendlyNetworkError({ message: String(rawErr) });
      chat.messages.push({ role: 'error', content: errMsg + where, ts: Date.now() });
      renderMessages({ scroll: 'bottom' });
    } else {
      const data = attempt.data || {};
      if (usedFallback) {
        chat.messages.push({
          role: 'info',
          content: usedFallback.reason,
          ts: Date.now(),
        });
      }
      const reply = data.reply || streamBuf || '(empty response)';
      chat.messages.push({
        role: 'assistant',
        content: reply,
        ts: assistantTs,
        provider: data.provider,
        model: data.model || state.activeModel,
      });
      const newArts = extractArtifacts(reply);
      if (newArts.length) {
        chat.artifacts.push(...newArts);
        if (state.artifactsCollapsed) {
          state.artifactsCollapsed = false;
          applySidebarState();
        }
      }
      // Land at the beginning of the answer, not the end
      renderMessages({ scroll: 'assistant-start', pinMsgTs: assistantTs });
      renderArtifacts();
      speakReply(reply);
    }
    chat.updatedAt = Date.now();
    saveState();
  } catch (err) {
    const idx = chat.messages.findIndex((m) => m.ts === assistantTs && m.role === 'assistant' && m.streaming);
    if (idx !== -1) chat.messages.splice(idx, 1);
    chat.messages.push({ role: 'error', content: err.message || 'Network error', ts: Date.now() });
    saveState();
    renderMessages({ scroll: 'bottom' });
  } finally {
    if (tickTimer) clearInterval(tickTimer);
    els.sendBtn.disabled = false;
    setTypingActive(false);
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
  if (!state.activeRole) state.activeRole = 'plan';
  if (els.roleSelect) els.roleSelect.value = state.activeRole;
  els.providerSelect.value = state.activeProvider;
  await Promise.all([renderModelSelect(), fetchPersonas()]);
  renderMessages();
  renderArtifacts();
  renderAttachPreview();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

els.inputForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text && pendingUploads.length === 0) return;
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
  state.activeModel = DEFAULT_MODELS[state.activeProvider] || state.activeModel;
  // Persist assignment for the active role
  if (state.activeRole && roleModels[state.activeRole]) {
    roleModels[state.activeRole] = {
      provider: state.activeProvider,
      model: state.activeModel,
    };
    saveRoleModels(roleModels);
  }
  saveState();
  await renderModelSelect();
  saveState();
});
els.modelSelect.addEventListener('change', () => {
  state.activeModel = els.modelSelect.value;
  const chat = activeChat();
  if (chat) { chat.model = state.activeModel; chat.provider = state.activeProvider; }
  if (state.activeRole && roleModels[state.activeRole]) {
    roleModels[state.activeRole] = {
      provider: state.activeProvider,
      model: state.activeModel,
    };
    saveRoleModels(roleModels);
  }
  saveState();
});
els.personaSelect?.addEventListener('change', () => {
  applyPersona(els.personaSelect.value);
});

if (els.roleSelect) {
  els.roleSelect.addEventListener('change', async () => {
    await applyRole(els.roleSelect.value);
  });
}

// ---------------------------------------------------------------------------
// Per-persona neural voices + Persona · Voice sheet
// ---------------------------------------------------------------------------

const SPEAK_PREF_KEY = 'uncensored_speak_replies_v1';
const VOICE_PREF_KEY = 'uncensored_tts_voice_v1'; // legacy single-voice fallback
const PERSONA_VOICES_KEY = 'uncensored_persona_voices_v1';
const DEFAULT_NEURAL_VOICE = 'en-US-AvaNeural';
const DEFAULT_PERSONA_VOICES = {
  nexus: 'en-US-AndrewNeural',
  plain: 'en-US-AvaNeural',
};

function loadPersonaVoices() {
  try {
    const raw = localStorage.getItem(PERSONA_VOICES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_PERSONA_VOICES, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_PERSONA_VOICES };
  }
}

function savePersonaVoices(map) {
  try { localStorage.setItem(PERSONA_VOICES_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

let personaVoices = loadPersonaVoices();

function voiceForPersona(personaId) {
  const id = personaId || state.activePersonaId || 'nexus';
  return personaVoices[id]
    || personaVoices.nexus
    || localStorage.getItem(VOICE_PREF_KEY)
    || DEFAULT_NEURAL_VOICE;
}

function setVoiceForPersona(personaId, voice) {
  const id = personaId || state.activePersonaId;
  if (!id || !voice) return;
  personaVoices = { ...personaVoices, [id]: voice };
  savePersonaVoices(personaVoices);
  try { localStorage.setItem(VOICE_PREF_KEY, voice); } catch { /* ignore */ }
}

function syncVoiceSelectToPersona() {
  const v = voiceForPersona(state.activePersonaId);
  if (els.voiceSelect) els.voiceSelect.value = v;
  if (els.toneVoiceSelect) els.toneVoiceSelect.value = v;
}

async function applyRole(roleId) {
  state.activeRole = roleId || 'plan';
  if (els.roleSelect) els.roleSelect.value = state.activeRole;
  if (els.toneRoleSelect) els.toneRoleSelect.value = state.activeRole;
  const assigned = roleModels[state.activeRole];
  if (assigned) {
    state.activeProvider = assigned.provider;
    state.activeModel = assigned.model;
    if (els.providerSelect) els.providerSelect.value = state.activeProvider;
  }
  saveState();
  await renderModelSelect();
}

function applyPersona(personaId) {
  state.activePersonaId = personaId || personas[0]?.id || 'nexus';
  if (els.personaSelect) els.personaSelect.value = state.activePersonaId;
  if (els.tonePersonaSelect) els.tonePersonaSelect.value = state.activePersonaId;
  const chat = activeChat();
  if (chat) chat.personaId = state.activePersonaId;
  syncVoiceSelectToPersona();
  saveState();
}

function openToneModal() {
  if (!els.toneModal) return;
  if (els.toneRoleSelect) els.toneRoleSelect.value = state.activeRole || 'plan';
  renderPersonaSelect();
  syncVoiceSelectToPersona();
  els.toneModal.classList.remove('hidden');
}

function closeToneModal() {
  els.toneModal?.classList.add('hidden');
}

els.toneBtn?.addEventListener('click', openToneModal);
els.closeToneModal?.addEventListener('click', closeToneModal);
els.saveToneBtn?.addEventListener('click', closeToneModal);
els.toneModal?.addEventListener('click', (e) => {
  if (e.target === els.toneModal) closeToneModal();
});

els.toneRoleSelect?.addEventListener('change', () => {
  void applyRole(els.toneRoleSelect.value);
});
els.tonePersonaSelect?.addEventListener('change', () => {
  applyPersona(els.tonePersonaSelect.value);
});
els.toneVoiceSelect?.addEventListener('change', () => {
  setVoiceForPersona(state.activePersonaId, els.toneVoiceSelect.value);
  syncVoiceSelectToPersona();
});
els.voiceSelect?.addEventListener('change', () => {
  setVoiceForPersona(state.activePersonaId, els.voiceSelect.value);
  syncVoiceSelectToPersona();
});

els.previewVoiceBtn?.addEventListener('click', async () => {
  const voice = els.toneVoiceSelect?.value || voiceForPersona(state.activePersonaId);
  const personaName = personas.find(p => p.id === state.activePersonaId)?.name || 'this persona';
  try {
    const blob = await fetchNeuralAudio(
      `Hi — I'm ${personaName}. This is how I sound.`,
      voice,
    );
    await playBlob(blob);
  } catch (err) {
    alert('Preview failed: ' + (err.message || err));
  }
});

// ---------------------------------------------------------------------------
// Neural spoken replies (Edge TTS via /api/tts) + Workspace handoff
// ---------------------------------------------------------------------------

let speakReplies = false;
try { speakReplies = localStorage.getItem(SPEAK_PREF_KEY) === '1'; } catch { /* ignore */ }

let ttsUnlocked = false;
let activeAudio = null;
let speakQueue = Promise.resolve();

function syncSpeakBtn() {
  if (!els.speakBtn) return;
  els.speakBtn.classList.toggle('speak-on', speakReplies);
  els.speakBtn.setAttribute('aria-pressed', speakReplies ? 'true' : 'false');
  els.speakBtn.title = speakReplies
    ? 'Neural spoken replies on — tap to mute'
    : 'Tap to enable neural spoken replies (per persona)';
}
syncSpeakBtn();

function cleanForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[Uploaded (file|image):[^\]]*\]/gi, ' ')
    .replace(/[#*_`>+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkSpeech(text, max = 1800) {
  const clean = cleanForSpeech(text);
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const parts = [];
  let rest = clean;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts.slice(0, 4);
}

function stopNeuralSpeech() {
  try {
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = '';
      activeAudio = null;
    }
  } catch { /* ignore */ }
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

async function fetchNeuralAudio(text, voice) {
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) {
    let msg = `TTS HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.blob();
}

function playBlob(blob) {
  return new Promise((resolve, reject) => {
    stopNeuralSpeech();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (activeAudio === audio) activeAudio = null;
      reject(new Error('Audio playback failed'));
    };
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        URL.revokeObjectURL(url);
        reject(err);
      });
    }
  });
}

/** Fallback robotic browser voice — only if neural TTS fails. */
function speakBrowserFallback(text) {
  if (!window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(cleanForSpeech(text).slice(0, 1200));
    u.rate = 1.02;
    const voices = window.speechSynthesis.getVoices?.() || [];
    const en = voices.find(v => /en[-_]/i.test(v.lang) && /enhanced|premium|neural|samantha|google/i.test(v.name))
      || voices.find(v => /en[-_]/i.test(v.lang));
    if (en) u.voice = en;
    window.speechSynthesis.speak(u);
  } catch (err) {
    console.warn('browser TTS fallback failed', err);
  }
}

async function speakReply(text, { force = false } = {}) {
  if (!force && !speakReplies) return;
  const chunks = chunkSpeech(text);
  if (!chunks.length) return;

  const voice = voiceForPersona(state.activePersonaId);

  speakQueue = speakQueue.then(async () => {
    try {
      for (const chunk of chunks) {
        const blob = await fetchNeuralAudio(chunk, voice);
        await playBlob(blob);
      }
      ttsUnlocked = true;
    } catch (err) {
      console.warn('Neural TTS failed, falling back:', err);
      speakBrowserFallback(chunks.join(' '));
    }
  }).catch(() => { /* queue continues */ });

  return speakQueue;
}

/** Must run inside a user gesture on iPhone so later Audio.play() is allowed. */
async function unlockTts() {
  ttsUnlocked = true;
  try {
    const blob = await fetchNeuralAudio('Ready.', voiceForPersona(state.activePersonaId));
    const audio = new Audio(URL.createObjectURL(blob));
    audio.volume = 0.001;
    await audio.play().catch(() => {});
    audio.pause();
    return true;
  } catch {
    try {
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch { /* ignore */ }
    return true;
  }
}

els.speakBtn?.addEventListener('click', async () => {
  const turningOn = !speakReplies;
  speakReplies = turningOn;
  try { localStorage.setItem(SPEAK_PREF_KEY, speakReplies ? '1' : '0'); } catch { /* ignore */ }

  if (!speakReplies) {
    stopNeuralSpeech();
    syncSpeakBtn();
    return;
  }

  syncSpeakBtn();
  const personaName = personas.find(p => p.id === state.activePersonaId)?.name || 'your persona';
  try {
    const blob = await fetchNeuralAudio(
      `Spoken replies are on. I'll speak as ${personaName}.`,
      voiceForPersona(state.activePersonaId),
    );
    ttsUnlocked = true;
    await playBlob(blob);
  } catch (err) {
    console.warn(err);
    unlockTts();
    speakBrowserFallback('Spoken replies are on, but the neural voice failed to load. Using the phone voice for now.');
  }
});

els.speakBtn?.addEventListener('dblclick', () => {
  const chat = activeChat();
  const last = [...(chat?.messages || [])].reverse().find(m => m.role === 'assistant');
  if (last) void speakReply(last.content, { force: true });
});

let recognition = null;
let listening = false;

function getSpeechRecognition() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

function stopListening() {
  listening = false;
  els.micBtn?.classList.remove('listening');
  try { recognition?.stop(); } catch { /* ignore */ }
}

els.micBtn?.addEventListener('click', () => {
  if (listening) {
    stopListening();
    return;
  }
  const rec = getSpeechRecognition();
  if (!rec) {
    alert('Voice input needs a browser with Speech Recognition (Chrome or Safari on a real device).');
    return;
  }
  recognition = rec;
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  let finalText = '';
  rec.onstart = () => {
    listening = true;
    els.micBtn?.classList.add('listening');
  };
  rec.onerror = () => stopListening();
  rec.onend = () => {
    listening = false;
    els.micBtn?.classList.remove('listening');
    setTypingActive(false);
    if (finalText.trim()) {
      els.input.value = (els.input.value ? els.input.value + ' ' : '') + finalText.trim();
      els.input.dispatchEvent(new Event('input'));
      els.input.focus();
    }
  };
  rec.onresult = (event) => {
    let interim = '';
    finalText = '';
    for (let i = 0; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim && els.typingStatus) {
      setTypingActive(true, `Listening… ${interim}`);
    }
  };
  try {
    setTypingActive(true, 'Listening…');
    rec.start();
  } catch (err) {
    stopListening();
    setTypingActive(false);
    alert('Could not start mic: ' + (err.message || err));
  }
});

const WORKSPACE_HANDOFF_KEY = 'chat_to_workspace_v1';

function openInWorkspace() {
  const chat = ensureActiveChat();
  const messages = (chat.messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length) {
    // Still allow opening empty workspace
  }
  const payload = {
    v: 1,
    title: chat.name,
    provider: state.activeProvider,
    model: state.activeModel,
    role: state.activeRole === 'plan' ? 'write' : state.activeRole,
    messages,
    createdAt: Date.now(),
  };
  try {
    sessionStorage.setItem(WORKSPACE_HANDOFF_KEY, JSON.stringify(payload));
  } catch (err) {
    alert('Could not hand off chat (storage full?). Try a shorter chat.');
    return;
  }
  window.location.href = '/agent';
}

els.workspaceBtn?.addEventListener('click', openInWorkspace);

function renderAttachPreview() {
  if (!els.attachPreview) return;
  if (!pendingUploads.length) {
    els.attachPreview.classList.add('hidden');
    els.attachPreview.innerHTML = '';
    return;
  }
  els.attachPreview.classList.remove('hidden');
  els.attachPreview.innerHTML = '';
  pendingUploads.forEach((u, i) => {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.textContent = `${u.kind === 'image' ? '🖼' : '📄'} ${u.name} `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      pendingUploads.splice(i, 1);
      renderAttachPreview();
    });
    chip.appendChild(btn);
    els.attachPreview.appendChild(chip);
  });
}

async function readUploadFile(file) {
  const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
  const content = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    if (isImage) r.readAsDataURL(file);
    else r.readAsText(file);
  });
  return { kind: isImage ? 'image' : 'text', name: file.name, content };
}

if (els.attachBtn && els.attachInput) {
  els.attachBtn.addEventListener('click', () => els.attachInput.click());
  els.attachInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (file.size > 8_000_000) {
        alert(`${file.name} is too large (max 8MB)`);
        continue;
      }
      try {
        pendingUploads.push(await readUploadFile(file));
      } catch (err) {
        console.warn(err);
      }
    }
    renderAttachPreview();
    e.target.value = '';
  });
}

function openKeysModal() {
  if (!els.keysModal || !els.keysForm) return;
  els.keysForm.innerHTML = '';
  for (const id of PROVIDER_IDS) {
    const label = document.createElement('label');
    label.textContent = PROVIDER_LABELS[id];
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = `${PROVIDER_LABELS[id]} API key`;
    input.value = providerKeys[id] || '';
    input.dataset.provider = id;
    input.addEventListener('change', () => {
      providerKeys[id] = input.value;
      saveProviderKeys(providerKeys);
      // Bust cache so next model fetch uses the new key
      Object.keys(modelsCache).forEach((k) => {
        if (k.startsWith(`${id}:`)) delete modelsCache[k];
      });
    });
    label.appendChild(input);
    els.keysForm.appendChild(label);
  }
  els.keysModal.classList.remove('hidden');
}
function closeKeysModal() {
  els.keysModal?.classList.add('hidden');
  // Refresh models in case a key was added
  renderModelSelect().catch(() => {});
}

els.keysBtn?.addEventListener('click', openKeysModal);
els.closeKeysModal?.addEventListener('click', closeKeysModal);
els.keysModal?.addEventListener('click', (e) => {
  if (e.target === els.keysModal) closeKeysModal();
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
    if (els.keysModal && !els.keysModal.classList.contains('hidden')) closeKeysModal();
    if (els.toneModal && !els.toneModal.classList.contains('hidden')) closeToneModal();
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
