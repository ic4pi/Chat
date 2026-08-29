/**
 * Hub client — the bridge between the UI and the context hub.
 *
 * Chats live in localStorage as the source of truth; the hub is a synced
 * copy, not the other way around. `syncChat()` registers a chat's thread on
 * first send and keeps appending new messages every turn after that, so the
 * 3-day sweep (jokes, notes, project-grouping suggestions) can see ordinary
 * chatting, not just chats explicitly promoted to Workspace/Media/a group
 * discussion — that handoff path (`ensureThread`/`promote`) is unchanged and
 * still registers lazily for those other thread types.
 *
 * Every call degrades quietly. If the hub is not configured the buttons stay
 * hidden and the app behaves exactly as it did before.
 */

let hubAvailable = null; // null = unknown, true/false once probed

async function hubFetch(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `${res.status}`);
  return body;
}

/** One probe per page load. 503 means the env vars are not set. */
export async function hubReady() {
  if (hubAvailable !== null) return hubAvailable;
  try {
    await hubFetch('/api/hub/state?route=state&action=topics');
    hubAvailable = true;
  } catch {
    hubAvailable = false;
  }
  return hubAvailable;
}

/**
 * Returns the hub thread id for a local chat, creating it on first use.
 * Existing messages are backfilled so the sweep has something to read.
 */
export async function ensureThread(chat) {
  if (!chat) throw new Error('no chat');
  if (chat.hubThreadId) return chat.hubThreadId;

  const { threadId } = await hubFetch('/api/hub/state?route=state&action=register', {
    method: 'POST',
    body: JSON.stringify({
      type: 'chat',
      title: chat.title || 'Untitled',
      localId: chat.id,
      messages: (chat.messages || []).map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
      })),
    }),
  });

  chat.hubThreadId = threadId;
  return threadId;
}

/**
 * Continuous background sync: registers the chat if it hasn't been (now
 * idempotent server-side, so this is safe to call every turn) and appends
 * only the messages sent since the last successful sync — never the whole
 * history. Best-effort: failures are swallowed so a sync hiccup never
 * blocks or errors the chat UI, same as promote()/ensureThread() today.
 */
export async function syncChat(chat) {
  if (!chat || chat._hubSyncBusy) return;
  chat._hubSyncBusy = true;
  try {
    if (!chat.hubThreadId) {
      chat.hubThreadId = await ensureThread(chat);
      // ensureThread's own register call already backfilled everything up
      // to this point — nothing left to append for this call.
      chat.hubSyncedCount = (chat.messages || []).length;
      return;
    }

    const from = chat.hubSyncedCount || 0;
    const pending = (chat.messages || []).slice(from);
    if (!pending.length) return;

    await hubFetch('/api/hub/state?route=state&action=append', {
      method: 'POST',
      body: JSON.stringify({
        threadId: chat.hubThreadId,
        messages: pending.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
        })),
      }),
    });
    chat.hubSyncedCount = (chat.messages || []).length;
  } catch {
    // Best-effort — next successful sync picks up from wherever hubSyncedCount
    // was last left, so nothing is lost, just delayed.
  } finally {
    chat._hubSyncBusy = false;
  }
}

/** Chat message -> workspace, media, or a group discussion. */
export async function promote(chat, action, payload = {}) {
  const fromThreadId = await ensureThread(chat);
  return hubFetch(`/api/hub/initiate?route=initiate&action=${action}`, {
    method: 'POST',
    body: JSON.stringify({ fromThreadId, ...payload }),
  });
}

/** Close a group discussion: positions, vote, resolution, optional routing. */
export function moderate(threadId, opts = {}) {
  return hubFetch('/api/hub/moderate?route=moderate', {
    method: 'POST',
    body: JSON.stringify({ threadId, ...opts }),
  });
}

/** Run a media thread's seed prompt through generation. */
export function generateMedia(threadId, opts = {}) {
  return hubFetch('/api/hub/media?route=media', {
    method: 'POST',
    body: JSON.stringify({ threadId, ...opts }),
  });
}

/** Build a story bible, outline, manuscript, ad copy, etc. from topics. */
export function buildDocument(type, topicIds, opts = {}) {
  return hubFetch('/api/hub/document?route=document', {
    method: 'POST',
    body: JSON.stringify({ type, topicIds, ...opts }),
  });
}

export const getNudges = () => hubFetch('/api/hub/state?route=state&action=nudges');
export const getTopics = () => hubFetch('/api/hub/state?route=state&action=topics');
export const getInbox = () => hubFetch('/api/hub/state?route=state&action=inbox');
export const dismissNudge = (nudgeId) =>
  hubFetch('/api/hub/state?route=state&action=dismiss', {
    method: 'POST',
    body: JSON.stringify({ nudgeId }),
  });

/** Saves one persona turn from a group discussion so the moderator can read it. */
export function saveGroupTurn(threadId, { personaId, name, model, content, round }) {
  return hubFetch('/api/hub/state?route=state&action=turn', {
    method: 'POST',
    body: JSON.stringify({ threadId, personaId, name, model, content, round }),
  }).catch(() => {}); // never block the live discussion on a persistence failure
}
