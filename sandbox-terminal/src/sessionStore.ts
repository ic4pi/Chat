/**
 * Persist agent session in the browser so refresh doesn't wipe work.
 * Stores repo URL, sandbox id, chat, and pending file changes.
 */

const KEY = 'agent_session_v1';

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind?: string;
}

export interface StoredSession {
  v: 1;
  savedAt: number;
  repoUrl: string | null;
  sandboxId: string | null;
  provider: string;
  model: string;
  autoApplyOn: boolean;
  messages: StoredMessage[];
  pendingChanges: Array<{ path: string; content: string; original?: string }>;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoredSession;
    if (!data || data.v !== 1) return null;
    // Drop sessions older than 7 days
    if (Date.now() - (data.savedAt || 0) > 7 * 24 * 60 * 60 * 1000) {
      localStorage.removeItem(KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function saveSession( partial: Omit<StoredSession, 'v' | 'savedAt'>): void {
  try {
    const payload: StoredSession = {
      v: 1,
      savedAt: Date.now(),
      ...partial,
      // Cap chat history so localStorage doesn't explode
      messages: (partial.messages || []).slice(-40).map(m => ({
        id: m.id,
        role: m.role,
        content: m.content.length > 40_000
          ? m.content.slice(0, 40_000) + '\n/* …truncated for session save … */'
          : m.content,
        kind: m.kind,
      })),
      pendingChanges: (partial.pendingChanges || []).slice(0, 30).map(c => ({
        path: c.path,
        content: c.content.length > 200_000 ? c.content.slice(0, 200_000) : c.content,
        original: c.original && c.original.length > 200_000
          ? c.original.slice(0, 200_000)
          : c.original,
      })),
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Quota / private mode — ignore
  }
}

export function clearSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
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
