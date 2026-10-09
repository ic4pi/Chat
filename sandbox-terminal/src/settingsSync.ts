/**
 * Coding teams and seat picks, kept on the server too.
 *
 * localStorage is the fast copy the app reads; the server copy (Supabase,
 * tied to the app's 10-year owner cookie) is the one that survives the
 * browser wiping it — Safari's 7-day storage rule, "clear website data",
 * a storage-quota purge.
 *
 *   pullSettings()          before the app renders: restore what's missing
 *   noteSettingsChanged()   from every save: push (debounced)
 *
 * No push before the pull has answered, so a wiped browser's defaults can
 * never overwrite the saved teams it is about to get back.
 */

const API_URL = (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';
const ENDPOINT = `${API_URL}/hub/state?action=settings`;

/** Everything a coding team is made of. */
export const SYNCED_KEYS = [
  'workspace_coding_team_v1',   // chosen team + seats + ask-first
  'workspace_saved_teams_v1',   // your named teams
  'uncensored_role_models_v1',  // Plan / Write / Review models
  'workspace_orchestrator_v1',  // persona + its model
] as const;

const STATE_KEY = 'workspace_settings_sync_v1';
interface SyncState { syncedAt: string | null; dirty: boolean }

function readState(): SyncState {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') as Partial<SyncState> | null;
    return { syncedAt: typeof s?.syncedAt === 'string' ? s.syncedAt : null, dirty: !!s?.dirty };
  } catch { return { syncedAt: null, dirty: false }; }
}
function writeState(s: SyncState): void {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function collect(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SYNCED_KEYS) {
    try {
      const raw = localStorage.getItem(k);
      if (raw) out[k] = JSON.parse(raw);
    } catch { /* skip a corrupt key */ }
  }
  return out;
}

let pulled = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function push(): Promise<void> {
  timer = null;
  const settings = collect();
  if (!Object.keys(settings).length) return;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    if (!res.ok) return; // stays dirty; the next change or load retries
    const { updatedAt } = await res.json() as { updatedAt?: string };
    writeState({ syncedAt: updatedAt || new Date().toISOString(), dirty: false });
  } catch { /* offline: stays dirty */ }
}

/** Call after writing any of SYNCED_KEYS. */
export function noteSettingsChanged(): void {
  writeState({ ...readState(), dirty: true });
  if (!pulled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void push(); }, 1200);
}

/**
 * On load. Local changes not yet sent win and are sent now; otherwise a
 * server copy this browser hasn't seen (it was wiped, or this is a fresh
 * one) is written back into localStorage. Resolves `true` when it restored
 * anything. Never rejects; gives up waiting after `timeoutMs` (the pull
 * still finishes in the background and calls `onLateRestore`).
 */
export function pullSettings({ timeoutMs = 3000, onLateRestore }: {
  timeoutMs?: number; onLateRestore?: () => void;
} = {}): Promise<boolean> {
  let timedOut = false;
  // Decided on what this browser had before the app started: saves the app
  // makes while we wait (resolving a default team) don't count as yours.
  const local = readState();
  const hadLocal = Object.keys(collect()).length > 0;
  const work = (async (): Promise<boolean> => {
    try {
      const res = await fetch(ENDPOINT, { credentials: 'include' });
      if (!res.ok) return false;
      const { settings, updatedAt } = await res.json() as { settings: Record<string, unknown> | null; updatedAt: string | null };
      if (local.dirty || !settings || !updatedAt) {
        // Ours is newer, or the server has nothing yet (first run with sync).
        pulled = true;
        if (local.dirty || hadLocal) await push();
        return false;
      }
      // Postgres and JS print the same instant differently — compare times.
      if (local.syncedAt && Date.parse(updatedAt) <= Date.parse(local.syncedAt)) return false;
      for (const k of SYNCED_KEYS) {
        if (settings[k] === undefined) continue;
        try { localStorage.setItem(k, JSON.stringify(settings[k])); } catch { /* ignore */ }
      }
      writeState({ syncedAt: updatedAt, dirty: false });
      if (timedOut) onLateRestore?.();
      return true;
    } catch {
      return false;
    } finally {
      pulled = true;
      // Changes made while waiting go out now.
      if (readState().dirty && !timer) timer = setTimeout(() => { void push(); }, 1200);
    }
  })();
  return Promise.race([
    work,
    new Promise<boolean>(resolve => setTimeout(() => { timedOut = true; resolve(false); }, timeoutMs)),
  ]);
}
