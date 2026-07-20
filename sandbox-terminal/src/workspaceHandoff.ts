/**
 * Handoff from main chat → coding workspace (/agent).
 * sessionStorage so a refresh of /agent still picks it up once.
 */

export const WORKSPACE_HANDOFF_KEY = 'chat_to_workspace_v1';

export interface WorkspaceHandoff {
  v: 1;
  title?: string;
  provider?: string;
  model?: string;
  role?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
}

export function consumeWorkspaceHandoff(): WorkspaceHandoff | null {
  try {
    const raw = sessionStorage.getItem(WORKSPACE_HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(WORKSPACE_HANDOFF_KEY);
    const data = JSON.parse(raw) as WorkspaceHandoff;
    if (!data || data.v !== 1 || !Array.isArray(data.messages)) return null;
    return data;
  } catch {
    try { sessionStorage.removeItem(WORKSPACE_HANDOFF_KEY); } catch { /* ignore */ }
    return null;
  }
}
