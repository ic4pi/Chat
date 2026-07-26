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
}

interface SessionStore {
  v: 2;
  sessions: Record<string, StoredSession>;
}

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
  try {
    // Drop sessions older than 30 days / keep newest 40
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const entries = Object.values(store.sessions)
      .filter((s) => (s.savedAt || 0) >= cutoff)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, 40);
    const next: SessionStore = { v: 2, sessions: {} };
    for (const s of entries) next.sessions[s.id] = s;
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode — ignore
  }
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

export function loadSession(id?: string | null): StoredSession | null {
  const store = readStore();
  const target = id || getActiveSessionId();
  if (target && store.sessions[target]) return store.sessions[target];
  const list = Object.values(store.sessions).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return list[0] || null;
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
    messages: (partial.messages || []).slice(-40).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content.length > 40_000
        ? m.content.slice(0, 40_000) + '\n/* …truncated for session save … */'
        : m.content,
      kind: m.kind,
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
}

export function clearSession(id?: string | null): void {
  const store = readStore();
  const target = id || getActiveSessionId();
  if (target && store.sessions[target]) {
    delete store.sessions[target];
    writeStore(store);
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
