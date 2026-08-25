/**
 * Hub client — the bridge between the UI and the context hub.
 *
 * Chats live in localStorage, so nothing exists server-side for a thought to
 * be promoted *from*. Threads are therefore registered lazily: the first time
 * a chat hands something off, it is created in the hub and the returned id is
 * cached on the local chat object. Nothing is registered until it needs to be.
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
