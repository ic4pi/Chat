/**
 * Persist workspace sessions in the browser.
 * Multiple conversations keyed by chatId so Home can list them,
 * and a handoff from Chat replaces that chat’s workspace thread.
 */

const LEGACY_KEY = 'agent_session_v1';
const STORE_KEY = 'agent_sessions_v2';
const ACTIVE_KEY = 'agent_sessions_active_v2';

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind?: string;
  speaker?: 'persona' | 'coder';
  to?: 'persona';
  pending?: boolean;
  wantCompare?: boolean;
  builtBy?: string;
  reasoning?: string;
}

export interface StoredSession {
  v: 2;
  id: string;
  title: string;
  savedAt: number;
  repoUrl: string | null;
  sandboxId: string | null;
  provider: string;
  model: string;
  autoApplyOn: boolean;
  messages: StoredMessage[];
  pendingChanges: Array<{ path: string; content: string; original?: string }>;
  fromChat?: boolean;
  /** Files the agent wrote (path → content), to rebuild an expired sandbox. */
  files?: Record<string, string>;
}

interface SessionStore {
  v: 2;
  sessions: Record<string, StoredSession>;
}

/** workspaceSync listens here, so saves and deletes reach the server copy. */
type SyncListener = { saved(id: string): void; deleted(id: string): void };
let syncListener: SyncListener | null = null;
export function setSessionSyncListener(l: SyncListener | null): void { syncListener = l; }

function emptyStore(): SessionStore {
  return { v: 2, sessions: {} };
}

function readStore(): SessionStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as SessionStore;
      if (data?.v === 2 && data.sessions && typeof data.sessions === 'object') {
        return data;
      }
    }
  } catch { /* ignore */ }

  // One-time migrate legacy single session.
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (!legacyRaw) return emptyStore();
    const legacy = JSON.parse(legacyRaw) as {
      v?: number;
      savedAt?: number;
      repoUrl?: string | null;
      sandboxId?: string | null;
      provider?: string;
      model?: string;
      autoApplyOn?: boolean;
      messages?: StoredMessage[];
      pendingChanges?: StoredSession['pendingChanges'];
    };
    if (!legacy || legacy.v !== 1) return emptyStore();
    const id = 'legacy-home';
    const migrated: StoredSession = {
      v: 2,
      id,
      title: 'Home workspace',
      savedAt: legacy.savedAt || Date.now(),
      repoUrl: legacy.repoUrl ?? null,
      sandboxId: legacy.sandboxId ?? null,
      provider: legacy.provider || 'venice',
      model: legacy.model || 'venice-uncensored',
      autoApplyOn: !!legacy.autoApplyOn,
      messages: legacy.messages || [],
      pendingChanges: legacy.pendingChanges || [],
      fromChat: false,
    };
    const store = { v: 2 as const, sessions: { [id]: migrated } };
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    localStorage.setItem(ACTIVE_KEY, id);
    localStorage.removeItem(LEGACY_KEY);
    return store;
  } catch {
    return emptyStore();
  }
}

function writeStore(store: SessionStore): void {
  // Drop sessions older than 30 days / keep newest 40
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let entries = Object.values(store.sessions)
    .filter((s) => (s.savedAt || 0) >= cutoff)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    .slice(0, 40);
  // Deleting the last session must still write: an empty loop here left it
  // in storage, so it came straight back.
  if (!entries.length) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(emptyStore())); } catch { /* ignore */ }
    return;
  }
  // When storage is full, the write used to fail silently and *nothing* was
  // saved from then on. Drop the oldest sessions until the newest ones fit.
  while (entries.length) {
    const next: SessionStore = { v: 2, sessions: {} };
    for (const s of entries) next.sessions[s.id] = s;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
      return;
    } catch {
      if (entries.length === 1) break;
      entries = entries.slice(0, Math.max(1, Math.floor(entries.length * 0.75)));
    }
  }
}

/**
 * Sessions saved before speaker/to were persisted lost them. In a session that
 * used the persona (it has briefs), the coder only ever answers a brief or a
 * test failure — so an answer straight after one of your messages is the
 * persona's, and that message was addressed to it.
 */
export function repairOrchestratorTags(messages: StoredMessage[]): StoredMessage[] {
  if (!messages.some((m) => m.kind === 'brief')) return messages;
  if (messages.some((m) => m.speaker || m.to)) return messages; // already tagged
  return messages.map((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (m.role === 'assistant' && prev?.role === 'user' && (!prev.kind || prev.kind === 'user')) {
      return { ...m, speaker: 'persona' as const };
    }
    if (m.role === 'user' && (!m.kind || m.kind === 'user') && next?.role === 'assistant') {
      return { ...m, to: 'persona' as const };
    }
    return m;
  });
}

export function listSessions(): StoredSession[] {
  const store = readStore();
  return Object.values(store.sessions).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export function getActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveSessionId(id: string | null): void {
  try {
    if (!id) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
  } catch { /* ignore */ }
}

/** As stored, untouched — what sync compares and uploads. */
export function getStoredSession(id: string): StoredSession | null {
  return readStore().sessions[id] ?? null;
}

/** Exactly this session, or null — no falling back to some other one. */
export function getSession(id: string): StoredSession | null {
  const hit = readStore().sessions[id];
  return hit ? { ...hit, messages: repairOrchestratorTags(hit.messages || []) } : null;
}

/**
 * Re-opening Workspace from the same chat: keep everything done here
 * (workspace messages, drafts, files, sandbox) and add only the chat turns
 * that are new since last time. If the chat's history changed underneath
 * (edited, regenerated, trimmed), refresh that part and still keep the work.
 */
/**
 * Back from chat into the same project: what you said in chat since last
 * time goes at the END, after the Workspace's own work — it's the newest
 * thing, and the persona has to read it as such.
 *
 * Matching is by role + the start of the text, not exact equality: saved
 * messages are cut at 40k characters and only the last 120 are kept, and an
 * exact prefix check failed on both — which put the whole chat back above
 * the Workspace work, so your new plans read as old history.
 */
export function mergeHandoffMessages(prev: StoredMessage[], imported: StoredMessage[]): StoredMessage[] {
  if (!prev.length) return imported;
  const prevImported = prev.filter((m) => m.kind === 'imported');
  if (!prevImported.length) return [...imported, ...prev];
  const key = (m: StoredMessage) => `${m.role}:${String(m.content || '').trim().slice(0, 500)}`;
  const known = new Set(prevImported.map(key));
  // Where the chat picks up: the latest chat message this project already has.
  let last = -1;
  for (let i = imported.length - 1; i >= 0; i--) {
    if (known.has(key(imported[i]))) { last = i; break; }
  }
  const fresh = last >= 0 ? imported.slice(last + 1) : imported.filter((m) => !known.has(key(m)));
  return fresh.length ? [...prev, ...fresh] : prev;
}

export function loadSession(id?: string | null): StoredSession | null {
  const store = readStore();
  const target = id || getActiveSessionId();
  const list = Object.values(store.sessions).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const hit = (target && store.sessions[target]) || list[0] || null;
  return hit ? { ...hit, messages: repairOrchestratorTags(hit.messages || []) } : null;
}

export function saveSession(
  partial: Omit<StoredSession, 'v' | 'savedAt'> & { id: string; title: string },
): void {
  const store = readStore();
  const prev = store.sessions[partial.id];
  const payload: StoredSession = {
    v: 2,
    savedAt: Date.now(),
    ...partial,
    title: partial.title || prev?.title || 'Workspace',
    messages: (partial.messages || []).slice(-120).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content.length > 40_000
        ? m.content.slice(0, 40_000) + '\n/* …truncated for session save … */'
        : m.content,
      kind: m.kind,
      // Who said it — without these, a reload feeds the persona's own replies
      // back to it as coder results and the handoff falls apart.
      speaker: m.speaker,
      to: m.to,
      pending: m.pending,
      wantCompare: m.wantCompare,
      builtBy: m.builtBy,
      reasoning: m.reasoning,
    })),
    pendingChanges: (partial.pendingChanges || []).slice(0, 30).map((c) => ({
      path: c.path,
      content: c.content.length > 200_000 ? c.content.slice(0, 200_000) : c.content,
      original: c.original && c.original.length > 200_000
        ? c.original.slice(0, 200_000)
        : c.original,
    })),
  };
  store.sessions[partial.id] = payload;
  writeStore(store);
  setActiveSessionId(partial.id);
  syncListener?.saved(partial.id);
}

/** A copy from the server: stored as-is, not echoed back. */
export function putSyncedSession(session: StoredSession): void {
  const store = readStore();
  store.sessions[session.id] = session;
  writeStore(store);
}

/** Deleted on another device: drop it here without telling the server again. */
export function dropSyncedSession(id: string): void {
  const store = readStore();
  if (!store.sessions[id]) return;
  delete store.sessions[id];
  writeStore(store);
  if (getActiveSessionId() === id) setActiveSessionId(listSessions()[0]?.id || null);
}

export function clearSession(id?: string | null): void {
  const store = readStore();
  const target = id || getActiveSessionId();
  if (target && store.sessions[target]) {
    delete store.sessions[target];
    writeStore(store);
    syncListener?.deleted(target);
  }
  if (target && getActiveSessionId() === target) {
    const next = listSessions()[0];
    setActiveSessionId(next?.id || null);
  }
}

export function clearAllSessions(): void {
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* ignore */ }
}

/** Ready-to-paste shell commands for the open sandbox repo (no placeholders). */
export function buildPushShellCommands(opts: {
  commitMessage?: string;
}): string {
  const msg = (opts.commitMessage || 'Apply agent changes').replace(/"/g, '\\"');
  return [
    'cd /vercel/sandbox/repo',
    'git status',
    'git add -A',
    `git commit -m "${msg}" || echo "Nothing new to commit"`,
    'echo "Push needs auth — use the Push to GitHub button (paste a token), or:"',
    'echo "git push origin HEAD"',
  ].join('\n');
}
