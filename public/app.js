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

// Fallback only if /api/models is unreachable. Live/public catalogs are preferred.
const PROVIDER_FALLBACKS = {
  venice: [
    { id: 'venice-uncensored-1-2', name: 'Venice Uncensored 1.2' },
    { id: 'e2ee-venice-uncensored-24b-p', name: 'Venice Uncensored 1.1' },
    { id: 'venice-uncensored-role-play', name: 'Venice Role Play Uncensored' },
    { id: 'olafangensan-glm-4.7-flash-heretic', name: 'GLM 4.7 Flash Heretic' },
    { id: 'gemma-4-uncensored', name: 'Gemma 4 Uncensored' },
    { id: 'e2ee-gemma-4-26b-a4b-uncensored-p', name: 'Gemma 4 26B A4B Uncensored' },
    { id: 'e2ee-qwen3-6-35b-a3b-uncensored-p', name: 'Qwen3.6 35B A3B Uncensored' },
    { id: 'venice-uncensored', name: 'Dolphin Mistral 24B Venice Edition' },
  ],
  openrouter: [
    { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition', name: 'Venice Uncensored (Dolphin 24B)' },
    { id: 'nousresearch/hermes-4-405b', name: 'Hermes 4 405B' },
    { id: 'nousresearch/hermes-4-70b', name: 'Hermes 4 70B' },
    { id: 'nousresearch/hermes-3-llama-3.1-405b', name: 'Hermes 3 405B' },
    { id: 'gryphe/mythomax-l2-13b', name: 'MythoMax 13B' },
    { id: 'openrouter/free', name: 'Free Models Router' },
    { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B (free)' },
    { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B A4B (free)' },
    { id: 'openai/gpt-oss-20b:free', name: 'GPT OSS 20B (free)' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano 30B (free)' },
    { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder (free)' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
    { id: 'openai/gpt-4.1', name: 'GPT-4.1' },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek Chat V3.1' },
  ],
  cerebras: [
    { id: 'gpt-oss-120b', name: 'OpenAI GPT OSS 120B' },
    { id: 'zai-glm-4.7', name: 'Z.ai GLM 4.7' },
    { id: 'gemma-4-31b', name: 'Gemma 4 31B' },
    { id: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
    { id: 'qwen-3-32b', name: 'Qwen 3 32B' },
    { id: 'llama3.1-8b', name: 'Llama 3.1 8B' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
    { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant' },
    { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
    { id: 'openai/gpt-oss-20b', name: 'GPT OSS 20B' },
    { id: 'qwen/qwen3.6-27b', name: 'Qwen3.6 27B' },
    { id: 'qwen/qwen3-32b', name: 'Qwen3 32B' },
    { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2 Instruct' },
    { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B' },
    { id: 'groq/compound', name: 'Groq Compound' },
    { id: 'groq/compound-mini', name: 'Groq Compound Mini' },
    { id: 'minimaxai/minimax-m2.7', name: 'MiniMax M2.7' },
  ],
  nvidia: [
    { id: 'meta/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'meta/llama-3.1-70b-instruct', name: 'Llama 3.1 70B Instruct' },
    { id: 'meta/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct' },
    { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nemotron 70B Instruct' },
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', name: 'Nemotron Super 49B v1.5' },
    { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron 3 Nano 30B' },
    { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B' },
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-ai/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'google/gemma-4-31b-it', name: 'Gemma 4 31B' },
    { id: 'mistralai/mistral-large-2-instruct', name: 'Mistral Large 2' },
    { id: 'moonshotai/kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'z-ai/glm-5.2', name: 'GLM 5.2' },
    { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B' },
  ],
};

const DEFAULT_MODELS = {
  venice: 'venice-uncensored-1-2',
  openrouter: 'qwen/qwen3-coder:free',
  cerebras: 'gpt-oss-120b',
  groq: 'llama-3.3-70b-versatile',
  nvidia: 'meta/llama-3.3-70b-instruct',
};

// Group personas always use Venice uncensored — one distinct model each.
// Ordered cheapest → pricier (Venice list pricing); extras wrap on the cheap end.
const VENICE_UNCENSORED_CHEAP_FIRST = [
  'olafangensan-glm-4.7-flash-heretic', // ~$0.07 / $0.40
  'gemma-4-uncensored',                 // ~$0.16 / $0.50
  'e2ee-gemma-4-26b-a4b-uncensored-p',  // ~$0.19 / $0.88
  'venice-uncensored-1-2',              // ~$0.20 / $0.90
  'venice-uncensored',                  // Dolphin Mistral 24B Venice Edition
  'e2ee-venice-uncensored-24b-p',       // ~$0.25 / $1.15
  'e2ee-qwen3-6-35b-a3b-uncensored-p',  // ~$0.38 / $1.88
  'venice-uncensored-role-play',        // ~$0.50 / $2.00
];
const VENICE_UNCENSORED_SET = new Set(VENICE_UNCENSORED_CHEAP_FIRST);

const PROVIDER_IDS = ['venice', 'openrouter', 'cerebras', 'groq', 'nvidia'];
const PROVIDER_LABELS = {
  venice: 'Venice', openrouter: 'OpenRouter', cerebras: 'Cerebras', groq: 'Groq', nvidia: 'NVIDIA',
};

const KEYS_STORAGE = 'uncensored_provider_keys_v1';
const ROLES_STORAGE = 'uncensored_role_models_v1';
const PAID_PASS_STORAGE = 'uncensored_paid_password_v1';

const MODEL_CATEGORIES = [
  { id: 'general', label: 'General' },
  { id: 'coder', label: 'Coders' },
  { id: 'creative', label: 'Creative' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'uncensored', label: 'Uncensored' },
];

/**
 * Persist paid unlock in localStorage (same as BYOK keys) so leaving the page
 * does not force re-entry. Migrates any leftover sessionStorage value once.
 */
function loadPaidPassword() {
  try {
    const fromLocal = localStorage.getItem(PAID_PASS_STORAGE);
    if (fromLocal) return fromLocal;
    const fromSession = sessionStorage.getItem(PAID_PASS_STORAGE);
    if (fromSession) {
      localStorage.setItem(PAID_PASS_STORAGE, fromSession);
      sessionStorage.removeItem(PAID_PASS_STORAGE);
      return fromSession;
    }
    return '';
  } catch {
    return '';
  }
}
function savePaidPassword(pw) {
  try {
    if (pw) {
      localStorage.setItem(PAID_PASS_STORAGE, pw);
      try { sessionStorage.removeItem(PAID_PASS_STORAGE); } catch { /* ignore */ }
    } else {
      localStorage.removeItem(PAID_PASS_STORAGE);
      try { sessionStorage.removeItem(PAID_PASS_STORAGE); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
function paidUnlocked() {
  return !!loadPaidPassword();
}
function paidAuthHeaders(extra = {}) {
  const headers = { ...extra };
  const pw = loadPaidPassword();
  if (pw) headers['X-Paid-Password'] = pw;
  return headers;
}

/** Client-side free/paid + categories (mirrors lib/model-meta.js for fallbacks). */
function inferFreeClient(providerId, model = {}) {
  if (model.free === true) return true;
  if (model.free === false) return false;
  const id = String(model.id || '');
  // Venice burns credits — never treat as free.
  if (providerId === 'venice') return false;
  if (providerId === 'openrouter') {
    if (id === 'openrouter/free' || /:free$/i.test(id)) return true;
    if (/\(free\)/i.test(String(model.name || ''))) return true;
    return false;
  }
  return false;
}
function inferCategoriesClient(providerId, model = {}) {
  if (Array.isArray(model.categories) && model.categories.length) return model.categories;
  const hay = `${model.id || ''} ${model.name || ''} ${model.description || ''}`.toLowerCase();
  const cats = new Set();
  if (/coder|codestral|starcoder|codellama|deepseek-coder|qwen3?-coder|devstral|programming|\bcode\b/.test(hay)) cats.add('coder');
  if (/role.?play|mythomax|creative|story|novel|fiction|hermes|mytho/.test(hay)) cats.add('creative');
  if (/uncensored|dolphin|heretic|abliterated|venice-uncensored/.test(hay)) cats.add('uncensored');
  if (/reason|thinking|\br1\b|qwq|orchestrat/.test(hay)) cats.add('reasoning');
  if (cats.size === 0 || /instruct|chat|general|assistant|versatile|turbo|flash|nano|scout/.test(hay)) cats.add('general');
  return [...cats];
}
function enrichModelClient(providerId, model = {}) {
  const free = inferFreeClient(providerId, model);
  return {
    ...model,
    provider: providerId,
    free,
    paid: !free,
    categories: inferCategoriesClient(providerId, model),
  };
}

const DEFAULT_ROLE_MODELS = {
  write:  { provider: 'openrouter', model: 'qwen/qwen3-coder:free' },
  review: { provider: 'openrouter', model: 'openrouter/free' },
  plan:   { provider: 'openrouter', model: 'openrouter/free' },
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
    // Legacy :free slug retired by OpenRouter — bounce to Venice’s copy.
    'cognitivecomputations/dolphin-mistral-24b-venice-edition:free': {
      provider: 'venice',
      model: 'venice-uncensored',
      reason: 'OpenRouter free Dolphin-Venice retired — used your Venice key on venice-uncensored instead.',
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
    // OpenRouter free router by default — Venice and other paid catalogs
    // need the paid-models unlock password.
    activeProvider: 'openrouter',
    activeModel: 'qwen/qwen3-coder:free',
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
    kind: c.kind || 'chat',
    groupMode: c.groupMode || null,
    topic: c.topic || null,
    groupSummary: c.groupSummary || '',
    groupRounds: typeof c.groupRounds === 'number' ? c.groupRounds : 3,
    personaModels: (c.personaModels && typeof c.personaModels === 'object')
      ? c.personaModels
      : {},
    provider: c.provider || 'venice',
    model: c.model || 'venice-uncensored',
    personaId: c.personaId || 'nexus',
    messages: Array.isArray(c.messages) ? c.messages : [],
    artifacts: Array.isArray(c.artifacts) ? c.artifacts : [],
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now(),
  }));
  // One-time: older builds marked mobile drawer auto-close as an explicit
  // preference, which left desktop with chats stuck collapsed (and, before
  // the grid-column pin, #main at 0 width). Clear that sticky flag once.
  if (!merged.sidebarDesktopHealV1) {
    if (merged.chatsCollapsedExplicit && merged.chatsCollapsed) {
      merged.chatsCollapsedExplicit = false;
      merged.chatsCollapsed = false;
    }
    merged.sidebarDesktopHealV1 = true;
  }
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

function createChat(opts = {}) {
  const chat = {
    id: uid(),
    name: opts.name || 'New chat',
    kind: opts.kind || 'chat',
    groupMode: opts.groupMode || null,
    topic: opts.topic || null,
    groupSummary: opts.groupSummary || '',
    groupRounds: typeof opts.groupRounds === 'number' ? opts.groupRounds : 3,
    personaModels: (opts.personaModels && typeof opts.personaModels === 'object')
      ? opts.personaModels
      : {},
    provider: state.activeProvider,
    model: state.activeModel,
    personaId: state.activePersonaId,
    messages: opts.messages || [],
    artifacts: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  saveState();
  return chat;
}

const GROUP_MODE_LABELS = {
  boardroom: 'Boardroom',
  brainstorm: 'Brainstorm',
  freechat: 'Free chat',
};

function createGroupChat(mode, topic, personaModels = {}, rounds = 3) {
  const label = GROUP_MODE_LABELS[mode] || 'Group';
  const chat = createChat({
    kind: 'group',
    groupMode: mode,
    topic,
    personaModels,
    groupRounds: rounds,
    name: `${label}: ${topic.slice(0, 36)}`,
    messages: [],
  });
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
  modelPickerBtn: $('modelPickerBtn'),
  modelPickerLabel: $('modelPickerLabel'),
  modelPickerModal: $('modelPickerModal'),
  closeModelPicker: $('closeModelPicker'),
  modelSearchInput: $('modelSearchInput'),
  modelFilterBtn: $('modelFilterBtn'),
  modelFilterPanel: $('modelFilterPanel'),
  modelFilterProviders: $('modelFilterProviders'),
  modelFilterCategories: $('modelFilterCategories'),
  modelFilterAccess: $('modelFilterAccess'),
  modelFilterClear: $('modelFilterClear'),
  modelFilterDone: $('modelFilterDone'),
  modelPickerStatus: $('modelPickerStatus'),
  modelPickerList: $('modelPickerList'),
  modelUnlockBtn: $('modelUnlockBtn'),
  unlockPaidBtn: $('unlockPaidBtn'),
  unlockPaidModal: $('unlockPaidModal'),
  closeUnlockPaid: $('closeUnlockPaid'),
  unlockPaidForm: $('unlockPaidForm'),
  unlockPaidInput: $('unlockPaidInput'),
  unlockPaidError: $('unlockPaidError'),
  roleSelect: $('roleSelect'),
  personaSelect: $('personaSelect'),
  voiceSelect: $('voiceSelect'),
  menuBtn: $('menuBtn'),
  appMenu: null, // replaced by the menu sheet (#appSheet)
  personaBlurb: $('personaBlurb'),
  personaBlurbName: $('personaBlurbName'),
  personaBlurbDesc: $('personaBlurbDesc'),
  toneBtn: $('toneBtn'),
  toneModal: $('toneModal'),
  closeToneModal: $('closeToneModal'),
  toneRoleSelect: $('toneRoleSelect'),
  tonePersonaSelect: $('tonePersonaSelect'),
  tonePersonaDesc: $('tonePersonaDesc'),
  toneVoiceSelect: $('toneVoiceSelect'),
  previewVoiceBtn: $('previewVoiceBtn'),
  saveToneBtn: $('saveToneBtn'),
  keysBtn: $('keysBtn'),
  keysModal: $('keysModal'),
  keysForm: $('keysForm'),
  closeKeysModal: $('closeKeysModal'),
  workspaceBtn: $('workspaceBtn'),
  groupBtn: $('groupBtn'),
  groupModal: $('groupModal'),
  closeGroupModal: $('closeGroupModal'),
  cancelGroupBtn: $('cancelGroupBtn'),
  groupTopicInput: $('groupTopicInput'),
  groupPersonaModels: $('groupPersonaModels'),
  startGroupBtn: $('startGroupBtn'),
  roundsMinus: $('roundsMinus'),
  roundsPlus: $('roundsPlus'),
  roundsDisplay: $('roundsDisplay'),
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
  stopBtn: $('stopBtn'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
  clearChatsBtn: $('clearChatsBtn'),
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
      // Auto-close the drawer on mobile only — do NOT mark explicit, or a
      // later desktop session keeps chats collapsed forever via localStorage.
      if (isMobileViewport()) state.chatsCollapsed = true;
      saveState();
      renderAll();
    });

    if (c.kind === 'group') {
      const tag = document.createElement('span');
      tag.className = 'group-tag';
      tag.textContent = GROUP_MODE_LABELS[c.groupMode] || 'Group';
      li.appendChild(tag);
    }

    const save = document.createElement('button');
    save.className = 'chat-action save-chat';
    save.textContent = '⤓';
    save.title = 'Save chat to file (JSON)';
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadChat(c);
    });

    if (c.kind === 'group') {
      const mp3 = document.createElement('button');
      mp3.className = 'chat-action save-mp3';
      mp3.textContent = '♫';
      mp3.title = 'Save group session as MP3';
      mp3.addEventListener('click', (e) => {
        e.stopPropagation();
        void downloadGroupSessionMp3(c, mp3, { useKeywords: true });
      });
      li.appendChild(mp3);
    }

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

/** True when the chat viewport is near the bottom (follow new messages). */
let chatStickToBottom = true;

function updateChatStickToBottom() {
  const el = els.chat;
  if (!el) return;
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  chatStickToBottom = dist < 100;
}

function bindChatScrollGuard() {
  if (!els.chat || els.chat.dataset.scrollGuard === '1') return;
  els.chat.dataset.scrollGuard = '1';
  els.chat.addEventListener('scroll', updateChatStickToBottom, { passive: true });
}

/** Group chats: never yank the reader back to the first turn. */
function groupScrollMode(preferred = 'bottom') {
  if (preferred === 'none') return 'none';
  return chatStickToBottom ? 'bottom' : 'none';
}

/** @param {{ scroll?: 'bottom' | 'assistant-start' | 'none', pinMsgTs?: number }} [opts] */
function renderMessages(opts = {}) {
  const scroll = opts.scroll || 'bottom';
  const prevTop = els.chat?.scrollTop || 0;
  els.chat.innerHTML = '';
  const chat = activeChat();
  if (!chat) return;

  if (chat.kind === 'group') {
    const banner = document.createElement('div');
    banner.className = 'group-banner';
    const modeLabel = GROUP_MODE_LABELS[chat.groupMode] || 'Group';
    const text = document.createElement('div');
    text.className = 'group-banner-text';
    text.innerHTML = `<strong>${modeLabel}</strong> · ${escapeHtml(chat.topic || 'Untitled')} — all personas at the table.`;
    banner.appendChild(text);
    const mp3Btn = document.createElement('button');
    mp3Btn.type = 'button';
    mp3Btn.className = 'text-btn group-mp3-btn';
    mp3Btn.textContent = 'Save MP3';
    mp3Btn.title = 'Download this group session as an MP3';
    mp3Btn.addEventListener('click', () => void downloadGroupSessionMp3(chat, mp3Btn, { useKeywords: true }));
    banner.appendChild(mp3Btn);
    els.chat.appendChild(banner);
  }

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
  if (scroll === 'none') {
    // Keep the reader's place after a full re-render (group streaming).
    els.chat.scrollTop = prevTop;
  } else if (scroll === 'assistant-start' && pinEl && chat.kind !== 'group') {
    // Single-chat only — group must not jump to an early turn.
    requestAnimationFrame(() => {
      pinEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  } else if (scroll === 'bottom' || (scroll === 'assistant-start' && chat.kind === 'group')) {
    if (chat.kind === 'group' && !chatStickToBottom && scroll !== 'bottom') {
      els.chat.scrollTop = prevTop;
    } else {
      els.chat.scrollTop = els.chat.scrollHeight;
    }
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMessageInto(container, m) {
  const cls =
    m.role === 'user' ? 'user' :
    m.role === 'error' ? 'error' :
    m.role === 'info' ? 'info' :
    'bot';

  const div = document.createElement('div');
  div.className = 'msg ' + cls + (m.streaming ? ' streaming' : '') + (m.personaId ? ' group-turn' : '');
  if (m.ts) div.dataset.ts = String(m.ts);

  if (m.autoContinue) div.classList.add('auto-continue');

  const label = document.createElement('span');
  label.className = 'role';
  label.textContent =
    m.role === 'user' ? (m.autoContinue ? 'auto' : 'you') :
    m.role === 'error' ? 'error' :
    m.role === 'info' ? 'notice' :
    m.role === 'assistant'
      ? (m.personaName
        ? m.personaName
        : (m.model ? `model · ${m.model}` : 'model'))
      : m.role;
  div.appendChild(label);

  const content = document.createElement('div');
  content.className = 'content';

  if (m.role === 'assistant') {
    const shown = stripContinueMarkers(m.content || '') || (m.streaming ? '…' : '');
    renderMarkdownInto(content, shown);
    if (m.content && !m.streaming) {
      const speak = document.createElement('button');
      speak.type = 'button';
      speak.className = 'text-btn msg-speak';
      speak.textContent = 'Read aloud';
      speak.title = 'Speak this entire reply (available even when auto-speak is off)';
      speak.addEventListener('click', (e) => {
        e.preventDefault();
        // Unlock audio in the same user gesture (no network), then speak full reply.
        void unlockTts();
        void speakReply(stripContinueMarkers(m.content), { force: true, personaId: m.personaId });
      });
      div.appendChild(speak);

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'text-btn msg-speak';
      copyBtn.textContent = 'Copy';
      copyBtn.title = 'Copy this entire reply';
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const toCopy = stripContinueMarkers(m.content);
        void copyTextToClipboard(toCopy).then((ok) =>
          flashButton(copyBtn, ok ? 'Copied' : 'Copy failed')
        );
      });
      div.appendChild(copyBtn);
    }
  } else if (m.autoContinue) {
    content.textContent = 'continue →';
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

/**
 * Detect artifacts in a bot response.
 * - Prefers explicit File: / title= / heading / bold labels as the title.
 * - Plan/advice replies: only keep blocks that have a real title (no more
 *   untitled snippet-1.js junk when the model is just illustrating).
 * - Write role (or explicit File:): keep substantial fences as before.
 */
function extractArtifacts(text, { role = 'plan' } = {}) {
  const artifacts = [];
  const re = /(?:^|\n)([^\n]*)\n```([a-zA-Z0-9_+\-.]*)(?:[^\n]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const hintLine = (m[1] || '').trim();
    const fenceOpen = m[0].match(/```([a-zA-Z0-9_+\-.]*)([^\n]*)/);
    const lang = (m[2] || '').trim();
    const fenceAttrs = (fenceOpen && fenceOpen[2]) || '';
    const content = m[3];
    const lines = content.split('\n').length;
    if (lines < 3) continue;

    let title = '';
    const attrTitle = fenceAttrs.match(/(?:title|name|file|filename|path)\s*=\s*[`'"]?([^\s`'"]+)[`'"]?/i);
    if (attrTitle) title = attrTitle[1];

    const fileMatch = hintLine.match(
      /(?:^|\b)(?:file|filename|path)\s*[:=]\s*[`'"]?([^\s`'"]+)[`'"]?/i,
    );
    if (!title && fileMatch) title = fileMatch[1];

    // Markdown heading or bold label on the line before the fence
    if (!title) {
      const heading = hintLine.match(/^(?:#{1,6}\s+|\*\*|__)(.+?)(?:\*\*|__)?\s*$/);
      if (heading) title = heading[1].replace(/[#*_`]/g, '').trim();
    }
    // "Here's auth.ts:" / "### login.py"
    if (!title) {
      const named = hintLine.match(
        /[`'"]?([\w./-]+\.[a-zA-Z0-9]{1,12})[`'"]?\s*:?\s*$/,
      );
      if (named) title = named[1];
    }
    if (!title) {
      const firstLine = content.split('\n').find((ln) => ln.trim().length > 0) || '';
      const commentPath = firstLine.match(
        /(?:#|\/\/|--)\s*(?:file|filename|path)?\s*[:=]?\s*([\w\-./]+\.[a-zA-Z0-9]+)/,
      );
      if (commentPath) title = commentPath[1];
    }

    const hasExplicitTitle = !!title;
    // Advice/plan: skip untitled example dumps. Write: keep them, but name better.
    if (!hasExplicitTitle && role !== 'write') continue;

    if (!title) {
      const ext = extensionForLang(lang);
      const idHint = (content.match(
        /(?:function|class|const|def|export\s+(?:default\s+)?(?:async\s+)?function)\s+([A-Za-z_][\w]*)/,
      ) || [])[1];
      title = idHint
        ? `${idHint}.${ext}`
        : `${lang || 'code'}-${artifacts.length + 1}.${ext}`;
    }

    artifacts.push({
      id: uid(),
      title: String(title).slice(0, 120),
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
      void copyTextToClipboard(a.content).then((ok) =>
        flashButton(copyBtn, ok ? 'Copied' : 'Copy failed')
      );
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

async function copyTextToClipboard(text) {
  const s = String(text ?? '');
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {
    // Fall through to legacy copy.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
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

// Pulls the current persona list from /api/public-config (id, name, description).
// System prompts and the master prompt stay server-side. Falls back to
// FALLBACK_PERSONAS on any failure so the UI remains usable offline.
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
  ensurePersonaVoices(personas);
  ensurePersonaModels(personas);
  renderPersonaSelect();
}

function activePersona() {
  return personas.find((p) => p.id === state.activePersonaId) || personas[0] || null;
}

/** Show the Admin "Description (shown to users)" blurb in the sheet + topbar. */
function renderPersonaDescription() {
  const p = activePersona();
  const name = p?.name || 'Persona';
  const desc = (p?.description || '').trim();

  if (els.tonePersonaDesc) {
    if (desc) {
      els.tonePersonaDesc.textContent = desc;
      els.tonePersonaDesc.classList.remove('empty');
    } else {
      els.tonePersonaDesc.textContent = 'No public description yet — set one in Admin → Personas → Description.';
      els.tonePersonaDesc.classList.add('empty');
    }
  }

  if (els.personaBlurb && els.personaBlurbName && els.personaBlurbDesc) {
    els.personaBlurb.hidden = false;
    els.personaBlurbName.textContent = name;
    els.personaBlurbDesc.textContent = desc || 'No description — open Menu → Persona · Voice, or edit in Admin.';
  }
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
  renderPersonaDescription();
  renderPersonaChip();
}


// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

async function loadProviderModels(provider) {
  const key = (providerKeys[provider] || '').trim();
  const cacheKey = `prov-v7:${provider}:${key ? 'byok' : 'env'}`;
  if (modelsCache[cacheKey] && !key) return modelsCache[cacheKey];

  const headers = { Accept: 'application/json' };
  if (key) headers['X-Provider-Key'] = key;

  try {
    const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`, {
      headers,
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load models');
    const models = Array.isArray(data.models) ? data.models.filter((m) => m && m.id) : [];
    const raw = models.length ? models : (PROVIDER_FALLBACKS[provider] || []);
    const list = raw.map((m) => enrichModelClient(provider, m));
    if (!key) modelsCache[cacheKey] = list;
    return list;
  } catch (err) {
    console.warn(`Could not fetch ${provider} model list:`, err);
    return (PROVIDER_FALLBACKS[provider] || []).map((m) => enrichModelClient(provider, m));
  }
}

function sortModelsForProvider(provider, models) {
  return models.slice().sort((a, b) => {
    if (!!a.free !== !!b.free) return a.free ? -1 : 1;
    if (!!a.uncensored !== !!b.uncensored) return a.uncensored ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

/** Full catalog across providers (one complete list). */
let allModelsCatalog = [];
let allModelsLoading = null;

/** Exclusive filters: null = All. Pick one value → show only that. */
const modelPickerFilters = {
  provider: null,   // 'venice' | 'openrouter' | …
  category: null,   // 'coder' | 'general' | …
  access: null,     // 'free' | 'paid'
};

async function loadAllModelsCatalog({ force = false } = {}) {
  if (!force && allModelsCatalog.length) return allModelsCatalog;
  if (!force && allModelsLoading) return allModelsLoading;
  allModelsLoading = (async () => {
    const lists = await Promise.all(
      PROVIDER_IDS.map(async (pid) => {
        const models = await loadProviderModels(pid);
        return models.map((m) => enrichModelClient(pid, m));
      }),
    );
    allModelsCatalog = lists.flat();
    allModelsLoading = null;
    return allModelsCatalog;
  })();
  return allModelsLoading;
}

/**
 * Search: typed text must be a PREFIX of the model name or id leaf.
 * "S" → only names/ids that START with S. Nothing else.
 */
function modelSearchPrefixMatch(model, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const name = String(model.name || '').trim().toLowerCase();
  const id = String(model.id || '').trim().toLowerCase();
  const leaf = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return name.startsWith(q) || leaf.startsWith(q) || id.startsWith(q);
}

function filterCatalogModels(models, { query = '', filters = modelPickerFilters } = {}) {
  const q = String(query || '').trim();
  return models.filter((m) => {
    if (!modelSearchPrefixMatch(m, q)) return false;
    if (filters.provider && m.provider !== filters.provider) return false;
    if (filters.access === 'free' && !m.free) return false;
    if (filters.access === 'paid' && m.free) return false;
    if (filters.category) {
      const cats = Array.isArray(m.categories) ? m.categories : [];
      if (!cats.includes(filters.category)) return false;
    }
    return true;
  });
}

function activeFilterCount() {
  let n = 0;
  if (modelPickerFilters.provider) n += 1;
  if (modelPickerFilters.category) n += 1;
  if (modelPickerFilters.access) n += 1;
  return n;
}

function syncFilterChipUI() {
  els.modelFilterProviders?.querySelectorAll('.filter-chip').forEach((btn) => {
    const id = btn.dataset.provider || null;
    const isAll = btn.dataset.all === '1';
    btn.classList.toggle(
      'active',
      isAll ? !modelPickerFilters.provider : modelPickerFilters.provider === id,
    );
  });
  els.modelFilterCategories?.querySelectorAll('.filter-chip').forEach((btn) => {
    const id = btn.dataset.category || null;
    const isAll = btn.dataset.all === '1';
    btn.classList.toggle(
      'active',
      isAll ? !modelPickerFilters.category : modelPickerFilters.category === id,
    );
  });
  els.modelFilterAccess?.querySelectorAll('.filter-chip').forEach((btn) => {
    const id = btn.dataset.access || null;
    const isAll = btn.dataset.all === '1';
    btn.classList.toggle(
      'active',
      isAll ? !modelPickerFilters.access : modelPickerFilters.access === id,
    );
  });
  if (els.modelFilterBtn) {
    const n = activeFilterCount();
    els.modelFilterBtn.textContent = n ? `Filter (${n})` : 'Filter';
  }
}

function makeFilterChip(label, { active = false, onPick } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'filter-chip' + (active ? ' active' : '');
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onPick();
    syncFilterChipUI();
    renderModelPickerList();
  });
  return btn;
}

function initModelFilterChips() {
  if (els.modelFilterProviders && !els.modelFilterProviders.childElementCount) {
    const allBtn = makeFilterChip('All', {
      active: !modelPickerFilters.provider,
      onPick: () => { modelPickerFilters.provider = null; },
    });
    allBtn.dataset.all = '1';
    els.modelFilterProviders.appendChild(allBtn);
    for (const id of PROVIDER_IDS) {
      const btn = makeFilterChip(PROVIDER_LABELS[id] || id, {
        onPick: () => { modelPickerFilters.provider = id; },
      });
      btn.dataset.provider = id;
      els.modelFilterProviders.appendChild(btn);
    }
  }
  if (els.modelFilterCategories && !els.modelFilterCategories.childElementCount) {
    const allBtn = makeFilterChip('All', {
      active: !modelPickerFilters.category,
      onPick: () => { modelPickerFilters.category = null; },
    });
    allBtn.dataset.all = '1';
    els.modelFilterCategories.appendChild(allBtn);
    for (const cat of MODEL_CATEGORIES) {
      const btn = makeFilterChip(cat.label, {
        onPick: () => { modelPickerFilters.category = cat.id; },
      });
      btn.dataset.category = cat.id;
      els.modelFilterCategories.appendChild(btn);
    }
  }
  if (els.modelFilterAccess && !els.modelFilterAccess.dataset.ready) {
    els.modelFilterAccess.dataset.ready = '1';
    els.modelFilterAccess.innerHTML = '';
    const allBtn = makeFilterChip('All', {
      active: !modelPickerFilters.access,
      onPick: () => { modelPickerFilters.access = null; },
    });
    allBtn.dataset.all = '1';
    els.modelFilterAccess.appendChild(allBtn);
    for (const [id, label] of [['free', 'Free'], ['paid', 'Paid']]) {
      const btn = makeFilterChip(label, {
        onPick: () => { modelPickerFilters.access = id; },
      });
      btn.dataset.access = id;
      els.modelFilterAccess.appendChild(btn);
    }
  }
  syncFilterChipUI();
}

function clearModelFilters() {
  modelPickerFilters.provider = null;
  modelPickerFilters.category = null;
  modelPickerFilters.access = null;
  syncFilterChipUI();
  renderModelPickerList();
}

function syncHiddenModelSelects(catalog) {
  if (!els.modelSelect || !els.providerSelect) return;
  const provider = state.activeProvider;
  const forProvider = sortModelsForProvider(
    provider,
    (catalog || []).filter((m) => m.provider === provider),
  );
  els.providerSelect.value = provider;
  els.modelSelect.innerHTML = '';
  for (const m of forProvider) els.modelSelect.appendChild(makeModelOption(m, { showId: provider === 'openrouter' }));
  const available = forProvider.map((m) => m.id);
  if (
    provider === 'openrouter' &&
    state.activeModel === 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free' &&
    available.includes('cognitivecomputations/dolphin-mistral-24b-venice-edition')
  ) {
    state.activeModel = 'cognitivecomputations/dolphin-mistral-24b-venice-edition';
    saveState();
  }
  if (!available.includes(state.activeModel)) {
    // Prefer a free model when current is missing / locked.
    const freeFirst = forProvider.find((m) => m.free) || forProvider[0];
    const fallbackId = available.includes(DEFAULT_MODELS[provider])
      ? DEFAULT_MODELS[provider]
      : (freeFirst?.id || DEFAULT_MODELS[provider] || state.activeModel);
    state.activeModel = fallbackId;
    saveState();
  }
  // If active is paid and locked, bounce to a free model.
  const activeMeta = forProvider.find((m) => m.id === state.activeModel);
  if (activeMeta && !activeMeta.free && !paidUnlocked()) {
    const free = forProvider.find((m) => m.free);
    if (free) {
      state.activeModel = free.id;
      saveState();
    }
  }
  els.modelSelect.value = state.activeModel;
}

function updateModelPickerLabel() {
  if (!els.modelPickerLabel) return;
  const prov = PROVIDER_LABELS[state.activeProvider] || state.activeProvider;
  const meta = allModelsCatalog.find(
    (m) => m.provider === state.activeProvider && m.id === state.activeModel,
  );
  const name = meta?.name || state.activeModel || 'Select model';
  const lock = meta && !meta.free && !paidUnlocked() ? ' · locked' : '';
  els.modelPickerLabel.textContent = `${prov} · ${name}${lock}`;
  if (els.unlockPaidBtn) {
    els.unlockPaidBtn.textContent = paidUnlocked() ? 'Paid ✓' : 'Unlock';
    els.unlockPaidBtn.title = paidUnlocked()
      ? 'Paid models unlocked on this device — click to lock'
      : 'Unlock paid models with password';
  }
  if (els.modelUnlockBtn) {
    els.modelUnlockBtn.textContent = paidUnlocked() ? 'Paid unlocked' : 'Unlock paid';
  }
}

async function renderModelSelect() {
  const catalog = await loadAllModelsCatalog();
  syncHiddenModelSelects(catalog);
  updateModelPickerLabel();
  if (els.modelPickerModal && !els.modelPickerModal.classList.contains('hidden')) {
    renderModelPickerList();
  }
}

function makeModelOption(m, { showId = true } = {}) {
  const opt = document.createElement('option');
  opt.value = m.id;
  const tags = [];
  if (m.free) tags.push('free');
  else tags.push('paid');
  if (m.traits && m.traits.length) tags.push(...m.traits);
  const tagStr = tags.length ? `  [${tags.join(', ')}]` : '';
  const label = (!showId || !m.name || m.name === m.id)
    ? (m.name || m.id)
    : `${m.name} · ${m.id}`;
  opt.textContent = `${label}${tagStr}`;
  opt.title = m.description || m.id;
  const locked = !m.free && !paidUnlocked();
  if (locked) {
    opt.disabled = true;
    opt.textContent = `${label}${tagStr} 🔒`;
  }
  return opt;
}

function renderModelPickerList() {
  const host = els.modelPickerList;
  if (!host) return;
  host.innerHTML = '';
  const query = els.modelSearchInput?.value || '';
  const filtered = filterCatalogModels(allModelsCatalog, { query });
  // Sort: free first, then name — one complete list with section headers.
  const free = filtered.filter((m) => m.free).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  const paid = filtered.filter((m) => !m.free).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  const unlocked = paidUnlocked();

  if (els.modelPickerStatus) {
    const bits = [`${filtered.length} model${filtered.length === 1 ? '' : 's'}`];
    if (query) bits.push(`starting with “${query.trim()}”`);
    const n = activeFilterCount();
    if (n) bits.push(`${n} filter${n === 1 ? '' : 's'} on`);
    if (!unlocked) bits.push('paid grayed out');
    els.modelPickerStatus.textContent = bits.join(' · ');
  }

  const appendGroup = (title, items) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'model-picker-group';
    h.textContent = title;
    host.appendChild(h);
    for (const m of items) {
      const locked = !m.free && !unlocked;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-picker-item' +
        (locked ? ' locked' : '') +
        (m.provider === state.activeProvider && m.id === state.activeModel ? ' active' : '');
      btn.disabled = locked;
      btn.setAttribute('role', 'option');
      btn.dataset.provider = m.provider;
      btn.dataset.model = m.id;

      const name = document.createElement('div');
      name.className = 'model-picker-item-name';
      name.textContent = m.name || m.id;
      btn.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'model-picker-item-meta';
      const prov = document.createElement('span');
      prov.textContent = PROVIDER_LABELS[m.provider] || m.provider;
      meta.appendChild(prov);
      const tier = document.createElement('span');
      tier.className = 'model-tag ' + (m.free ? 'free' : 'paid');
      tier.textContent = m.free ? 'free' : 'paid';
      meta.appendChild(tier);
      if (locked) {
        const lock = document.createElement('span');
        lock.className = 'model-tag locked-tag';
        lock.textContent = 'locked';
        meta.appendChild(lock);
      }
      for (const c of (m.categories || []).slice(0, 3)) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = c;
        meta.appendChild(tag);
      }
      if (m.provider === 'openrouter' && m.name && m.name !== m.id) {
        const idTag = document.createElement('span');
        idTag.textContent = m.id;
        meta.appendChild(idTag);
      }
      btn.appendChild(meta);

      if (!locked) {
        btn.addEventListener('click', () => selectModelFromPicker(m.provider, m.id));
      } else {
        btn.addEventListener('click', () => openUnlockPaidModal());
      }
      host.appendChild(btn);
    }
  };

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'model-picker-status';
    empty.style.padding = '16px';
    empty.textContent = query
      ? `No models begin with “${query.trim()}”.`
      : 'No models match these filters.';
    host.appendChild(empty);
    return;
  }

  appendGroup(`Free · ${free.length}`, free);
  appendGroup(`Paid · ${paid.length}${unlocked ? '' : ' (unlock required)'}`, paid);
}

function selectModelFromPicker(provider, modelId) {
  state.activeProvider = provider;
  state.activeModel = modelId;
  syncHiddenModelSelects(allModelsCatalog);
  const chat = activeChat();
  if (chat) { chat.model = modelId; chat.provider = provider; }
  if (state.activeRole && roleModels[state.activeRole]) {
    roleModels[state.activeRole] = { provider, model: modelId };
    saveRoleModels(roleModels);
  }
  saveState();
  updateModelPickerLabel();
  closeModelPicker();
}

async function openModelPicker() {
  if (!els.modelPickerModal) return;
  initModelFilterChips();
  els.modelPickerModal.classList.remove('hidden');
  els.modelPickerBtn?.setAttribute('aria-expanded', 'true');
  if (els.modelPickerStatus) els.modelPickerStatus.textContent = 'Loading catalogs…';
  await loadAllModelsCatalog();
  syncHiddenModelSelects(allModelsCatalog);
  updateModelPickerLabel();
  renderModelPickerList();
  setTimeout(() => els.modelSearchInput?.focus(), 40);
}
function closeModelPicker() {
  els.modelPickerModal?.classList.add('hidden');
  els.modelFilterPanel?.classList.add('hidden');
  els.modelPickerBtn?.setAttribute('aria-expanded', 'false');
}

function openUnlockPaidModal() {
  if (!els.unlockPaidModal) return;
  els.unlockPaidError?.classList.add('hidden');
  if (els.unlockPaidInput) els.unlockPaidInput.value = '';
  els.unlockPaidModal.classList.remove('hidden');
  setTimeout(() => els.unlockPaidInput?.focus(), 40);
}
function closeUnlockPaidModal() {
  els.unlockPaidModal?.classList.add('hidden');
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

// Client cap sits under the server's 300s maxDuration so we surface a clean
// error instead of waiting on a dead socket. Free-tier OpenRouter gets a
// shorter leash so a dead free model doesn't burn minutes before fallback.
const CHAT_CLIENT_TIMEOUT_MS = 290_000;
const CHAT_FREE_TIER_TIMEOUT_MS = 45_000;

/** Active chat/group fetch — Stop aborts this. */
let activeChatAbort = null;
let activeChatUserStopped = false;
/** True while a sendMessage / group round is in flight (blocks accidental re-send). */
let chatBusy = false;

function setGeneratingUi(on) {
  chatBusy = !!on;
  if (els.sendBtn) els.sendBtn.classList.toggle('hidden', !!on);
  if (els.stopBtn) els.stopBtn.classList.toggle('hidden', !on);
  if (els.sendBtn) els.sendBtn.disabled = !!on;
  if (els.input) {
    els.input.setAttribute('aria-busy', on ? 'true' : 'false');
    els.input.title = on
      ? 'Generating — press Esc or Enter to Stop, or tap Stop'
      : '';
  }
}

function stopActiveChat(reason = 'Stopped.') {
  activeChatUserStopped = true;
  try { activeChatAbort?.abort(reason); } catch { /* ignore */ }
  // Always kill spoken audio + mic — "Stop" means stop everything.
  try { stopNeuralSpeech(); } catch { /* ignore */ }
  try { stopListening(); } catch { /* ignore */ }
}

function timeoutFor(provider, model) {
  if (provider === 'openrouter' && /:free$/i.test(model || '')) return CHAT_FREE_TIER_TIMEOUT_MS;
  return CHAT_CLIENT_TIMEOUT_MS;
}

async function callChat(provider, model, messages, personaId) {
  const controller = new AbortController();
  activeChatAbort = controller;
  const timer = setTimeout(() => controller.abort(), timeoutFor(provider, model));
  const apiKey = (providerKeys[provider] || '').trim();
  const headers = paidAuthHeaders({ 'Content-Type': 'application/json' });
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
        paidPassword: loadPaidPassword() || undefined,
        stream: false,
      }),
      signal: controller.signal,
    });
    let data = null;
    let errText = null;
    try { data = await res.json(); } catch { errText = 'Non-JSON response'; }
    return { ok: res.ok, status: res.status, data, errText, stopped: activeChatUserStopped };
  } catch (err) {
    if (activeChatUserStopped || err?.name === 'AbortError') {
      return { ok: false, status: 0, data: null, errText: 'Stopped.', stopped: true };
    }
    return { ok: false, status: 0, data: null, errText: friendlyNetworkError(err), stopped: false };
  } finally {
    clearTimeout(timer);
    if (activeChatAbort === controller) activeChatAbort = null;
  }
}

/**
 * Stream a chat completion. onEvent({type, ...}) for status/token/thinking/done/error.
 * Returns { ok, status, data, errText } shaped like callChat for fallbacks.
 */
async function callChatStream(provider, model, messages, personaId, onEvent) {
  const controller = new AbortController();
  activeChatAbort = controller;
  const timer = setTimeout(() => controller.abort(), timeoutFor(provider, model));
  const apiKey = (providerKeys[provider] || '').trim();
  const headers = paidAuthHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
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
        paidPassword: loadPaidPassword() || undefined,
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

    // Backend returned a normal JSON completion (older deploy / stream ignored).
    if (ctype.includes('application/json') && !ctype.includes('text/event-stream')) {
      let data = null;
      try { data = await res.json(); } catch {
        return { ok: false, status: res.status, data: null, errText: 'Non-JSON response' };
      }
      if (typeof onEvent === 'function' && data?.reply) {
        onEvent({ type: 'token', text: data.reply });
        onEvent({ type: 'done', reply: data.reply, provider: data.provider, model: data.model });
      }
      return {
        ok: true,
        status: res.status,
        data: {
          reply: data?.reply || '',
          reasoning: data?.reasoning,
          provider: data?.provider,
          model: data?.model,
        },
        errText: null,
      };
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
        data: {
          error: streamError.error,
          provider: streamError.provider,
          model: streamError.model,
          partialReply: streamError.partialReply,
        },
        errText: streamError.error,
      };
    }
    if (!donePayload) {
      // Platform kill / proxy drop mid-thinking often ends the SSE with no
      // `done` event — treat like a timeout so auto-continue can recover.
      return {
        ok: false,
        status: 504,
        data: { error: 'Stream ended without a reply', timedOut: true },
        errText: 'Stream ended without a reply',
      };
    }
    return {
      ok: true,
      status: 200,
      data: {
        reply: donePayload.reply || '',
        reasoning: donePayload.reasoning,
        provider: donePayload.provider,
        model: donePayload.model,
        incomplete: donePayload.incomplete,
        timedOut: donePayload.timedOut,
      },
      errText: null,
    };
  } catch (err) {
    if (activeChatUserStopped || err?.name === 'AbortError') {
      return { ok: false, status: 0, data: null, errText: 'Stopped.', stopped: true };
    }
    return { ok: false, status: 0, data: null, errText: friendlyNetworkError(err), stopped: false };
  } finally {
    clearTimeout(timer);
    if (activeChatAbort === controller) activeChatAbort = null;
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

/** Markers the model uses so the client can auto-continue when a reply was cut short. */
const CONTINUE_MARKER_RE = /⟦\s*(MORE|DONE)\s*⟧/gi;
const WANTS_MORE_RE = /⟦\s*MORE\s*⟧/i;
const AUTO_CONTINUE_MAX = 8;
const AUTO_CONTINUE_USER_TEXT =
  'Continue from where you left off. Finish as much as you can in this reply. End with ⟦MORE⟧ only if a large amount still remains; otherwise finish and end with ⟦DONE⟧.';
const AUTO_CONTINUE_AFTER_TIMEOUT_TEXT =
  'Continue from where you left off. Finish as much as you can in this reply. End with ⟦MORE⟧ only if a large amount still remains; otherwise finish and end with ⟦DONE⟧.';
const AUTO_CONTINUE_EMPTY_TIMEOUT_TEXT =
  'Previous attempt timed out during thinking before the answer text arrived. Restart and answer as fully as you can in one reply — spend less time thinking if needed. End with ⟦MORE⟧ only if the ask is too large to finish; otherwise end with ⟦DONE⟧.';

function stripContinueMarkers(text) {
  return String(text || '')
    .replace(CONTINUE_MARKER_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function replyWantsMore(text, meta = {}) {
  if (meta.incomplete || meta.timedOut) return true;
  return WANTS_MORE_RE.test(String(text || ''));
}

function isTimeoutLikeError(msg) {
  const s = String(msg || '').toLowerCase();
  return /took too long|timed out|timeout|aborted/.test(s);
}

async function sendMessage(text) {
  // Accidental Enter while a reply is streaming must NOT start another request.
  if (chatBusy) return;

  const chat = ensureActiveChat();
  if (chat.kind === 'group') {
    return sendGroupMessage(text);
  }

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

  setGeneratingUi(true);
  activeChatUserStopped = false;
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

  let autoRound = 0;
  let emptyTimeoutRetries = 0;
  let firstAssistantTs = null;

  try {
    while (true) {
      const apiMessages = chat.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => !m.streaming)
        .map((m, idx, arr) => {
          if (
            imageParts.length
            && autoRound === 0
            && idx === arr.length - 1
            && m.role === 'user'
            && !m.autoContinue
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
      if (firstAssistantTs == null) firstAssistantTs = assistantTs;
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
      renderMessages({
        scroll: autoRound === 0 ? 'assistant-start' : 'bottom',
        pinMsgTs: assistantTs,
      });
      pinnedToStart = true;

      const refreshStreamingBubble = () => {
        const msg = chat.messages.find((m) => m.ts === assistantTs && m.role === 'assistant');
        if (!msg) return;
        msg.content = streamBuf;
        const el = els.chat.querySelector(`.msg.bot[data-ts="${assistantTs}"] .content`);
        if (el) {
          el.innerHTML = '';
          renderMarkdownInto(el, stripContinueMarkers(streamBuf) || '…');
        } else {
          renderMessages({ scroll: 'none' });
        }
      };

      updateStatusClock(autoRound > 0 ? `Continuing (${autoRound + 1})` : 'Waiting for model');
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
            updateStatusClock(autoRound > 0 ? `Writing (${autoRound + 1})` : 'Writing');
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

      const data = attempt.data || {};
      const rawReply = (attempt.ok ? (data.reply || streamBuf) : (streamBuf || data.partialReply || '')).trim();
      const timedOut = Boolean(data.timedOut) || (!attempt.ok && isTimeoutLikeError(data.error || attempt.errText));
      const hadReasoning = Boolean(
        (typeof data.reasoning === 'string' && data.reasoning.trim())
        || (els.typingThoughts?.textContent || '').trim(),
      );

      // Timed out after thinking but before answer text — don't leave an empty
      // "(empty response)" bubble; keep a short note and auto-continue once.
      if (!rawReply && timedOut && (attempt.ok || hadReasoning)) {
        if (emptyTimeoutRetries < 1 && autoRound < AUTO_CONTINUE_MAX) {
          emptyTimeoutRetries += 1;
          autoRound += 1;
          chat.messages.push({
            role: 'info',
            content: hadReasoning
              ? 'Timed out during thinking — retrying with a shorter think…'
              : 'Timed out with no text — retrying…',
            ts: Date.now(),
          });
          chat.messages.push({
            role: 'user',
            content: AUTO_CONTINUE_EMPTY_TIMEOUT_TEXT,
            ts: Date.now(),
            autoContinue: true,
          });
          renderMessages({ scroll: 'bottom' });
          saveState();
          continue;
        }
      }

      if (!attempt.ok && !rawReply) {
        if (attempt.stopped || activeChatUserStopped) {
          chat.messages.push({ role: 'info', content: 'Stopped.', ts: Date.now() });
          renderMessages({ scroll: 'bottom' });
          break;
        }
        // Empty timeout: one automatic restart with a continue nudge.
        if (timedOut && emptyTimeoutRetries < 1 && autoRound < AUTO_CONTINUE_MAX) {
          emptyTimeoutRetries += 1;
          autoRound += 1;
          chat.messages.push({
            role: 'info',
            content: 'Timed out with no text — retrying…',
            ts: Date.now(),
          });
          chat.messages.push({
            role: 'user',
            content: AUTO_CONTINUE_EMPTY_TIMEOUT_TEXT,
            ts: Date.now(),
            autoContinue: true,
          });
          renderMessages({ scroll: 'bottom' });
          saveState();
          continue;
        }
        const where = data.provider ? ` [${data.provider} · ${data.model || state.activeModel}]` : '';
        const rawErr = data.error || attempt.errText || 'Request failed';
        const errMsg = friendlyNetworkError({ message: String(rawErr) });
        chat.messages.push({ role: 'error', content: errMsg + where, ts: Date.now() });
        renderMessages({ scroll: 'bottom' });
        break;
      }

      // Non-timeout failure with partial text: keep the text, surface the error, stop.
      if (!attempt.ok && rawReply && !timedOut && !data.incomplete) {
        chat.messages.push({
          role: 'assistant',
          content: rawReply,
          ts: assistantTs,
          provider: data.provider,
          model: data.model || state.activeModel,
        });
        if (attempt.stopped || activeChatUserStopped) {
          chat.messages.push({ role: 'info', content: 'Stopped.', ts: Date.now() });
        } else {
          const where = data.provider ? ` [${data.provider} · ${data.model || state.activeModel}]` : '';
          const rawErr = data.error || attempt.errText || 'Request failed';
          chat.messages.push({
            role: 'error',
            content: friendlyNetworkError({ message: String(rawErr) }) + where,
            ts: Date.now(),
          });
        }
        renderMessages({ scroll: 'bottom' });
        break;
      }

      if (usedFallback) {
        chat.messages.push({
          role: 'info',
          content: usedFallback.reason,
          ts: Date.now(),
        });
      }

      const wantsMore = replyWantsMore(rawReply, {
        incomplete: data.incomplete,
        timedOut,
      });
      // Keep markers in stored content for API history; UI strips them on render.
      const storedReply = rawReply || '(empty response)';
      const displayReply = stripContinueMarkers(storedReply) || '(empty response)';

      chat.messages.push({
        role: 'assistant',
        content: storedReply,
        ts: assistantTs,
        provider: data.provider,
        model: data.model || state.activeModel,
        chunk: autoRound + 1,
      });

      const newArts = extractArtifacts(displayReply, { role: state.activeRole || 'plan' });
      if (newArts.length) {
        chat.artifacts.push(...newArts);
        if (state.artifactsCollapsed) {
          state.artifactsCollapsed = false;
          applySidebarState();
        }
      }
      renderMessages({
        scroll: autoRound === 0 ? 'assistant-start' : 'bottom',
        pinMsgTs: firstAssistantTs,
      });
      renderArtifacts();
      speakReply(displayReply);

      if (wantsMore && autoRound + 1 < AUTO_CONTINUE_MAX) {
        autoRound += 1;
        chat.messages.push({
          role: 'info',
          content: timedOut && !WANTS_MORE_RE.test(rawReply)
            ? `Reply cut short — continuing (${autoRound + 1})…`
            : `Continuing (${autoRound + 1})…`,
          ts: Date.now(),
        });
        chat.messages.push({
          role: 'user',
          content: timedOut && !WANTS_MORE_RE.test(rawReply)
            ? AUTO_CONTINUE_AFTER_TIMEOUT_TEXT
            : AUTO_CONTINUE_USER_TEXT,
          ts: Date.now(),
          autoContinue: true,
        });
        chat.updatedAt = Date.now();
        saveState();
        renderMessages({ scroll: 'bottom' });
        continue;
      }

      if (wantsMore && autoRound + 1 >= AUTO_CONTINUE_MAX) {
        chat.messages.push({
          role: 'info',
          content: 'Stopped continuing after several parts. Say “continue” if you want more.',
          ts: Date.now(),
        });
        renderMessages({ scroll: 'bottom' });
      }
      break;
    }

    chat.updatedAt = Date.now();
    saveState();
  } catch (err) {
    const idx = chat.messages.findIndex((m) => m.role === 'assistant' && m.streaming);
    if (idx !== -1) {
      const partial = chat.messages[idx];
      if (activeChatUserStopped && String(partial.content || '').trim()) {
        partial.streaming = false;
        chat.messages.push({ role: 'info', content: 'Stopped.', ts: Date.now() });
      } else {
        chat.messages.splice(idx, 1);
        if (activeChatUserStopped) {
          chat.messages.push({ role: 'info', content: 'Stopped.', ts: Date.now() });
        } else {
          chat.messages.push({ role: 'error', content: err.message || 'Network error', ts: Date.now() });
        }
      }
    } else if (activeChatUserStopped) {
      chat.messages.push({ role: 'info', content: 'Stopped.', ts: Date.now() });
    } else {
      chat.messages.push({ role: 'error', content: err.message || 'Network error', ts: Date.now() });
    }
    saveState();
    renderMessages({ scroll: 'bottom' });
  } finally {
    if (tickTimer) clearInterval(tickTimer);
    setGeneratingUi(false);
    activeChatUserStopped = false;
    setTypingActive(false);
    els.input.focus();
  }
}

/**
 * Stream a group round. onEvent for status/speaker/token/turn/summary/done/error.
 */
async function callGroupStream(chat, apiMessages, onEvent) {
  const controller = new AbortController();
  activeChatAbort = controller;
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutFor(state.activeProvider, state.activeModel), 240_000));
  const apiKey = (providerKeys[state.activeProvider] || '').trim();
  const headers = paidAuthHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
  if (apiKey) headers['X-Provider-Key'] = apiKey;
  const personaModelMap = {
    ...personaModels,
    ...((chat.personaModels && typeof chat.personaModels === 'object') ? chat.personaModels : {}),
  };

  try {
    const res = await fetch('/api/group-chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: apiMessages,
        summary: chat.groupSummary || '',
        topic: chat.topic,
        mode: chat.groupMode,
        model: state.activeModel,
        provider: state.activeProvider,
        apiKey: apiKey || undefined,
        paidPassword: loadPaidPassword() || undefined,
        personaModels: personaModelMap,
        providerKeys,
      }),
      signal: controller.signal,
    });

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
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

    if (streamError && !donePayload) {
      return {
        ok: false,
        status: 502,
        data: { error: streamError.error },
        errText: streamError.error,
      };
    }
    return {
      ok: true,
      status: 200,
      data: donePayload || {},
      errText: null,
    };
  } catch (err) {
    if (activeChatUserStopped || err?.name === 'AbortError') {
      return { ok: false, status: 0, data: null, errText: 'Stopped.', stopped: true };
    }
    return { ok: false, status: 0, data: null, errText: friendlyNetworkError(err), stopped: false };
  } finally {
    clearTimeout(timer);
    if (activeChatAbort === controller) activeChatAbort = null;
  }
}

// ---------------------------------------------------------------------------
// Topic keyword extractor — used for MP3 filename
// ---------------------------------------------------------------------------
function topicKeywords(topic) {
  const stop = new Set([
    'a','an','the','and','or','but','is','are','was','were','in','on','at','to','for',
    'of','with','by','from','as','that','this','these','those','i','we','you','they',
    'it','its','my','your','our','their','be','do','have','has','had','will','would',
    'can','could','should','about','what','how','why','when','where','who','which',
  ]);
  return String(topic || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 5)
    .join('-') || 'group';
}

// ---------------------------------------------------------------------------
// "More rounds?" prompt injected into chat after all rounds finish
// ---------------------------------------------------------------------------
function showMoreRoundsPrompt(chat) {
  // Remove any stale prompt from a previous run
  els.chat?.querySelector('.rounds-prompt')?.remove();

  const div = document.createElement('div');
  div.className = 'rounds-prompt';

  const label = document.createElement('span');
  label.className = 'rounds-prompt-label';
  label.textContent = 'Done for now. Talk more (+ rounds) or finish and save the MP3.';
  div.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'rounds-prompt-actions';

  [['+1', 1], ['+3', 3], ['+5', 5]].forEach(([lbl, n]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-btn';
    btn.textContent = lbl;
    btn.title = `Add ${n} more round${n > 1 ? 's' : ''}`;
    btn.addEventListener('click', () => {
      div.remove();
      void runAdditionalRounds(chat, n);
    });
    actions.appendChild(btn);
  });

  const finishBtn = document.createElement('button');
  finishBtn.type = 'button';
  finishBtn.className = 'text-btn primary';
  finishBtn.textContent = 'Finish & Save MP3';
  finishBtn.addEventListener('click', () => {
    div.remove();
    void downloadGroupSessionMp3(chat, finishBtn, { useKeywords: true });
  });
  actions.appendChild(finishBtn);
  div.appendChild(actions);

  if (els.chat) {
    els.chat.appendChild(div);
    // Keep actions clear of the composer so +1/+3/+5 aren't a buried sliver.
    div.style.marginBottom = '12px';
    requestAnimationFrame(() => {
      div.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

// ---------------------------------------------------------------------------
// Execute a single group round (all personas speak once). Returns true on success.
// ---------------------------------------------------------------------------
async function runOneRound(chat, updateStatusClock, startedAt, overallFirstPin) {
  const apiMessages = chat.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role,
      content: m.content,
      personaId: m.personaId,
      personaName: m.personaName,
    }));

  let currentTs        = null;
  let currentPersonaId = null;
  let streamBuf        = '';
  let firstPin         = overallFirstPin[0] || null;
  const spokenThisRound = [];

  const ensureBubble = (personaId, personaName, meta = {}) => {
    if (currentTs && currentPersonaId === personaId) return;
    if (currentTs) {
      const prev = chat.messages.find((m) => m.ts === currentTs && m.role === 'assistant');
      if (prev) {
        prev.streaming = false;
        if (!prev.content) prev.content = streamBuf || '…';
      }
    }
    streamBuf        = '';
    currentPersonaId = personaId;
    currentTs        = Date.now() + Math.random();
    if (!firstPin) {
      firstPin = currentTs;
      overallFirstPin[0] = firstPin;
    }
    const assigned = (chat.personaModels && chat.personaModels[personaId])
      || personaModels[personaId]
      || {};
    chat.messages.push({
      role: 'assistant',
      content: '',
      ts: currentTs,
      streaming: true,
      personaId,
      personaName,
      model:    meta.model    || assigned.model    || state.activeModel,
      provider: meta.provider || assigned.provider || state.activeProvider,
    });
    renderMessages({ scroll: groupScrollMode('bottom') });
  };

  const refreshBubble = () => {
    const msg = chat.messages.find((m) => m.ts === currentTs && m.role === 'assistant');
    if (!msg) return;
    msg.content = streamBuf;
    const el = els.chat.querySelector(`.msg.bot[data-ts="${currentTs}"] .content`);
    if (el) {
      el.innerHTML = '';
      renderMarkdownInto(el, streamBuf || '…');
      if (chatStickToBottom) els.chat.scrollTop = els.chat.scrollHeight;
    } else {
      renderMessages({ scroll: groupScrollMode('bottom') });
    }
  };

  try {
    const attempt = await callGroupStream(chat, apiMessages, (evt) => {
      if (evt.type === 'status') {
        updateStatusClock(evt.message || 'Working…');
      } else if (evt.type === 'summary' && typeof evt.summary === 'string') {
        chat.groupSummary = evt.summary;
      } else if (evt.type === 'speaker') {
        ensureBubble(evt.personaId, evt.personaName, { model: evt.model, provider: evt.provider });
        updateStatusClock(`${evt.personaName || 'Persona'} speaking`);
      } else if (evt.type === 'token') {
        ensureBubble(evt.personaId || currentPersonaId, evt.personaName, {
          model: evt.model,
          provider: evt.provider,
        });
        streamBuf = evt.text || streamBuf;
        refreshBubble();
        updateStatusClock(`${evt.personaName || 'Persona'} speaking`);
      } else if (evt.type === 'turn') {
        ensureBubble(evt.personaId, evt.personaName, { model: evt.model, provider: evt.provider });
        streamBuf = evt.content || streamBuf;
        const msg = chat.messages.find((m) => m.ts === currentTs && m.role === 'assistant');
        if (msg) {
          msg.content   = streamBuf;
          msg.streaming = false;
          msg.personaId = evt.personaId;
          msg.personaName = evt.personaName;
          if (evt.model)    msg.model    = evt.model;
          if (evt.provider) msg.provider = evt.provider;
        }
        refreshBubble();
        spokenThisRound.push({ content: streamBuf, personaId: evt.personaId });
        currentTs        = null;
        currentPersonaId = null;
        streamBuf        = '';
      }
    });

    for (const m of chat.messages) {
      if (m.streaming) m.streaming = false;
    }

    if (!attempt.ok) {
      const rawErr = attempt.data?.error || attempt.errText || 'Group round failed';
      chat.messages.push({
        role: 'error',
        content: friendlyNetworkError({ message: String(rawErr) }),
        ts: Date.now(),
      });
      renderMessages({ scroll: groupScrollMode('bottom') });
      return false;
    }

    if (attempt.data?.summary) chat.groupSummary = attempt.data.summary;
    const expected = attempt.data?.expectedTurns;
    if (typeof expected === 'number' && spokenThisRound.length < expected) {
      chat.messages.push({
        role: 'info',
        content: `${spokenThisRound.length} of ${expected} personas spoke this round (some turns may have failed).`,
        ts: Date.now(),
      });
    }
    renderMessages({ scroll: groupScrollMode('bottom') });
    for (const turn of spokenThisRound) {
      void speakReply(turn.content, { personaId: turn.personaId });
    }
    chat.updatedAt = Date.now();
    saveState();
    return true;
  } catch (err) {
    chat.messages.push({ role: 'error', content: err.message || 'Network error', ts: Date.now() });
    saveState();
    renderMessages({ scroll: groupScrollMode('bottom') });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Run additional rounds (called from the "more rounds?" prompt buttons)
// ---------------------------------------------------------------------------
async function runAdditionalRounds(chat, n) {
  const startedAt   = Date.now();
  const firstPin    = [null];
  setGeneratingUi(true);
  activeChatUserStopped = false;
  const updateStatusClock = (base) => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    setTypingActive(true, `${base} · ${secs}s`);
  };
  setTypingActive(true, `Starting ${n} additional round${n > 1 ? 's' : ''}…`);

  const tickTimer = setInterval(() => {
    const cur  = els.typingStatus?.textContent || 'Waiting…';
    const base = cur.replace(/\s·\s\d+s$/, '');
    updateStatusClock(base);
  }, 1000);

  try {
    for (let i = 1; i <= n; i++) {
      if (n > 1) updateStatusClock(`Additional round ${i}/${n} — gathering personas`);
      const ok = await runOneRound(chat, updateStatusClock, startedAt, firstPin);
      if (!ok) break;
      if (i < n) {
        chat.messages.push({
          role: 'info',
          content: `─── Additional round ${i}/${n} complete ───`,
          ts: Date.now(),
        });
        renderMessages({ scroll: groupScrollMode('bottom') });
      }
    }
    showMoreRoundsPrompt(chat);
  } finally {
    clearInterval(tickTimer);
    setGeneratingUi(false);
    activeChatUserStopped = false;
    setTypingActive(false);
    els.input?.focus();
  }
}

// ---------------------------------------------------------------------------
// Group message send — runs all scheduled rounds, then prompts for more
// ---------------------------------------------------------------------------
async function sendGroupMessage(text) {
  if (chatBusy) return;
  const chat = ensureActiveChat();
  const displayText = (text || '').trim();
  if (!displayText) return;

  // Remove any pending "more rounds?" prompt
  els.chat?.querySelector('.rounds-prompt')?.remove();

  chat.messages.push({ role: 'user', content: displayText, ts: Date.now() });
  chat.provider  = state.activeProvider;
  chat.model     = state.activeModel;
  chat.updatedAt = Date.now();
  saveState();
  renderChatList();
  renderChatTitle();
  chatStickToBottom = true;
  renderMessages({ scroll: 'bottom' });

  const totalRounds = chat.groupRounds || 3;
  setGeneratingUi(true);
  activeChatUserStopped = false;
  const startedAt = Date.now();
  const overallFirstPin = [null];

  const updateStatusClock = (base) => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    setTypingActive(true, `${base} · ${secs}s`);
  };

  setTypingActive(true, 'Gathering the table…');
  const tickTimer = setInterval(() => {
    const cur  = els.typingStatus?.textContent || 'Waiting…';
    const base = cur.replace(/\s·\s\d+s$/, '');
    updateStatusClock(base);
  }, 1000);

  try {
    for (let round = 1; round <= totalRounds; round++) {
      if (totalRounds > 1) {
        updateStatusClock(`Round ${round}/${totalRounds} — gathering personas`);
      }
      const ok = await runOneRound(chat, updateStatusClock, startedAt, overallFirstPin);
      if (!ok) break;
      if (round < totalRounds) {
        chat.messages.push({
          role: 'info',
          content: `─── Round ${round}/${totalRounds} complete ───`,
          ts: Date.now(),
        });
        renderMessages({ scroll: groupScrollMode('bottom') });
      }
    }
    // Offer more rounds after all are done
    showMoreRoundsPrompt(chat);
  } finally {
    clearInterval(tickTimer);
    setGeneratingUi(false);
    activeChatUserStopped = false;
    setTypingActive(false);
    els.input?.focus();
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

/** Wipe chat history only. Personas (server-side), provider keys, voice prefs, and UI settings stay. */
function clearChatsOnly() {
  const n = state.chats.length;
  if (!n) {
    alert('No chats to clear.');
    return;
  }
  if (!confirm(`Delete ${n} chat${n === 1 ? '' : 's'} from this browser?\n\nPersonas, API keys, and settings are kept.`)) {
    return;
  }
  state.chats = [];
  state.activeChatId = null;
  saveState();
  renderAll();
}

/** Nuclear local reset: chats + sidebar/provider prefs in STORAGE_KEY. Personas stay on the server. */
function clearAll() {
  if (!confirm('Reset local chats and settings on this browser?\n\nPersonas stay (they live on the server). API keys & voice prefs in other storage keys are not removed — clear site data for a full wipe.')) {
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
  Object.assign(state, freshState());
  renderAll();
}

// ---------------------------------------------------------------------------
// Renderers wiring
// ---------------------------------------------------------------------------

async function renderAll() {
  ensureActiveChat();
  bindChatScrollGuard();
  applySidebarState();
  renderChatList();
  renderChatTitle();
  renderPersonaSelect();
  if (!state.activeRole) state.activeRole = 'plan';
  if (els.roleSelect) els.roleSelect.value = state.activeRole;
  els.providerSelect.value = state.activeProvider;
  await Promise.all([renderModelSelect(), fetchPersonas()]);
  renderMessages({ scroll: chatStickToBottom ? 'bottom' : 'none' });
  renderArtifacts();
  renderAttachPreview();
  const chat = activeChat();
  if (els.input) {
    els.input.placeholder = chat?.kind === 'group'
      ? 'Address the table…'
      : 'Plan or ask… (code builds in Workspace)';
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

els.inputForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (chatBusy) {
    stopActiveChat('Stopped by user');
    setTypingActive(true, 'Stopping…');
    return;
  }
  const text = els.input.value.trim();
  if (!text && pendingUploads.length === 0) return;
  els.input.value = '';
  els.input.style.height = 'auto';
  sendMessage(text);
});

els.stopBtn?.addEventListener('click', () => {
  stopActiveChat('Stopped by user');
  setTypingActive(true, 'Stopping…');
});

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
});
els.input.addEventListener('keydown', (e) => {
  // Esc always stops generation + speech.
  if (e.key === 'Escape') {
    if (chatBusy || activeAudio) {
      e.preventDefault();
      stopActiveChat('Stopped by user');
      setTypingActive(true, 'Stopping…');
    }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // While generating, Enter = Stop (not another send).
    if (chatBusy) {
      stopActiveChat('Stopped by user');
      setTypingActive(true, 'Stopping…');
      return;
    }
    els.inputForm.requestSubmit();
  }
});

function handleNewChat() {
  createChat();
  if (isMobileViewport()) {
    state.chatsCollapsed = true;
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

els.providerSelect?.addEventListener('change', async () => {
  state.activeProvider = els.providerSelect.value;
  state.activeModel = DEFAULT_MODELS[state.activeProvider] || state.activeModel;
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
els.modelSelect?.addEventListener('change', () => {
  // Prefer picker; keep hidden select as a sync fallback.
  if (!els.modelSelect.value) return;
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
  updateModelPickerLabel();
});

els.modelPickerBtn?.addEventListener('click', () => {
  if (els.modelPickerModal?.classList.contains('hidden')) openModelPicker();
  else closeModelPicker();
});
els.closeModelPicker?.addEventListener('click', closeModelPicker);
els.modelPickerModal?.addEventListener('click', (e) => {
  if (e.target === els.modelPickerModal) closeModelPicker();
});
els.modelSearchInput?.addEventListener('input', () => renderModelPickerList());
els.modelFilterBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  initModelFilterChips();
  els.modelFilterPanel?.classList.toggle('hidden');
});
els.modelFilterDone?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  els.modelFilterPanel?.classList.add('hidden');
});
els.modelFilterClear?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  clearModelFilters();
});
els.modelFilterPanel?.addEventListener('click', (e) => {
  // Keep clicks inside the filter popup from closing anything else.
  e.stopPropagation();
});
els.modelUnlockBtn?.addEventListener('click', openUnlockPaidModal);
els.unlockPaidBtn?.addEventListener('click', () => {
  if (paidUnlocked()) {
    // Toggle lock off
    savePaidPassword('');
    updateModelPickerLabel();
    renderModelSelect();
    if (els.modelPickerModal && !els.modelPickerModal.classList.contains('hidden')) {
      renderModelPickerList();
    }
    return;
  }
  openUnlockPaidModal();
});
els.closeUnlockPaid?.addEventListener('click', closeUnlockPaidModal);
els.unlockPaidModal?.addEventListener('click', (e) => {
  if (e.target === els.unlockPaidModal) closeUnlockPaidModal();
});
els.unlockPaidForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = (els.unlockPaidInput?.value || '').trim();
  if (!password) return;
  if (els.unlockPaidError) {
    els.unlockPaidError.classList.add('hidden');
    els.unlockPaidError.textContent = '';
  }
  try {
    const res = await fetch('/api/unlock-paid', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Paid-Password': password,
      },
      body: JSON.stringify({ password, paidPassword: password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (els.unlockPaidError) {
        els.unlockPaidError.textContent = data.error || 'Wrong password.';
        els.unlockPaidError.classList.remove('hidden');
      }
      return;
    }
    savePaidPassword(password);
    closeUnlockPaidModal();
    updateModelPickerLabel();
    await renderModelSelect();
    if (els.modelPickerModal && !els.modelPickerModal.classList.contains('hidden')) {
      renderModelPickerList();
    }
  } catch (err) {
    if (els.unlockPaidError) {
      els.unlockPaidError.textContent = err.message || 'Network error';
      els.unlockPaidError.classList.remove('hidden');
    }
  }
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
const PERSONA_VOICES_KEY = 'uncensored_persona_voices_v2';
const PERSONA_MODELS_KEY = 'uncensored_persona_models_v1';
const DEFAULT_NEURAL_VOICE = 'en-US-AvaNeural';

const FEMALE_VOICES = [
  'en-US-AvaNeural',
  'en-US-EmmaMultilingualNeural',
  'en-US-JennyNeural',
  'en-GB-SoniaNeural',
  'en-AU-NatashaNeural',
];
const MALE_VOICES = [
  'en-US-AndrewNeural',
  'en-US-BrianMultilingualNeural',
  'en-US-GuyNeural',
  'en-GB-RyanNeural',
  'en-AU-WilliamNeural',
];
const FEMALE_VOICE_SET = new Set(FEMALE_VOICES);
const MALE_VOICE_SET = new Set(MALE_VOICES);

const FEMALE_NAME_RE = /\b(ava|emma|jenny|sonia|natasha|sarah|sara|emily|olivia|sophia|sofia|isabella|mia|charlotte|amelia|harper|evelyn|abigail|elizabeth|ella|scarlett|grace|chloe|victoria|aria|lily|nora|zoe|zoey|penelope|aurora|willow|lucy|anna|anne|mary|jane|kate|katie|laura|lisa|michelle|nicole|rachel|rebecca|samantha|stephanie|susan|tina|wendy|yvonne|amy|bella|carmen|diana|elena|fiona|gina|hanna|helen|iris|julia|kara|lena|luna|maya|nina|rosa|ruby|stella|vera|woman|girl|lady|queen|she|her|hers|femme)\b/i;
const MALE_NAME_RE = /\b(andrew|brian|guy|ryan|william|will|james|john|michael|david|chris|christopher|daniel|matthew|matt|joseph|joe|thomas|tom|charles|mark|paul|steven|kevin|jason|eric|keith|roger|nexus|robert|bob|richard|alex|samson|marcus|victor|hugo|leo|max|noah|owen|peter|quentin|sean|tyler|vincent|wade|xavier|zane|man|boy|king|lord|dude|he|him|his)\b/i;

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

function guessPersonaGender(persona) {
  const blob = `${persona?.name || ''} ${persona?.description || ''}`;
  const f = FEMALE_NAME_RE.test(blob);
  const m = MALE_NAME_RE.test(blob);
  if (f && !m) return 'f';
  if (m && !f) return 'm';
  const first = String(persona?.name || '').trim().split(/\s+/)[0] || '';
  if (/a$|elle$|ette$|ine$|ynn$/i.test(first) && !/ny$|by$|ty$|nexus$/i.test(first)) return 'f';
  return 'm';
}

function pickVoiceForGender(gender, used) {
  const pool = gender === 'f' ? FEMALE_VOICES : MALE_VOICES;
  return pool.find((v) => !used.has(v)) || pool[used.size % pool.length] || pool[0];
}

/** Assign distinct gender-matched voices to every persona that lacks one. */
function ensurePersonaVoices(list) {
  const personasList = Array.isArray(list) ? list : personas;
  if (!personasList.length) return;
  const used = new Set();
  let changed = false;
  // Keep existing correct-gender assignments first.
  for (const p of personasList) {
    const current = personaVoices[p.id];
    const gender = guessPersonaGender(p);
    const ok = current && (
      (gender === 'f' && FEMALE_VOICE_SET.has(current)) ||
      (gender === 'm' && MALE_VOICE_SET.has(current))
    );
    if (ok) used.add(current);
  }
  for (const p of personasList) {
    const gender = guessPersonaGender(p);
    const current = personaVoices[p.id];
    const ok = current && (
      (gender === 'f' && FEMALE_VOICE_SET.has(current)) ||
      (gender === 'm' && MALE_VOICE_SET.has(current))
    );
    if (ok) continue;
    const pick = pickVoiceForGender(gender, used);
    personaVoices[p.id] = pick;
    used.add(pick);
    changed = true;
  }
  if (changed) savePersonaVoices(personaVoices);
}

function loadPersonaModels() {
  try {
    const raw = localStorage.getItem(PERSONA_MODELS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePersonaModels(map) {
  try { localStorage.setItem(PERSONA_MODELS_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

let personaVoices = loadPersonaVoices();
let personaModels = loadPersonaModels();

function isVeniceUncensoredAssignment(assigned) {
  return (
    assigned &&
    assigned.provider === 'venice' &&
    typeof assigned.model === 'string' &&
    VENICE_UNCENSORED_SET.has(assigned.model)
  );
}

function pickVeniceUncensoredModel(used) {
  const free = VENICE_UNCENSORED_CHEAP_FIRST.find((id) => !used.has(id));
  if (free) return free;
  // More personas than curated models — reuse cheapest first.
  const i = used.size % VENICE_UNCENSORED_CHEAP_FIRST.length;
  return VENICE_UNCENSORED_CHEAP_FIRST[i];
}

/**
 * Every group persona gets a distinct Venice uncensored model (cheaper ones
 * first). Rewrites non-Venice / non-uncensored leftovers from when the global
 * default drifted to OpenRouter free coders.
 */
function ensurePersonaModels(list) {
  const personasList = Array.isArray(list) ? list : personas;
  if (!personasList.length) return;

  const next = { ...personaModels };
  const used = new Set();
  let changed = false;

  // Pass 1: keep existing Venice-uncensored picks that are still unique.
  for (const p of personasList) {
    const current = next[p.id];
    if (isVeniceUncensoredAssignment(current) && !used.has(current.model)) {
      used.add(current.model);
    } else if (current) {
      delete next[p.id];
      changed = true;
    }
  }

  // Pass 2: fill gaps with the next cheapest unused Venice uncensored model.
  for (const p of personasList) {
    if (isVeniceUncensoredAssignment(next[p.id])) continue;
    const pick = pickVeniceUncensoredModel(used);
    next[p.id] = { provider: 'venice', model: pick };
    used.add(pick);
    changed = true;
  }

  if (changed) {
    personaModels = next;
    savePersonaModels(personaModels);
  }
}

function voiceForPersona(personaId) {
  const id = personaId || state.activePersonaId || 'nexus';
  if (personaVoices[id]) return personaVoices[id];
  const persona = personas.find((p) => p.id === id) || { id, name: id };
  const gender = guessPersonaGender(persona);
  const used = new Set(Object.values(personaVoices));
  const pick = pickVoiceForGender(gender, used);
  setVoiceForPersona(id, pick);
  return pick;
}

function setVoiceForPersona(personaId, voice) {
  const id = personaId || state.activePersonaId;
  if (!id || !voice) return;
  personaVoices = { ...personaVoices, [id]: voice };
  savePersonaVoices(personaVoices);
  try { localStorage.setItem(VOICE_PREF_KEY, voice); } catch { /* ignore */ }
}

function modelForPersona(personaId) {
  const id = personaId || state.activePersonaId || 'nexus';
  const assigned = personaModels[id];
  if (isVeniceUncensoredAssignment(assigned)) return assigned;
  // Never fall back to the global OpenRouter free coder — group table stays Venice.
  const used = new Set(
    Object.values(personaModels)
      .filter((a) => isVeniceUncensoredAssignment(a))
      .map((a) => a.model),
  );
  const model = pickVeniceUncensoredModel(used);
  const next = { provider: 'venice', model };
  personaModels = { ...personaModels, [id]: next };
  savePersonaModels(personaModels);
  return next;
}

function setModelForPersona(personaId, provider, model) {
  const id = personaId || state.activePersonaId;
  if (!id || !provider || !model) return;
  personaModels = { ...personaModels, [id]: { provider, model } };
  savePersonaModels(personaModels);
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
  renderPersonaDescription();
  renderPersonaChip();
  saveState();
}

// ---------------------------------------------------------------------------
// Menu sheet + persona cards
//
// The topbar dropdown became a bottom sheet: on a phone the top-right corner
// is the hardest place to reach, and personas were buried a modal deep inside
// it. Persona identity now lives in the topbar permanently, and switching is
// one tap on a card instead of a <select>.
// ---------------------------------------------------------------------------

const sheetEls = {
  sheet: document.getElementById('appSheet'),
  scrim: document.getElementById('sheetScrim'),
  grid: document.getElementById('personaGrid'),
  chip: document.getElementById('personaChip'),
  chipAvatar: document.getElementById('chipAvatar'),
  chipName: document.getElementById('chipName'),
  chipMeta: document.getElementById('chipMeta'),
  modelSub: document.getElementById('sheetModelSub'),
};

/** Stable hue per persona id, so a persona keeps its colour across reloads. */
function personaHue(id) {
  let h = 0;
  const str = String(id || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function personaInitials(name) {
  return (
    String(name || '')
      .replace(/[^A-Za-z ]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?'
  );
}

function closeAppMenu() {
  sheetEls.sheet?.classList.remove('open');
  sheetEls.scrim?.classList.remove('open');
  els.menuBtn?.setAttribute('aria-expanded', 'false');
  sheetEls.chip?.setAttribute('aria-expanded', 'false');
}

function openAppMenu() {
  renderPersonaCards();
  if (sheetEls.modelSub) {
    sheetEls.modelSub.textContent =
      `${state.activeProvider || ''} · ${state.activeModel || ''}`.trim();
  }
  sheetEls.sheet?.classList.add('open');
  sheetEls.scrim?.classList.add('open');
  els.menuBtn?.setAttribute('aria-expanded', 'true');
}

function toggleAppMenu() {
  if (sheetEls.sheet?.classList.contains('open')) closeAppMenu();
  else openAppMenu();
}

/** Paints the topbar chip and retunes the app's identity hue. */
function renderPersonaChip() {
  const p = activePersona();
  if (!p) return;
  document.documentElement.style.setProperty('--id-h', String(personaHue(p.id)));
  if (sheetEls.chipAvatar) sheetEls.chipAvatar.textContent = personaInitials(p.name);
  if (sheetEls.chipName) sheetEls.chipName.textContent = p.name || 'Persona';
  if (sheetEls.chipMeta) {
    sheetEls.chipMeta.textContent =
      `${state.activeModel || ''} · ${state.activeRole || ''}`.trim();
  }
}

function renderPersonaCards() {
  const grid = sheetEls.grid;
  if (!grid) return;
  grid.innerHTML = '';
  for (const p of personas) {
    const hue = personaHue(p.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'persona-card' + (p.id === state.activePersonaId ? ' active' : '');
    card.style.setProperty('--pc-h', String(hue));
    card.style.setProperty('--pc', `hsl(${hue} 78% 68%)`);
    card.style.setProperty('--pc-soft', `hsl(${hue} 78% 68% / .12)`);
    card.style.setProperty('--pc-line', `hsl(${hue} 78% 68% / .45)`);

    const av = document.createElement('span');
    av.className = 'persona-avatar';
    av.textContent = personaInitials(p.name);

    const nm = document.createElement('span');
    nm.className = 'pc-name';
    nm.textContent = p.name;
    if (p.id === state.activePersonaId) {
      const dot = document.createElement('span');
      dot.className = 'pc-dot';
      dot.textContent = '●';
      nm.appendChild(dot);
    }

    const ds = document.createElement('span');
    ds.className = 'pc-desc';
    ds.textContent = p.description || 'No description yet.';

    card.append(av, nm, ds);
    card.addEventListener('click', () => {
      applyPersona(p.id);
      renderPersonaChip();
      renderPersonaCards();
      setTimeout(closeAppMenu, 160);
    });
    grid.appendChild(card);
  }
}

els.menuBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAppMenu();
});
sheetEls.chip?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleAppMenu();
});
sheetEls.scrim?.addEventListener('click', closeAppMenu);
sheetEls.sheet?.addEventListener('click', (e) => {
  if (e.target.closest('.module-card') || e.target.closest('.sheet-foot')) closeAppMenu();
});

// Sheet duplicates of controls that also live in the topbar.
document.getElementById('modelPickerBtn2')?.addEventListener('click', () => {
  closeAppMenu();
  els.modelPickerBtn?.click();
});
document.getElementById('keysBtn2')?.addEventListener('click', () => {
  closeAppMenu();
  els.keysBtn?.click();
});
document.getElementById('unlockPaidBtn2')?.addEventListener('click', () => {
  closeAppMenu();
  els.unlockPaidBtn?.click();
});

function openToneModal() {
  if (!els.toneModal) return;
  closeAppMenu();
  if (els.toneRoleSelect) els.toneRoleSelect.value = state.activeRole || 'plan';
  renderPersonaSelect();
  syncVoiceSelectToPersona();
  renderPersonaDescription();
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
  renderPersonaDescription();
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
let speakGeneration = 0;

/** Tiny silent MP3 (no network) — unlocks HTMLAudioElement playback in a user gesture. */
const SILENT_MP3_DATA_URI =
  'data:audio/mpeg;base64,SUQzBAAAAAABEFRYWFgAAAAtAAADY29tbWVudABCaWdTb3VuZEJhbmsuY29tIC8gTGFTb25vdGhlcXVlLm9yZwBURU5DAAAAHQAAA1N3aXRjaCBQbHVzIMKpIE5DSCBTb2Z0d2FyZQBUSVQyAAAABgAAAzIyMzUAVFNTRQAAAA8AAANMYXZmNTguMTMuMTAwAAAAAAAAAAAAAAD/80DEAAAAA0gAAAAATEFN//8AAAAA//tQxAAACwAAAAAAAAAABAAAAAAAAAD/80DEAAAAA0gAAAAATEFN//8AAAAA//tQxAAACwAAAAAAAAAABAAAAAAAAAA=';

function syncSpeakBtn() {
  if (!els.speakBtn) return;
  els.speakBtn.classList.toggle('speak-on', speakReplies);
  els.speakBtn.setAttribute('aria-pressed', speakReplies ? 'true' : 'false');
  els.speakBtn.title = speakReplies
    ? 'Auto-speak on — full replies play automatically. Tap to turn off (Read aloud still works).'
    : 'Tap to auto-speak full replies. Read aloud still works when this is off.';
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

/** Split long text into speakable chunks. No hard cap — entire reply is spoken. */
function chunkSpeech(text, max = 1800) {
  const clean = cleanForSpeech(text);
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const parts = [];
  let rest = clean;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf('? ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf('! ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.3) cut = max;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function stopNeuralSpeech() {
  speakGeneration += 1;
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

function playBlob(blob, { interrupt = true } = {}) {
  return new Promise((resolve, reject) => {
    if (interrupt) {
      try {
        if (activeAudio) {
          activeAudio.pause();
          activeAudio.src = '';
          activeAudio = null;
        }
      } catch { /* ignore */ }
      try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    }
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

/** Fallback robotic browser voice — only if neural TTS fails. Speaks full text in chunks. */
function speakBrowserFallback(text) {
  if (!window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const chunks = chunkSpeech(text, 1100);
    const voices = window.speechSynthesis.getVoices?.() || [];
    const en = voices.find(v => /en[-_]/i.test(v.lang) && /enhanced|premium|neural|samantha|google/i.test(v.name))
      || voices.find(v => /en[-_]/i.test(v.lang));
    for (const chunk of chunks) {
      const u = new SpeechSynthesisUtterance(chunk);
      u.rate = 1.02;
      if (en) u.voice = en;
      window.speechSynthesis.speak(u);
    }
  } catch (err) {
    console.warn('browser TTS fallback failed', err);
  }
}

/** Latest assistant turn(s) to auto-speak when enabling 🔊. */
function lastSpeakableTurns() {
  const chat = activeChat();
  if (!chat) return [];
  const msgs = chat.messages || [];
  if (chat.kind === 'group') {
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUser = i; break; }
    }
    const slice = lastUser >= 0 ? msgs.slice(lastUser + 1) : msgs;
    return slice.filter((m) => m.role === 'assistant' && cleanForSpeech(m.content));
  }
  const last = [...msgs].reverse().find((m) => m.role === 'assistant' && cleanForSpeech(m.content));
  return last ? [last] : [];
}

async function speakReply(text, { force = false, personaId = null } = {}) {
  if (!force && !speakReplies) return;
  const chunks = chunkSpeech(text);
  if (!chunks.length) return;

  const voice = voiceForPersona(personaId || state.activePersonaId);

  if (force) {
    // Cut any in-progress audio and start this reply immediately.
    try {
      if (activeAudio) {
        activeAudio.pause();
        activeAudio.src = '';
        activeAudio = null;
      }
    } catch { /* ignore */ }
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    speakGeneration += 1;
    speakQueue = Promise.resolve();
  }

  const gen = speakGeneration;
  speakQueue = speakQueue.then(async () => {
    if (gen !== speakGeneration) return;
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (gen !== speakGeneration) return;
        const blob = await fetchNeuralAudio(chunks[i], voice);
        if (gen !== speakGeneration) return;
        await playBlob(blob, { interrupt: i === 0 });
      }
      ttsUnlocked = true;
    } catch (err) {
      console.warn('Neural TTS failed, falling back:', err);
      if (gen === speakGeneration) speakBrowserFallback(chunks.join(' '));
    }
  }).catch(() => { /* queue continues */ });

  return speakQueue;
}

/** Must run inside a user gesture on iPhone so later Audio.play() is allowed. */
async function unlockTts() {
  ttsUnlocked = true;
  try {
    const audio = new Audio(SILENT_MP3_DATA_URI);
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

/**
 * Build an MP3 of a group session: each persona turn in their voice,
 * with a short name cue between speakers. MPEG streams are concatenated.
 */
async function downloadGroupSessionMp3(chat, btn, opts = {}) {
  const turns = (chat.messages || []).filter(
    (m) => m.role === 'assistant' && cleanForSpeech(m.content),
  );
  if (!turns.length) {
    alert('No spoken replies in this group session yet.');
    return;
  }

  const originalText = btn?.textContent;
  const updateBtn = (t) => { if (btn) btn.textContent = t; };
  if (btn) btn.disabled = true;
  updateBtn('Building MP3…');

  /** Fetch audio with up to `retries` retries on failure. Returns Blob or null. */
  async function fetchWithRetry(text, voice, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchNeuralAudio(text, voice);
      } catch (err) {
        if (attempt < retries) {
          // Brief back-off before retry
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        } else {
          console.warn(`TTS chunk failed after ${retries + 1} attempts:`, err.message);
          return null; // Skip this chunk rather than aborting the whole MP3
        }
      }
    }
    return null;
  }

  try {
    const parts = [];
    let skipped = 0;
    let totalChunks = 0;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const name = turn.personaName || turn.personaId || 'Speaker';
      const voice = voiceForPersona(turn.personaId);
      updateBtn(`MP3 ${i + 1}/${turns.length} — ${name}`);

      // Name cue (best-effort; skip silently if it fails)
      const cueBlob = await fetchWithRetry(`${name}.`, voice, 1);
      if (cueBlob) parts.push(cueBlob);

      // Content chunks — each is retried and skipped on persistent failure
      const chunks = chunkSpeech(turn.content);
      totalChunks += chunks.length;
      for (const chunk of chunks) {
        const blob = await fetchWithRetry(chunk, voice, 2);
        if (blob) {
          parts.push(blob);
        } else {
          skipped++;
        }
      }
    }

    if (!parts.length) {
      throw new Error(
        'No audio could be synthesized — the TTS service may be temporarily unavailable. ' +
        'Try again in a moment, or check that your Vercel deployment has a healthy /api/tts route.',
      );
    }

    const combined = new Blob(parts, { type: 'audio/mpeg' });
    const url = URL.createObjectURL(combined);
    const link = document.createElement('a');
    const base = opts.useKeywords
      ? topicKeywords(chat.topic || chat.name || 'group')
      : (chat.name || 'group').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'group';
    link.href = url;
    link.download = `${base}-${new Date(chat.updatedAt || Date.now()).toISOString().slice(0, 10)}.mp3`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    if (skipped > 0) {
      console.warn(`MP3 complete — ${skipped}/${totalChunks} chunk(s) skipped due to TTS errors.`);
    }
  } catch (err) {
    alert('Could not save MP3:\n\n' + (err.message || String(err)));
  } finally {
    if (btn) btn.disabled = false;
    updateBtn(originalText || 'Save MP3');
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
  // Unlock in this tap, then immediately speak the latest full reply/round.
  await unlockTts();
  const turns = lastSpeakableTurns();
  if (turns.length) {
    for (const t of turns) {
      void speakReply(t.content, { force: t === turns[0], personaId: t.personaId });
    }
    return;
  }
  try {
    const personaName = personas.find(p => p.id === state.activePersonaId)?.name || 'your persona';
    const blob = await fetchNeuralAudio(
      `Spoken replies are on. I'll speak full replies as ${personaName}.`,
      voiceForPersona(state.activePersonaId),
    );
    ttsUnlocked = true;
    await playBlob(blob);
  } catch (err) {
    console.warn(err);
    speakBrowserFallback('Spoken replies are on. Read aloud is always available.');
  }
});

els.speakBtn?.addEventListener('dblclick', () => {
  const turns = lastSpeakableTurns();
  if (!turns.length) return;
  void unlockTts();
  for (const t of turns) {
    void speakReply(t.content, { force: t === turns[0], personaId: t.personaId });
  }
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
  if (chatBusy) {
    // Mic during a reply = stop first, then listen.
    stopActiveChat('Stopped by user');
  }
  // Cut any playing TTS before listening (real voice-chat turn-taking).
  try { stopNeuralSpeech(); } catch { /* ignore */ }

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
    const said = finalText.trim();
    if (!said) return;
    // Voice chat mode: 🔊 on → send immediately and speak the reply.
    // Dictation mode: 🔊 off → just put text in the box.
    if (speakReplies && !chatBusy) {
      els.input.value = '';
      els.input.style.height = 'auto';
      void sendMessage(said);
    } else {
      els.input.value = (els.input.value ? els.input.value + ' ' : '') + said;
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
    setTypingActive(true, speakReplies ? 'Voice chat — listening…' : 'Listening…');
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
  const payload = {
    v: 1,
    chatId: chat.id,
    title: chat.name || 'Untitled',
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

/** Fill a model <select> with ONLY models for one provider. Never mixes catalogs. */
async function fillModelSelect(selectEl, provider, selectedModel) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  selectEl.dataset.provider = provider || '';

  if (!provider) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Select a provider first';
    selectEl.appendChild(empty);
    selectEl.disabled = true;
    return;
  }

  selectEl.disabled = true;
  const loading = document.createElement('option');
  loading.value = '';
  loading.textContent = 'Loading models…';
  selectEl.appendChild(loading);

  const models = await loadProviderModels(provider);
  // Guard against a slower request finishing after the user switched providers
  if (selectEl.dataset.provider !== provider) return;

  selectEl.innerHTML = '';
  const sorted = sortModelsForProvider(provider, models);
  if (!sorted.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'No models for this provider';
    selectEl.appendChild(empty);
    selectEl.disabled = true;
    return;
  }

  const showId = provider === 'openrouter';
  for (const m of sorted) selectEl.appendChild(makeModelOption(m, { showId }));
  selectEl.disabled = false;
  const values = Array.from(selectEl.options).map((o) => o.value);
  const pick = values.includes(selectedModel)
    ? selectedModel
    : (DEFAULT_MODELS[provider] || values[0] || '');
  if (pick) selectEl.value = pick;
}

async function renderGroupPersonaModels() {
  const host = els.groupPersonaModels;
  if (!host) return;
  host.innerHTML = '';
  if (!personas.length) {
    host.textContent = 'No personas loaded yet.';
    return;
  }

  ensurePersonaModels(personas);

  const list = document.createElement('div');
  list.className = 'group-persona-scroll';
  host.appendChild(list);

  for (const p of personas) {
    const row = document.createElement('div');
    row.className = 'group-persona-row';
    row.dataset.personaId = p.id;

    const name = document.createElement('div');
    name.className = 'group-persona-name';
    name.textContent = p.name;
    row.appendChild(name);

    const assigned = modelForPersona(p.id);

    const provLabel = document.createElement('label');
    provLabel.className = 'group-persona-field';
    provLabel.textContent = 'Provider';
    const provSelect = document.createElement('select');
    provSelect.className = 'group-persona-provider';
    const provPlaceholder = document.createElement('option');
    provPlaceholder.value = '';
    provPlaceholder.textContent = 'Select provider…';
    provSelect.appendChild(provPlaceholder);
    for (const id of PROVIDER_IDS) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = PROVIDER_LABELS[id] || id;
      provSelect.appendChild(opt);
    }
    const initialProvider = PROVIDER_IDS.includes(assigned.provider)
      ? assigned.provider
      : 'venice';
    provSelect.value = initialProvider;
    provLabel.appendChild(provSelect);
    row.appendChild(provLabel);

    const modelLabel = document.createElement('label');
    modelLabel.className = 'group-persona-field';
    modelLabel.textContent = 'Model';
    const modelSelect = document.createElement('select');
    modelSelect.className = 'group-persona-model';
    modelLabel.appendChild(modelSelect);
    row.appendChild(modelLabel);

    const persist = () => {
      if (provSelect.value && modelSelect.value) {
        setModelForPersona(p.id, provSelect.value, modelSelect.value);
      }
    };

    provSelect.addEventListener('change', async () => {
      modelSelect.innerHTML = '';
      modelSelect.disabled = true;
      if (!provSelect.value) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = 'Select a provider first';
        modelSelect.appendChild(empty);
        return;
      }
      await fillModelSelect(modelSelect, provSelect.value, DEFAULT_MODELS[provSelect.value] || '');
      persist();
    });
    modelSelect.addEventListener('change', persist);

    list.appendChild(row);

    if (provSelect.value) {
      await fillModelSelect(modelSelect, provSelect.value, assigned.model || DEFAULT_MODELS[provSelect.value] || '');
      persist();
    } else {
      modelSelect.innerHTML = '';
      modelSelect.disabled = true;
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Select a provider first';
      modelSelect.appendChild(empty);
    }
  }
}

function collectGroupPersonaModelsFromForm() {
  const host = els.groupPersonaModels;
  const out = { ...personaModels };
  if (!host) return out;
  host.querySelectorAll('.group-persona-row').forEach((row) => {
    const id = row.dataset.personaId;
    const provider = row.querySelector('.group-persona-provider')?.value;
    const model = row.querySelector('.group-persona-model')?.value;
    if (id && provider && model) {
      out[id] = { provider, model };
      setModelForPersona(id, provider, model);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Group setup draft — survive accidental close / miss-taps so a long opening
// prompt is never wiped just because Start was hard to hit.
// ---------------------------------------------------------------------------
const GROUP_DRAFT_KEY = 'uncensored_group_draft_v1';
function defaultGroupDraft() {
  return { topic: '', mode: 'brainstorm', rounds: 3 };
}
function readGroupDraft() {
  try {
    const raw = localStorage.getItem(GROUP_DRAFT_KEY);
    if (!raw) return defaultGroupDraft();
    const parsed = JSON.parse(raw);
    return {
      topic: typeof parsed.topic === 'string' ? parsed.topic : '',
      mode: ['boardroom', 'brainstorm', 'freechat'].includes(parsed.mode) ? parsed.mode : 'brainstorm',
      rounds: Math.min(20, Math.max(1, parseInt(parsed.rounds, 10) || 3)),
    };
  } catch {
    return defaultGroupDraft();
  }
}
function writeGroupDraft(draft) {
  try {
    localStorage.setItem(GROUP_DRAFT_KEY, JSON.stringify(draft));
  } catch { /* ignore quota */ }
}
function captureGroupDraft() {
  const modeEl = document.querySelector('input[name="groupMode"]:checked');
  const draft = {
    topic: els.groupTopicInput?.value || '',
    mode: modeEl?.value || 'brainstorm',
    rounds: parseInt(els.roundsDisplay?.textContent || '3', 10) || 3,
  };
  writeGroupDraft(draft);
  return draft;
}
function restoreGroupDraft() {
  const draft = readGroupDraft();
  if (els.groupTopicInput) els.groupTopicInput.value = draft.topic;
  const modeEl = document.querySelector(`input[name="groupMode"][value="${draft.mode}"]`);
  if (modeEl) modeEl.checked = true;
  if (els.roundsDisplay) els.roundsDisplay.textContent = String(draft.rounds);
  if (els.roundsMinus) els.roundsMinus.disabled = draft.rounds <= 1;
  if (els.roundsPlus) els.roundsPlus.disabled = draft.rounds >= 20;
}
function clearGroupDraft() {
  writeGroupDraft(defaultGroupDraft());
  if (els.groupTopicInput) els.groupTopicInput.value = '';
  const brainstorm = document.querySelector('input[name="groupMode"][value="brainstorm"]');
  if (brainstorm) brainstorm.checked = true;
  if (els.roundsDisplay) els.roundsDisplay.textContent = '3';
  if (els.roundsMinus) els.roundsMinus.disabled = false;
  if (els.roundsPlus) els.roundsPlus.disabled = false;
}

async function openGroupModal() {
  if (!els.groupModal) return;
  els.groupModal.classList.remove('hidden');
  // Restore draft — never wipe a carefully written opening on reopen.
  restoreGroupDraft();
  try {
    await renderGroupPersonaModels();
  } catch (err) {
    console.warn('Could not render persona model assignments:', err);
  }
  if (els.groupTopicInput) {
    setTimeout(() => {
      els.groupTopicInput.focus();
      // Put caret at end so returning to a draft feels continuous.
      const len = els.groupTopicInput.value.length;
      try { els.groupTopicInput.setSelectionRange(len, len); } catch { /* ignore */ }
    }, 50);
  }
}
function closeGroupModal() {
  // Snapshot draft before hiding so accidental dismiss never loses the prompt.
  captureGroupDraft();
  els.groupModal?.classList.add('hidden');
}
els.groupBtn?.addEventListener('click', () => { void openGroupModal(); });
els.closeGroupModal?.addEventListener('click', closeGroupModal);
els.cancelGroupBtn?.addEventListener('click', closeGroupModal);
// Backdrop taps must NOT dismiss — on mobile the Start control used to sit
// under the form with only a sliver visible; missing it hit the overlay,
// closed the modal, wiped the prompt, and dumped you back into normal chat.

// Rounds stepper
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 20;
els.roundsMinus?.addEventListener('click', () => {
  const cur = parseInt(els.roundsDisplay?.textContent || '3', 10);
  const next = Math.max(MIN_ROUNDS, cur - 1);
  if (els.roundsDisplay) els.roundsDisplay.textContent = String(next);
  if (els.roundsMinus) els.roundsMinus.disabled = next <= MIN_ROUNDS;
  if (els.roundsPlus)  els.roundsPlus.disabled  = false;
  captureGroupDraft();
});
els.roundsPlus?.addEventListener('click', () => {
  const cur = parseInt(els.roundsDisplay?.textContent || '3', 10);
  const next = Math.min(MAX_ROUNDS, cur + 1);
  if (els.roundsDisplay) els.roundsDisplay.textContent = String(next);
  if (els.roundsPlus)  els.roundsPlus.disabled  = next >= MAX_ROUNDS;
  if (els.roundsMinus) els.roundsMinus.disabled = false;
  captureGroupDraft();
});
els.startGroupBtn?.addEventListener('click', async () => {
  const modeEl = document.querySelector('input[name="groupMode"]:checked');
  const mode = modeEl?.value || 'brainstorm';
  const topic = (els.groupTopicInput?.value || '').trim();
  if (!topic) {
    alert('Type what you want to say to the table.');
    els.groupTopicInput?.focus();
    return;
  }
  const rounds = parseInt(els.roundsDisplay?.textContent || '3', 10) || 3;
  ensurePersonaVoices(personas);
  ensurePersonaModels(personas);
  const assigned = collectGroupPersonaModelsFromForm();
  createGroupChat(mode, topic, assigned, rounds);
  // Clear draft and hide without re-capturing the emptied form.
  clearGroupDraft();
  els.groupModal?.classList.add('hidden');
  if (isMobileViewport()) state.chatsCollapsed = true;
  saveState();
  await renderAll();
  if (els.input) els.input.placeholder = 'Address the table…';
  // Message field IS the start — don't make the user type it twice.
  chatStickToBottom = true;
  await sendGroupMessage(topic);
});

els.groupTopicInput?.addEventListener('input', () => { captureGroupDraft(); });
els.groupTopicInput?.addEventListener('keydown', (e) => {
  // Textarea: Ctrl/Cmd+Enter starts. Plain Enter inserts a newline.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    els.startGroupBtn?.click();
  }
});
document.querySelectorAll('input[name="groupMode"]').forEach((el) => {
  el.addEventListener('change', () => { captureGroupDraft(); });
});

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
        if (k.includes(`:${id}:`)) delete modelsCache[k];
      });
      allModelsCatalog = [];
      allModelsLoading = null;
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
  void copyTextToClipboard(currentArtifact.content).then((ok) =>
    flashButton(els.artifactCopyBtn, ok ? 'Copied' : 'Copy failed')
  );
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
if (els.clearChatsBtn) els.clearChatsBtn.addEventListener('click', clearChatsOnly);
els.clearAllBtn.addEventListener('click', clearAll);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAppMenu();
    if (!els.artifactModal.classList.contains('hidden')) closeArtifactModal();
    if (els.unlockPaidModal && !els.unlockPaidModal.classList.contains('hidden')) closeUnlockPaidModal();
    else if (els.modelPickerModal && !els.modelPickerModal.classList.contains('hidden')) closeModelPicker();
    if (els.keysModal && !els.keysModal.classList.contains('hidden')) closeKeysModal();
    if (els.toneModal && !els.toneModal.classList.contains('hidden')) closeToneModal();
    if (els.groupModal && !els.groupModal.classList.contains('hidden')) closeGroupModal();
  }
});

els.personaBlurb?.addEventListener('click', () => {
  openToneModal();
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
  el.textContent = 'Boot error: ' + msg + '\n\nTry a hard refresh, or open Chats → Clear chats / Reset settings.';
}

renderAll().catch((err) => {
  console.error('renderAll failed:', err);
  showBootError(err?.stack || err?.message || String(err));
});
