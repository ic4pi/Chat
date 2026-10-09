/**
 * Workspace sessions — the chat with your persona and coder plus the files
 * the agent wrote — kept on the server too, per owner. That's what lets a
 * linked device open the same project, and a wiped browser or a dead sandbox
 * get it back.
 *
 *   pullSessions()   before the app renders, and when you come back to a tab
 *   (saves)          sessionStore tells us; pushed a few seconds later
 *
 * A session counts as changed here when its content differs from the copy
 * last synced (a signature, not a flag — re-saving the same thing is not a
 * change). If both this device and the server changed it, nothing is thrown
 * away: the server's version takes the id and this device's is kept as a
 * copy titled "(this device)".
 */

import {
  getActiveSessionId,
  getStoredSession,
  listSessions,
  putSyncedSession,
  dropSyncedSession,
  setSessionSyncListener,
  type StoredSession,
} from './sessionStore.js';

const API_URL = (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';
const url = (action: string) => `${API_URL}/hub/state?action=${action}`;

const META_KEY = 'workspace_sessions_sync_v1';
/** Per session: the server's stamp and the content signature last synced. */
type Meta = Record<string, { syncedAt: string; sig: string }>;

function readMeta(): Meta {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') as Meta; } catch { return {}; }
}
function writeMeta(m: Meta): void {
  try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
/** Read-modify-write one entry, so a push and a pull never undo each other. */
function setMeta(id: string, v: Meta[string] | null): void {
  const m = readMeta();
  if (v) m[id] = v; else delete m[id];
  writeMeta(m);
}

/** FNV-1a over the session minus its save time. */
export function signature(s: StoredSession): string {
  const { savedAt: _ignored, ...rest } = s;
  const text = JSON.stringify(rest);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

const MONTH = 30 * 24 * 60 * 60 * 1000;
let pulled = false;
let pulling: Promise<PullResult> | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const firstQueued = new Map<string, number>();

async function pushOne(id: string): Promise<void> {
  timers.delete(id);
  firstQueued.delete(id);
  const s = getStoredSession(id);
  if (!s) return;
  const sig = signature(s);
  if (readMeta()[id]?.sig === sig) return;
  try {
    const res = await fetch(url('workspace-save'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: s }),
    });
    if (!res.ok) return; // stays changed; the next save or load retries
    const { updatedAt } = await res.json() as { updatedAt?: string };
    setMeta(id, { syncedAt: updatedAt || new Date().toISOString(), sig });
  } catch { /* offline: retried later */ }
}

/** A few seconds after the last save, and at least every 15s while busy. */
function schedule(id: string): void {
  if (!pulled) return;
  const now = Date.now();
  if (!firstQueued.has(id)) firstQueued.set(id, now);
  const prev = timers.get(id);
  if (prev) clearTimeout(prev);
  const delay = Math.max(0, Math.min(4000, firstQueued.get(id)! + 15000 - now));
  timers.set(id, setTimeout(() => { void pushOne(id); }, delay));
}

function flushAll(): Promise<void[]> {
  return Promise.all([...timers.keys()].map(id => {
    clearTimeout(timers.get(id)!);
    return pushOne(id);
  }));
}

async function pushDelete(id: string): Promise<void> {
  setMeta(id, null);
  try {
    await fetch(url('workspace-delete'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch { /* the other device keeps it; harmless */ }
}

export interface PullResult {
  /** Anything written into this browser's sessions. */
  changed: boolean;
  /** The session open right now was replaced by a newer server copy. */
  activeReplaced: boolean;
}

/** Bring this browser up to date with the server, then send what only it has. */
export function pullSessions(): Promise<PullResult> {
  if (pulling) return pulling;
  pulling = (async (): Promise<PullResult> => {
    const out: PullResult = { changed: false, activeReplaced: false };
    const activeId = getActiveSessionId();
    try {
      const res = await fetch(url('workspace-list'), { credentials: 'include' });
      if (!res.ok) return out;
      const { sessions = [] } = await res.json() as {
        sessions?: Array<{ session_id: string; saved_at: number; deleted: boolean; updated_at: string }>;
      };
      const remoteIds = new Set<string>();
      for (const r of sessions) {
        const id = r.session_id;
        remoteIds.add(id);
        const m = readMeta()[id];
        const newer = !m || Date.parse(r.updated_at) > Date.parse(m.syncedAt);
        if (!newer) continue;
        const local = getStoredSession(id);
        const localChanged = !!local && (!m || signature(local) !== m.sig);
        if (r.deleted) {
          if (local && !localChanged) { dropSyncedSession(id); out.changed = true; }
          setMeta(id, null);
          continue;
        }
        if (Date.now() - (Number(r.saved_at) || 0) > MONTH) continue; // this browser drops those anyway
        const got = await fetch(`${url('workspace-get')}&id=${encodeURIComponent(id)}`, { credentials: 'include' });
        if (!got.ok) continue;
        const { session } = await got.json() as { session?: StoredSession };
        if (!session?.id) continue;
        const sig = signature(session);
        if (local && signature(local) === sig) { setMeta(id, { syncedAt: r.updated_at, sig }); continue; }
        if (local && localChanged) {
          // Both sides changed it: keep this device's version as its own session.
          const copyId = `${id}-here-${Date.now().toString(36)}`;
          putSyncedSession({ ...local, id: copyId, title: `${local.title} (this device)` });
        }
        putSyncedSession(session);
        setMeta(id, { syncedAt: r.updated_at, sig });
        out.changed = true;
        if (id === activeId) out.activeReplaced = true;
      }
      pulled = true;
      // What only this browser has (or changed since the last sync) goes up now.
      for (const s of listSessions()) {
        const m = readMeta()[s.id];
        if (!remoteIds.has(s.id) || !m || m.sig !== signature(s)) schedule(s.id);
      }
      return out;
    } catch {
      return out;
    } finally {
      pulled = true;
      pulling = null;
    }
  })();
  return pulling;
}

let started = false;
/**
 * Before the app renders. Resolves within `timeoutMs`; a pull that answers
 * later and replaces the open session reloads once to show it.
 */
export function startWorkspaceSync({ timeoutMs = 4000 } = {}): Promise<void> {
  if (!started) {
    started = true;
    setSessionSyncListener({ saved: schedule, deleted: (id) => { void pushDelete(id); } });
    // Back to a tab left open on this device: another device may have moved on.
    let lastPull = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { void flushAll(); return; }
      if (Date.now() - lastPull < 30_000) return;
      lastPull = Date.now();
      void flushAll()
        .then(() => pullSessions())
        .then(r => { if (r.activeReplaced) window.location.reload(); });
    });
  }
  let timedOut = false;
  const work = pullSessions().then(r => { if (timedOut && r.activeReplaced) window.location.reload(); });
  return Promise.race([
    work,
    new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs)),
  ]);
}
