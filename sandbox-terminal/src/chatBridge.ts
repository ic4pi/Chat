/**
 * Chat ⇄ Workspace are one conversation, not two.
 *
 * The main chat (public/app.js) and the Workspace (/agent) run on the same
 * origin, so they share localStorage. The chat stores everything under
 * `uncensored_chat_state_v3` as { chats: [{ id, messages, ... }], activeChatId }.
 *
 * The Workspace used to take a one-time sessionStorage snapshot of that chat
 * when you pressed "Open in Workspace". Re-enter any other way — back button,
 * reload, a second visit — and there was no snapshot, so you saw the stale
 * saved Workspace thread ("same old messages"). And nothing the persona said
 * in the Workspace ever went back to the chat.
 *
 * This reads and writes that same chat live, keyed by chat id:
 *   readChatConversation()  the chat's current messages, whenever asked
 *   mirrorToChat()          the persona's and your Workspace turns, back into it
 *
 * Only the human-facing turns cross over — your messages and the persona's
 * replies. The coder's raw output, briefs, auto-test notes and UI-only lines
 * stay in the Workspace; they are noise in the chat.
 */

const CHAT_STORAGE_KEY = 'uncensored_chat_state_v3';

interface ChatMsg { role: string; content: string; ts?: number }
interface Chat { id: string; name?: string; personaId?: string; provider?: string; model?: string; messages?: ChatMsg[]; updatedAt?: number }
interface ChatState { chats?: Chat[]; activeChatId?: string | null }

export interface BridgeMessage { role: 'user' | 'assistant'; content: string }
export interface ChatConversation {
  chatId: string;
  personaId?: string;
  provider?: string;
  model?: string;
  title?: string;
  messages: BridgeMessage[];
}

/** Match across the two stores by role + the start of the text (messages get
 *  truncated and capped on save, so exact equality is unreliable). */
export const sigOf = (role: string, content: string) =>
  `${role}:${String(content || '').trim().slice(0, 500)}`;

function readState(): ChatState | null {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as ChatState;
    return s && Array.isArray(s.chats) ? s : null;
  } catch { return null; }
}

function pickChat(state: ChatState, chatId?: string): Chat | null {
  const chats = state.chats || [];
  if (chatId) return chats.find((c) => c.id === chatId) || null;
  if (state.activeChatId) return chats.find((c) => c.id === state.activeChatId) || null;
  return null;
}

/** Only the turns that belong in a shared conversation. */
const isHumanFacing = (m: ChatMsg) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0;

/**
 * The chat's live conversation for this id (or the active chat). Returns null
 * when there is no matching chat — a project started inside the Workspace.
 */
export function readChatConversation(chatId?: string): ChatConversation | null {
  const state = readState();
  if (!state) return null;
  const chat = pickChat(state, chatId);
  if (!chat) return null;
  return {
    chatId: chat.id,
    personaId: chat.personaId,
    provider: chat.provider,
    model: chat.model,
    title: chat.name,
    messages: (chat.messages || []).filter(isHumanFacing).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  };
}

/**
 * Write the Workspace's human-facing turns back into the chat, appending any
 * the chat does not already have (matched by signature). No chat for this id
 * (a Workspace-only project) → nothing happens. Never throws.
 */
export function mirrorToChat(chatId: string, msgs: BridgeMessage[]): boolean {
  if (!chatId || !msgs.length) return false;
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw) as ChatState;
    const chat = (state.chats || []).find((c) => c.id === chatId);
    if (!chat) return false;
    chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
    const have = new Set(chat.messages.filter(isHumanFacing).map((m) => sigOf(m.role, m.content)));
    let added = 0;
    const now = Date.now();
    for (const m of msgs) {
      const sig = sigOf(m.role, m.content);
      if (have.has(sig)) continue;
      have.add(sig);
      chat.messages.push({ role: m.role, content: m.content, ts: now + added });
      added++;
    }
    if (!added) return false;
    chat.updatedAt = now;
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch { return false; }
}
