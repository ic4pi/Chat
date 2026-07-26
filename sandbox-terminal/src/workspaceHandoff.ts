/**
 * Handoff from main chat → coding workspace (/agent).
 * Cached in-memory so React Strict Mode remounts don’t lose it after
 * sessionStorage is cleared on first consume.
 */

export const WORKSPACE_HANDOFF_KEY = 'chat_to_workspace_v1';

export interface WorkspaceHandoff {
  v: 1;
  chatId?: string;
  title?: string;
  provider?: string;
  model?: string;
  role?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
}

/** undefined = not read yet; null = no handoff this page load */
let cachedHandoff: WorkspaceHandoff | null | undefined;

export function peekWorkspaceHandoff(): WorkspaceHandoff | null {
  if (cachedHandoff !== undefined) return cachedHandoff;
  try {
    const raw = sessionStorage.getItem(WORKSPACE_HANDOFF_KEY);
    if (!raw) {
      cachedHandoff = null;
      return null;
    }
    sessionStorage.removeItem(WORKSPACE_HANDOFF_KEY);
    const data = JSON.parse(raw) as WorkspaceHandoff;
    if (!data || data.v !== 1 || !Array.isArray(data.messages)) {
      cachedHandoff = null;
      return null;
    }
    cachedHandoff = data;
    return data;
  } catch {
    try { sessionStorage.removeItem(WORKSPACE_HANDOFF_KEY); } catch { /* ignore */ }
    cachedHandoff = null;
    return null;
  }
}

/** @deprecated use peekWorkspaceHandoff — kept for call-site clarity */
export function consumeWorkspaceHandoff(): WorkspaceHandoff | null {
  return peekWorkspaceHandoff();
}
