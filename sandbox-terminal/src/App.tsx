import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTree }         from './FileTree.js';
import { ChatPane }         from './ChatPane.js';
import type { ChatHandle, Message }  from './ChatPane.js';
import { DiffPanel }        from './DiffPanel.js';
import { SandboxTerminal }  from './Terminal.js';
import type { TerminalHandle } from './Terminal.js';
import { PreviewPanel }     from './PreviewPanel.js';
import { useRepoContext }   from './useRepoContext.js';
import { useAutoVerify }    from './useAutoVerify.js';
import type { PendingChange } from './useRepoContext.js';
import {
  isJunkContextPath,
  isSourcePath,
  pickAuditSeedPaths,
  MAX_AUTO_FULL_FILE_CHARS,
  MAX_AUTO_FULL_FILES,
  MAX_AUDIT_FULL_FILES,
  type SearchHit,
} from './contextBudget.js';
import {
  extractFileChangeReport,
  formatRejectedSandboxWarning,
  looksLikeSuggestRequest,
  needsCodeContext,
  applyFileEdit,
} from './agentParse.js';
import type { FileNode } from './types.js';
import {
  loadSession,
  saveSession,
  clearSession,
  listSessions,
  setActiveSessionId,
  repairOrchestratorTags,
  getSession,
  mergeHandoffMessages,
  buildPushShellCommands,
  type StoredSession,
} from './sessionStore.js';
import { copyText } from './downloadFile.js';
import { peekWorkspaceHandoff } from './workspaceHandoff.js';
import { readChatConversation, mirrorToChat } from './chatBridge.js';
import {
  loadOrchestratorPrefs,
  saveOrchestratorPrefs,
  type OrchestratorPrefs,
} from './orchestrator.js';
import {
  PROVIDER_LIST,
  ROLE_LIST,
  type RoleId,
  type CatalogModel,
  loadProviderKeys,
  saveProviderKeys,
  loadRoleModels,
  saveRoleModels,
  fetchModels,
  DEFAULT_MODELS,
  FALLBACK_MODELS,
  paidUnlocked,
  savePaidPassword,
} from './providerPrefs.js';
import {
  loadCoderModels,
  pickDefaultCoder,
  flattenCoderModels,
  coderKey,
  parseCoderKey,
  type ResolvedCoderBrand,
} from './coderModels.js';
import type { GenerateChunkResult } from './ChunkModelPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import { ComparePanel, type BuildChoice, type CompareHandle } from './ComparePanel.js';
import { BuildPicker, type BuildChoiceSeats, type TeamOption } from './BuildPicker.js';
import {
  PRESETS,
  SEATS,
  costStars,
  isUncensoredModel,
  stars,
  loadTeamPrefs,
  resolvePreset,
  rolesFromSeats,
  saveTeamPrefs,
  loadSavedTeams,
  saveSavedTeams,
  upsertSavedTeam,
  renameModelInTeams,
  seatsStars,
  lockedSeats,
  type PresetId,
  type SavedTeam,
  type SeatModel,
  type TeamPrefs,
  type TeamSeats,
} from './codingTeam.js';
import type { BuildRequest, SeatPick } from './ChatPane.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

const MODEL_SCOPE_KEY = 'workspace_model_scope_v1';

const MOBILE_QUERY = '(max-width: 900px)';

/** Mount only one layout — CSS-hiding both trees duplicated ChatPane/Terminal
 *  (broken refs, zero-size #chat-input on mobile, lost messages). */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

function flattenTreePaths(nodes: FileNode[], prefix = ''): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === 'file') out.push(p);
    else if (n.children) out.push(...flattenTreePaths(n.children, p));
  }
  return out;
}

async function fetchAutoContext(
  root: string,
  query: string,
  sandboxId: string | null,
  maxFiles = 6,
): Promise<SearchHit[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sandboxId) headers['X-Sandbox-Session'] = sandboxId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${API_URL}/search`, {
      method: 'POST', headers,
      body: JSON.stringify({ root, query, maxFiles }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      matches?: Array<{ path: string; score?: number; size?: number; reason?: string; snippets?: string[] }>;
    };
    return (data.matches ?? [])
      .filter(m => m.path && !isJunkContextPath(m.path) && isSourcePath(m.path))
      .map(m => ({
        path: m.path,
        score: m.score,
        size: m.size,
        reason: m.reason,
        snippets: m.snippets ?? [],
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFileContent(
  root: string,
  relPath: string,
  sandboxId: string | null,
  maxBytes = MAX_AUTO_FULL_FILE_CHARS,
): Promise<string | null> {
  if (isJunkContextPath(relPath) || !isSourcePath(relPath)) return null;
  try {
    const headers: Record<string, string> = {};
    if (sandboxId) headers['X-Sandbox-Session'] = sandboxId;
    const url = sandboxId
      ? `${API_URL}/file?path=${encodeURIComponent(relPath)}&maxBytes=${maxBytes}`
      : `${API_URL}/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = await res.json() as { content?: string };
    if (data.content == null) return null;
    // Large sources (e.g. public/app.js) used to be skipped entirely — that left
    // the agent with no implementation to read. Truncate instead of dropping.
    if (data.content.length > MAX_AUTO_FULL_FILE_CHARS) {
      const head = Math.floor(MAX_AUTO_FULL_FILE_CHARS * 0.7);
      const tail = MAX_AUTO_FULL_FILE_CHARS - head - 80;
      return (
        data.content.slice(0, head) +
        `\n\n/* … truncated ${data.content.length - MAX_AUTO_FULL_FILE_CHARS} chars for context budget … */\n\n` +
        data.content.slice(-Math.max(tail, 0))
      );
    }
    return data.content;
  } catch {
    return null;
  }
}

type MobileTab = 'files' | 'chat' | 'terminal' | 'preview';

// ---------------------------------------------------------------------------
// VerifyBanner
// ---------------------------------------------------------------------------
function VerifyBanner({ verifyState, attempt, testCommand, askCommand, onRun, onSetCommand, onDismiss }: {
  verifyState: string; attempt: number; testCommand: string | null; askCommand: boolean;
  onRun: () => void; onSetCommand: (c: string) => void; onDismiss: () => void;
}) {
  const [cmd, setCmd] = useState('');
  if (verifyState === 'idle') return null;
  const passed = verifyState === 'passed';
  const failed = verifyState === 'failed';
  const running = verifyState === 'running' || verifyState === 'detecting'
    || String(verifyState).startsWith('retry');
  const color = passed ? '#09080C' : failed ? '#fff' : '#09080C';
  const bg = passed ? '#34D399' : failed ? '#8a1f1f' : '#FF1F5A';
  const shortCmd = testCommand
    ? (testCommand.length > 64 ? `${testCommand.slice(0, 64)}…` : testCommand)
    : '…';
  const label = verifyState === 'detecting' ? 'Checking…' :
    verifyState === 'running' ? `Testing — ${shortCmd}` :
    passed ? 'Tests passed — Push unlocked' :
    failed ? `Tests failed after ${attempt} tries — Push locked` :
    `Fixing — try ${attempt} of 5`;
  if (askCommand) return (
    <div data-testid="verify-banner" style={{ padding: '10px 12px', background: '#5a1010',
      borderTop: '2px solid #ff6a6a', flexShrink: 0 }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#ffb4b4', marginBottom: 6 }}>
        No test found — enter a command to run
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={cmd} onChange={e => setCmd(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && cmd.trim() && onSetCommand(cmd.trim())}
          placeholder="npm test"
          style={{ flex: 1, background: '#16131B', color: '#F2ECEF', border: '1px solid #2A2030',
            borderRadius: 4, padding: '4px 8px', fontFamily: 'inherit', fontSize: 16, outline: 'none' }} />
        <button onClick={() => cmd.trim() && onSetCommand(cmd.trim())}
          style={{ background: '#FF1F5A', color: '#09080C', border: 'none', borderRadius: 4,
            padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 15, fontWeight: 700 }}>
          Set & Run</button>
        <button onClick={onDismiss}
          style={{ background: '#18151D', color: '#A39AA8', border: '1px solid #2A2030',
            borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 15 }}>
          Later</button>
      </div>
    </div>
  );
  return (
    <div data-testid="verify-banner" style={{ display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', background: bg, borderTop: `2px solid ${passed ? '#1FAE7E' : failed ? '#ff6a6a' : '#FF5C84'}`,
      flexShrink: 0 }}>
      <div style={{ width: 10, height: 10, borderRadius: '50%',
        background: passed || running ? '#09080C' : '#fff', flexShrink: 0 }} />
      <span style={{ fontSize: 18, fontWeight: 800, color, flex: 1, lineHeight: 1.35,
        letterSpacing: '0.02em' }}>{label}</span>
      {(passed || failed) && (
        <button onClick={failed ? onRun : onDismiss}
          style={{ background: passed ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.35)',
            color, border: 'none', fontSize: 16, fontWeight: 700, cursor: 'pointer',
            padding: '4px 10px', borderRadius: 4 }}>
          {failed ? 'Retry check' : 'Dismiss'}</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export function App() {
  const termRef = useRef<TerminalHandle>(null);
  const chatRef = useRef<ChatHandle>(null);
  const repo    = useRepoContext();

  // Keep the sandbox alive purely from the tab being open — even backgrounded
  // (switched away from, not closed) — instead of only extending on actual
  // activity. Browsers throttle background-tab timers but still run them at
  // least every minute or so, well inside this interval's margin.
  useEffect(() => {
    if (!repo.sandboxId) return;
    const sid = repo.sandboxId;
    const ping = () => {
      fetch(`${API_URL}/keepalive`, { headers: { 'X-Sandbox-Session': sid } }).catch(() => {
        // Best-effort — a missed ping just means one less timeout extension.
      });
    };
    const id = setInterval(ping, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [repo.sandboxId]);
  /** Prevents Auto-apply from starting a second verify while one is running. */
  const verifyingRef = useRef(false);
  const roleModelsRef = useRef(loadRoleModels());
  type Boot = { session: StoredSession | null; fromChat: boolean };
  const bootRef = useRef<Boot | null>(null);
  const autoBriefRef = useRef(false);
  if (!bootRef.current) {
    const handoff = peekWorkspaceHandoff();
    if (handoff) {
      autoBriefRef.current = handoff.autoBrief === true;
      const id = handoff.chatId || `handoff-${handoff.createdAt || Date.now()}`;
      const title = handoff.title || 'From chat';
      // One conversation: the chat's LIVE messages (shared localStorage) win
      // over the handoff snapshot, which is stale or missing on a re-entry.
      const live = readChatConversation(id);
      const source = live?.messages?.length ? live.messages : (handoff.messages || []);
      const imported = source
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          id: Math.random().toString(36).slice(2, 10),
          role: m.role as 'user' | 'assistant',
          content: m.content,
          kind: 'imported',
        }));
      // This chat's own code space thread — never another chat's repo or sandbox.
      const prev = getSession(id);
      // The chat persona becomes the orchestrator and keeps thinking on the chat
      // model; the coder stays on a coding model instead of inheriting it.
      const orchestrated = !!handoff.personaId;
      if (orchestrated) {
        saveOrchestratorPrefs({
          personaId: handoff.personaId!,
          provider: handoff.provider || '',
          model: handoff.model || '',
        });
      }
      const coderProvider = orchestrated
        ? prev?.provider || roleModelsRef.current.write.provider
        : handoff.provider || prev?.provider || roleModelsRef.current.write.provider;
      const coderModel = orchestrated
        ? prev?.model || roleModelsRef.current.write.model
        : handoff.model || prev?.model || roleModelsRef.current.write.model;
      const session: StoredSession = {
        v: 2,
        id,
        title,
        savedAt: Date.now(),
        repoUrl: prev?.repoUrl ?? null,
        sandboxId: prev?.sandboxId ?? null,
        provider: coderProvider || 'openrouter',
        model: coderModel || 'openrouter/free',
        autoApplyOn: prev?.autoApplyOn ?? true,
        messages: mergeHandoffMessages(prev?.messages || [], imported),
        pendingChanges: prev?.pendingChanges || [],
        files: prev?.files,
        fromChat: true,
      };
      saveSession(session);
      setActiveSessionId(id);
      bootRef.current = { session, fromChat: true };
    } else {
      const session = loadSession();
      if (session) {
        setActiveSessionId(session.id);
        // Re-entered without a fresh handoff (back button, reload, a second
        // visit): fold in whatever was said in the chat since, so the
        // Code Space is never behind the conversation.
        const live = readChatConversation(session.id);
        if (live?.messages?.length) {
          const imported = live.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({
              id: Math.random().toString(36).slice(2, 10),
              role: m.role as 'user' | 'assistant',
              content: m.content,
              kind: 'imported' as const,
            }));
          session.messages = mergeHandoffMessages(session.messages || [], imported);
          saveSession(session);
        }
      }
      bootRef.current = { session, fromChat: false };
    }
  }
  const boot = bootRef.current;
  const restored = useRef(boot.session);

  const [role,         setRole]         = useState<RoleId>(() => {
    const r = boot.fromChat ? peekWorkspaceHandoff()?.role : undefined;
    return r === 'write' || r === 'review' || r === 'plan' ? r : 'write';
  });
  const [provider,     setProvider]     = useState(
    restored.current?.provider ?? roleModelsRef.current.write.provider ?? 'openrouter',
  );
  const [model,        setModel]        = useState(
    restored.current?.model ?? roleModelsRef.current.write.model ?? 'openrouter/free',
  );
  const [models,       setModels]       = useState<CatalogModel[]>(
    () => FALLBACK_MODELS[provider] || FALLBACK_MODELS.venice,
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  // The Code Space writes code, so it opens on the Coders package rather than a
  // raw provider catalog. 'provider' is the escape hatch to the full list.
  const [modelScope,   setModelScope]   = useState<'coders' | 'provider'>(
    () => (localStorage.getItem(MODEL_SCOPE_KEY) === 'provider' ? 'provider' : 'coders'),
  );
  const [coderBrands,  setCoderBrands]  = useState<ResolvedCoderBrand[]>([]);
  const [keys,         setKeys]         = useState(() => loadProviderKeys());
  const [showSettings, setShowSettings] = useState(false);
  const [showCompare,  setShowCompare]  = useState(false);
  const [roleModels,   setRoleModels]   = useState(() => loadRoleModels());
  // Auto-save ON — generated files go to the sandbox immediately so you can download/push.
  const [autoRun,      setAutoRun]      = useState(false);
  const [autoApplyOn,  setAutoApplyOn]  = useState(restored.current?.autoApplyOn ?? true);
  const [autoVerifyOn, setAutoVerifyOn] = useState(true);
  const [applying,     setApplying]     = useState(false);
  const [appliedPaths, setAppliedPaths] = useState<Set<string>>(new Set());
  // Read after boot so a handoff's persona (saved above) wins.
  const [orchPrefs, setOrchPrefs] = useState<OrchestratorPrefs>(() => loadOrchestratorPrefs());
  const [savedTeams, setSavedTeams] = useState<SavedTeam[]>(() => loadSavedTeams());
  const [personaList, setPersonaList] = useState<Array<{ id: string; name: string }>>([]);
  const [applyResults, setApplyResults] = useState<Array<{ path: string; ok: boolean; error?: string }>>([]);
  const [autoCtxFiles, setAutoCtxFiles] = useState<string[]>([]);
  const [searchHits,   setSearchHits]   = useState<SearchHit[]>([]);
  const [mobileTab,    setMobileTab]    = useState<MobileTab>('chat');
  const [desktopRightTab, setDesktopRightTab] = useState<'terminal' | 'preview'>('terminal');
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [previewKick, setPreviewKick] = useState(0);
  const autoSwitchedToPreview = useRef(false);
  const handleDevServerPort = useCallback((port: number) => {
    setPreviewPort(port);
    if (!autoSwitchedToPreview.current) {
      autoSwitchedToPreview.current = true;
      setDesktopRightTab('preview');
      setMobileTab('preview');
    }
  }, []);
  const [pushing,      setPushing]      = useState(false);
  const [restoreNote,  setRestoreNote]  = useState<string | null>(null);
  // WIP backup to GitHub: a safety net so a VM reset never loses progress,
  // even while the app is broken. Off by default; needs a token (reused from
  // Push). Pushes to a throwaway branch, labelled ok/broken by the check.
  const [wipBackupOn, setWipBackupOn] = useState(() => {
    try { return localStorage.getItem('workspace_wip_backup_v1') === '1'; } catch { return false; }
  });
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const backupBusyRef = useRef(false);
  const backupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedFilesRef = useRef<PendingChange[]>([]);
  const [queueTick, setQueueTick] = useState(0);
  const [pushError,    setPushError]    = useState<string | null>(null);
  const [pushOk,       setPushOk]       = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(
    () => restored.current?.id || `home-${Date.now()}`,
  );
  const [sessionTitle, setSessionTitle] = useState(
    () => restored.current?.title || 'Home code space',
  );
  const [chatMessages, setChatMessages] = useState<Message[]>(() => {
    const m = restored.current?.messages;
    if (!m?.length) return [];
    return m.map(x => ({
      id: x.id,
      role: x.role,
      content: x.content,
      kind: x.kind as Message['kind'],
      speaker: x.speaker,
      to: x.to,
      pending: x.pending,
      wantCompare: x.wantCompare,
      builtBy: x.builtBy,
    }));
  });
  const [fromChat] = useState(() => boot.fromChat);
  const [showHome, setShowHome] = useState(false);
  const [homeList, setHomeList] = useState<StoredSession[]>(() => listSessions());
  const [sessionKey,   setSessionKey]   = useState(0);
  const isMobile = useIsMobile();
  const activeApiKey = (keys[provider] || '').trim();

  // Live model catalog (same /api/models as main chat — includes GLM Heretic).
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    fetchModels(provider, activeApiKey || undefined)
      .then(list => {
        if (cancelled) return;
        setModels(list);
        // Coders scope owns the bounce-off-a-locked-model logic below; leave
        // the selection alone here or the two effects fight over it.
        if (modelScope === 'coders') return;
        const unlocked = paidUnlocked();
        const current = list.find(m => m.id === model);
        const locked = current && current.free === false && !unlocked;
        if ((!current || locked) && list.length) {
          const freeCoder = list.find(m => m.free !== false && /coder/i.test(`${m.id} ${m.name}`));
          const freeAny = list.find(m => m.free !== false);
          if (freeCoder || freeAny) {
            setModel((freeCoder || freeAny)!.id);
          } else if (provider !== 'openrouter') {
            // No free models on this provider — bounce to OpenRouter free coder.
            setProvider('openrouter');
            setModel(DEFAULT_MODELS.openrouter || 'qwen/qwen3-coder:free');
          }
        }
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [provider, activeApiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Coders package spans three providers, so it needs its own multi-catalog
  // load rather than riding on the single-provider fetch above.
  useEffect(() => {
    if (modelScope !== 'coders') return;
    let cancelled = false;
    setModelsLoading(true);
    loadCoderModels(keys)
      .then(brands => {
        if (cancelled) return;
        setCoderBrands(brands);
        const all = flattenCoderModels(brands);
        const current = all.find(m => m.provider === provider && m.id === model);
        const locked = current && !current.free && !paidUnlocked();
        // Land on something runnable: keep the current pick if it is a coder
        // the user can actually use, else take the package's default.
        // A coding team owns the seats — never swap its builder for a package default.
        if ((!current || locked) && !teamPrefsRef.current.seats) {
          const pick = pickDefaultCoder(brands, paidUnlocked());
          if (pick) {
            setProvider(pick.provider);
            setModel(pick.id);
            setRoleModels(prev => {
              const next = { ...prev, [role]: { provider: pick.provider, model: pick.id } };
              saveRoleModels(next);
              return next;
            });
          }
        }
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [modelScope, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── A project for the build to land in ────────────────────────────────────
  // Coming from chat there is no project open, and the coder's files used to
  // stay stuck in the chat: no editor, no preview, no auto-test. Build now
  // opens a blank project (while the coder writes) and the files go into it.
  const restoringRef = useRef<Promise<{ kind: string }> | null>(null);
  const blankStartRef = useRef<Promise<string | null> | null>(null);
  const liveRepo = useRef({ root: repo.root, sandboxId: repo.sandboxId });
  liveRepo.current = { root: repo.root, sandboxId: repo.sandboxId };
  const ensureProject = useCallback(async (): Promise<string | null> => {
    if (restoringRef.current) {
      const out = await restoringRef.current.catch(() => ({ kind: 'failed' }));
      if (out.kind !== 'failed') return liveRepo.current.sandboxId || 'restored';
    }
    if (liveRepo.current.root && liveRepo.current.sandboxId) return liveRepo.current.sandboxId;
    if (!blankStartRef.current) {
      setRestoreNote('Opening a blank project for this build…');
      blankStartRef.current = repo.startBlankProject('untitled-project').then(sid => {
        setRestoreNote(sid ? null : "Couldn't open a project for the build — tap Start blank, then ask the coder to write it again.");
        if (!sid) blankStartRef.current = null;
        return sid;
      });
    }
    return blankStartRef.current;
  }, [repo]);

  // Bring a saved project back — blank projects too, which used to stay
  // disconnected after any reload even while their sandbox was still alive.
  const restoreSaved = useCallback(async (s: StoredSession) => {
    if (!s.repoUrl && !s.sandboxId && !(s.files && Object.keys(s.files).length)) return;
    setRestoreNote('Reopening your project…');
    const pending = repo.restoreProject({ sandboxId: s.sandboxId, repoUrl: s.repoUrl, files: s.files });
    restoringRef.current = pending;
    const out = await pending.finally(() => { if (restoringRef.current === pending) restoringRef.current = null; });
    if (out.kind === 'reconnected') setRestoreNote(null);
    else if (out.kind === 'rebuilt') {
      setRestoreNote(out.restored
        ? `Your sandbox had expired, so it was rebuilt and your ${out.restored} file${out.restored === 1 ? '' : 's'} put back.`
          + (out.failed.length ? ` Couldn't restore: ${out.failed.join(', ')}.` : '')
        : 'Your sandbox had expired, so it was rebuilt from the repo.');
    } else setRestoreNote(`Couldn't reopen the project: ${out.error}. Start a blank project or open the repo again.`);
  }, [repo]);

  // Restore the project + pending file drafts once on mount.
  useEffect(() => {
    const s = restored.current;
    if (!s) return;
    let cancelled = false;
    (async () => {
      await restoreSaved(s);
      if (!cancelled && s.pendingChanges?.length) {
        repo.setPendingChanges(s.pendingChanges);
      }
    })().catch(() => { /* reported through restoreNote */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist session whenever important state changes.
  useEffect(() => {
    saveSession({
      id: sessionId,
      title: sessionTitle,
      repoUrl: repo.repoUrl,
      sandboxId: repo.sandboxId,
      provider,
      model,
      autoApplyOn,
      fromChat,
      messages: chatMessages.map(m => ({
        id: m.id, role: m.role, content: m.content, kind: m.kind, speaker: m.speaker, to: m.to,
        pending: m.pending, wantCompare: m.wantCompare, builtBy: m.builtBy,
      })),
      pendingChanges: repo.pendingChanges,
      files: repo.snapshot,
    });
    setHomeList(listSessions());
  }, [
    sessionId, sessionTitle, fromChat,
    repo.repoUrl, repo.sandboxId, repo.pendingChanges, repo.snapshot,
    provider, model, autoApplyOn, chatMessages,
  ]);

  // ── One conversation, kept in step with the main chat ─────────────────────
  // The persona's replies and your messages here are written back into the
  // chat (shared localStorage), so "← Chat" shows the same discussion. Only
  // human-facing turns cross over — not the coder's output, briefs or notes.
  // Gate on the session being chat-linked (its id is a chat id), not on this
  // particular load arriving via a handoff — a back-button re-entry has no
  // handoff but is still the same conversation. mirrorToChat / readChat
  // no-op when no chat matches the id (a Workspace-only project).
  useEffect(() => {
    if (!sessionId) return;
    const crossOver = chatMessages
      .filter(m =>
        (m.role === 'user' && m.kind !== 'welcome' && m.kind !== 'retry-inject' && m.kind !== 'note')
        || (m.role === 'assistant' && m.speaker === 'persona'))
      .map(m => ({ role: m.role, content: m.content }));
    if (crossOver.length) mirrorToChat(sessionId, crossOver);
  }, [chatMessages, sessionId]);

  // Came back to this tab after talking in the chat: pull anything new in and
  // put it at the end, so the persona is never answering stale history.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      const live = readChatConversation(sessionId);
      if (!live?.messages?.length) return;
      // Through the chat pane's handle so the visible thread updates — it owns
      // its own message list and wouldn't see a plain state append here.
      chatRef.current?.syncExternal(live.messages);
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [sessionId]);

  const openStoredSession = useCallback((s: StoredSession) => {
    setActiveSessionId(s.id);
    setSessionId(s.id);
    setSessionTitle(s.title || 'Code Space');
    setProvider(s.provider || 'openrouter');
    setModel(s.model || 'openrouter/free');
    setAutoApplyOn(s.autoApplyOn ?? true);
    setChatMessages(repairOrchestratorTags(s.messages || []).map(x => ({
      id: x.id,
      role: x.role,
      content: x.content,
      kind: x.kind as Message['kind'],
      speaker: x.speaker,
      to: x.to,
      pending: x.pending,
      wantCompare: x.wantCompare,
      builtBy: x.builtBy,
    })));
    setPushError(null);
    setPushOk(null);
    setShowHome(false);
    setSessionKey(k => k + 1);
    // A session with no project must not inherit the previous one's tree/sandbox.
    if (!s.repoUrl && !s.sandboxId && !(s.files && Object.keys(s.files).length)) {
      restoringRef.current = null;
      blankStartRef.current = null;
      setRestoreNote(null);
      repo.resetProject();
    }
    void restoreSaved(s).then(() => {
      if (s.pendingChanges?.length) repo.setPendingChanges(s.pendingChanges);
      else repo.clearChanges();
    });
  }, [repo, restoreSaved]);

  const startFreshHome = useCallback(() => {
    const id = `home-${Date.now()}`;
    const session: StoredSession = {
      v: 2,
      id,
      title: 'Home code space',
      savedAt: Date.now(),
      repoUrl: null,
      sandboxId: null,
      provider,
      model,
      autoApplyOn,
      messages: [],
      pendingChanges: [],
      fromChat: false,
    };
    saveSession(session);
    openStoredSession(session);
  }, [provider, model, autoApplyOn, openStoredSession]);

  // Names/ids only — prompts stay on the server and are resolved per request.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/public-config`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { personas?: Array<{ id: string; name: string }> } | null) => {
        if (!cancelled && Array.isArray(d?.personas)) setPersonaList(d.personas);
      })
      .catch(() => { /* picker falls back to the saved id */ });
    return () => { cancelled = true; };
  }, []);

  // Retired models: the server answers on a replacement and says so — keep it.
  const handleModelReplaced = useCallback((swap: { from: string; to: string }, who: 'persona' | 'coder') => {
    if (who === 'persona') {
      setOrchPrefs(prev => {
        if (prev.model !== swap.from) return prev;
        const next = { ...prev, model: swap.to };
        saveOrchestratorPrefs(next);
        return next;
      });
    } else {
      setModel(m => (m === swap.from ? swap.to : m));
      setRoleModels(prev => {
        const next = { ...prev };
        for (const r of Object.keys(next) as RoleId[]) {
          if (next[r]?.model === swap.from) next[r] = { ...next[r], model: swap.to };
        }
        saveRoleModels(next);
        return next;
      });
      setSavedTeams(prev => {
        const next = renameModelInTeams(prev, swap.from, swap.to);
        if (!next) return prev;
        saveSavedTeams(next);
        return next;
      });
    }
  }, []);

  // On load: a persona model from an old handoff may have been retired since.
  useEffect(() => {
    const { provider: p, model: m } = orchPrefs;
    if (!p || !m) return;
    let cancelled = false;
    Promise.all([
      fetch(`${API_URL}/models?provider=${encodeURIComponent(p)}`).then(r => r.json()),
      fetch(`${API_URL}/models?op=defaults`).then(r => r.json()),
    ]).then(([cat, defs]: [{ models?: Array<{ id: string }>; source?: string }, { defaults?: Record<string, { chat?: string }> }]) => {
      if (cancelled || cat.source === 'fallback' || !cat.models?.length) return;
      if (cat.models.some(x => x.id === m)) return;
      const to = defs.defaults?.[p]?.chat;
      if (to) handleModelReplaced({ from: m, to }, 'persona');
    }).catch(() => { /* next request still self-heals server-side */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePersonaChange = (id: string) => {
    setOrchPrefs(prev => {
      const next = { ...prev, personaId: id };
      saveOrchestratorPrefs(next);
      return next;
    });
  };

  const orchPersona = orchPrefs.personaId
    ? {
        id: orchPrefs.personaId,
        name: personaList.find(p => p.id === orchPrefs.personaId)?.name || orchPrefs.personaId,
        provider: orchPrefs.provider || provider,
        model: orchPrefs.provider ? orchPrefs.model : model,
        apiKey: (keys[orchPrefs.provider || provider] || '').trim() || undefined,
      }
    : null;

  // Arrived from a chat that said it is ready to build: the orchestrator reads the conversation and
  // writes the brief itself, so the user does not have to say it all again.
  useEffect(() => {
    if (!autoBriefRef.current) return;
    const t = window.setTimeout(() => {
      if (!autoBriefRef.current) return;
      autoBriefRef.current = false;
      void chatRef.current?.programmaticSend("I'm ready to build this. Write the brief for the coder from our conversation.", 'user');
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Coding team: one agent per phase (codingTeam.ts) ───────────────────────
  const [teamPrefs, setTeamPrefs] = useState<TeamPrefs>(() => loadTeamPrefs());
  const teamPrefsRef = useRef(teamPrefs);
  teamPrefsRef.current = teamPrefs;
  const [teamCatalogs, setTeamCatalogs] = useState<Record<string, CatalogModel[]>>({});
  const [teamDefaults, setTeamDefaults] = useState<Record<string, { chat?: string; coder?: string }>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchModels('venice', (keys.venice || '').trim() || undefined),
      fetchModels('openrouter', (keys.openrouter || '').trim() || undefined),
      fetch(`${API_URL}/models?op=defaults`).then(r => r.json()).catch(() => ({})),
    ]).then(([venice, openrouter, d]) => {
      if (cancelled) return;
      setTeamCatalogs({ venice, openrouter });
      setTeamDefaults((d as { defaults?: Record<string, { chat?: string; coder?: string }> }).defaults || {});
    }).catch(() => { /* seats keep their saved models */ });
    return () => { cancelled = true; };
  }, [keys.venice, keys.openrouter]);

  const teamSeats: TeamSeats = {
    plan: roleModels.plan,
    build: roleModels.write,
    review: roleModels.review,
    fix: teamPrefs.seats?.fix ?? roleModels.write,
  };

  // Every team's models, labelled with team, seat and cost (⭐ free … ⭐⭐⭐⭐ Fable-class)
  // — the picker's first menu group — plus each team's own cost rating.
  const { teamOptions, teamStars } = useMemo(() => {
    const options: TeamOption[] = [];
    const ratings: Partial<Record<PresetId, number>> = {};
    if (!teamCatalogs.openrouter?.length) return { teamOptions: options, teamStars: ratings };
    const ctx = { catalogs: teamCatalogs, liveDefaults: teamDefaults, unlocked: true };
    const seen = new Map<string, TeamOption>();
    for (const id of Object.keys(PRESETS) as PresetId[]) {
      const seats = resolvePreset(id, ctx);
      for (const seat of SEATS) {
        const sm = seats[seat.id];
        const k = `${sm.provider}::${sm.model}`;
        const meta = (teamCatalogs[sm.provider] || []).find(m => m.id === sm.model);
        const n = costStars(sm.provider, meta);
        ratings[id] = Math.max(ratings[id] ?? 0, n);
        const tag = `${PRESETS[id].label} ${seat.label}`;
        const prev = seen.get(k);
        seen.set(k, { ...sm, label: prev ? prev.label.replace(' · ', `, ${tag} · `) : `${meta?.name || sm.model} — ${tag} · ${stars(n)}` });
      }
    }
    options.push(...seen.values());
    return { teamOptions: options, teamStars: ratings };
  }, [teamCatalogs, teamDefaults]);

  const applySeats = useCallback((seats: TeamSeats, preset: PresetId | 'custom', savedId: string | null = null) => {
    const roles = rolesFromSeats(seats);
    setRoleModels(roles);
    saveRoleModels(roles);
    const cur = roles[role];
    if (cur) { setProvider(cur.provider); setModel(cur.model); }
    setTeamPrefs(prev => {
      const next = { ...prev, preset, seats, savedId };
      saveTeamPrefs(next);
      return next;
    });
  }, [role]);

  // ── Your named teams: fixed seats, kept here and on the server ────────────
  const pickSavedTeam = useCallback((id: string) => {
    const team = savedTeams.find(t => t.id === id);
    if (team) applySeats(team.seats, 'custom', team.id);
  }, [savedTeams, applySeats]);

  const saveTeamAs = useCallback((name: string, seats: TeamSeats) => {
    const { list, team } = upsertSavedTeam(savedTeams, name, seats);
    setSavedTeams(list);
    saveSavedTeams(list);
    applySeats(team.seats, 'custom', team.id);
  }, [savedTeams, applySeats]);

  const deleteSavedTeam = useCallback((id: string) => {
    const list = savedTeams.filter(t => t.id !== id);
    setSavedTeams(list);
    saveSavedTeams(list);
    if (teamPrefsRef.current.savedId === id) {
      setTeamPrefs(prev => {
        const next = { ...prev, savedId: null };
        saveTeamPrefs(next);
        return next;
      });
    }
  }, [savedTeams]);

  const savedTeamMenu = useMemo(
    () => savedTeams.map(t => ({ id: t.id, name: t.name, stars: seatsStars(t.seats, teamCatalogs) })),
    [savedTeams, teamCatalogs],
  );

  const applyPreset = useCallback((id: PresetId) => {
    applySeats(resolvePreset(id, { catalogs: teamCatalogs, liveDefaults: teamDefaults, unlocked: paidUnlocked() }), id);
  }, [applySeats, teamCatalogs, teamDefaults]);

  // Once the catalogs are in: a preset team is re-resolved (a retired model
  // just moves its seat on); the first run starts on the Uncensored team.
  const teamResolved = useRef(false);
  useEffect(() => {
    if (teamResolved.current || !teamCatalogs.venice?.length || !teamCatalogs.openrouter?.length) return;
    teamResolved.current = true;
    if (teamPrefs.preset !== 'custom') applyPreset(teamPrefs.preset);
  }, [teamCatalogs, teamPrefs.preset, applyPreset]);

  /** Changing a model by hand makes the team yours. */
  const markTeamCustom = useCallback(() => {
    setTeamPrefs(prev => {
      if ((prev.preset === 'custom' && !prev.savedId) || !prev.seats) return prev;
      const next = { ...prev, preset: 'custom' as const, savedId: null };
      saveTeamPrefs(next);
      return next;
    });
  }, []);

  const withKey = useCallback((sm: SeatModel): SeatPick => ({
    ...sm, apiKey: (keys[sm.provider] || '').trim() || undefined,
  }), [keys]);

  const renderBuildPicker = useCallback((args: {
    brief: string; wantCompare: boolean; onBuild: (req: BuildRequest) => void;
  }) => (
    <BuildPicker
      key={`${teamPrefs.preset}:${teamPrefs.savedId || ''}:${teamSeats.build.model}:${teamSeats.fix.model}`}
      seats={teamSeats}
      teamOptions={teamOptions}
      teamStars={teamStars}
      lockedNote={paidUnlocked() || teamPrefs.preset === 'free' ? undefined
        : teamPrefs.preset !== 'custom'
          ? `🔒 Paid models aren't unlocked on this device, so the ${PRESETS[teamPrefs.preset].label} team is using free stand-ins. Tap Unlock at the top to use the real team.`
          : lockedSeats(teamSeats, teamCatalogs).length
            ? `🔒 ${lockedSeats(teamSeats, teamCatalogs).map(id => SEATS.find(x => x.id === id)!.label).join(', ')} ${lockedSeats(teamSeats, teamCatalogs).length > 1 ? 'use paid models' : 'uses a paid model'} — tap Unlock at the top first.`
            : undefined}
      preset={teamPrefs.preset}
      catalogs={teamCatalogs}
      unlocked={paidUnlocked()}
      wantCompare={args.wantCompare}
      savedTeams={savedTeamMenu}
      savedId={teamPrefs.savedId}
      onSavedTeam={pickSavedTeam}
      onSaveTeam={saveTeamAs}
      onPreset={applyPreset}
      onBuild={(c: BuildChoiceSeats) => {
        // What you pick becomes the team's Build and Fix seats from here on.
        const same = (x: SeatModel, y: SeatModel) => x.provider === y.provider && x.model === y.model;
        if (!same(c.builder, teamSeats.build) || !same(c.fixer, teamSeats.fix)) {
          applySeats({ ...teamSeats, build: c.builder, fix: c.fixer }, 'custom');
        }
        // The sandbox starts while the coder writes, so the files have somewhere to go.
        if (!c.second) void ensureProject();
        args.onBuild({ builder: withKey(c.builder), second: c.second ? withKey(c.second) : null });
      }}
    />
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [teamPrefs.preset, teamPrefs.savedId, savedTeamMenu, pickSavedTeam, saveTeamAs, ensureProject, teamSeats.build.model, teamSeats.build.provider, teamSeats.fix.model, teamSeats.fix.provider,
    teamSeats.plan.model, teamSeats.review.model, teamCatalogs, teamOptions, teamStars, applyPreset, applySeats, withKey]);

  const setAskFirst = useCallback((askFirst: boolean) => {
    setTeamPrefs(prev => {
      const next = { ...prev, askFirst };
      saveTeamPrefs(next);
      return next;
    });
  }, []);

  const handleProviderChange = (p: string) => {
    markTeamCustom();
    setProvider(p);
    const fallback = DEFAULT_MODELS[p] || FALLBACK_MODELS[p]?.[0]?.id || '';
    setModel(fallback);
    setRoleModels(prev => {
      const next = { ...prev, [role]: { provider: p, model: fallback } };
      saveRoleModels(next);
      return next;
    });
  };

  const handleModelChange = (m: string) => {
    markTeamCustom();
    setModel(m);
    setRoleModels(prev => {
      const next = { ...prev, [role]: { provider, model: m } };
      saveRoleModels(next);
      return next;
    });
  };

  /** Coders scope: one option can move the provider too, since the package spans them. */
  const handleCoderChange = (key: string) => {
    const { provider: p, id } = parseCoderKey(key);
    if (!p || !id) return;
    markTeamCustom();
    setProvider(p);
    setModel(id);
    setRoleModels(prev => {
      const next = { ...prev, [role]: { provider: p, model: id } };
      saveRoleModels(next);
      return next;
    });
  };

  const handleScopeChange = (scope: 'coders' | 'provider') => {
    setModelScope(scope);
    try { localStorage.setItem(MODEL_SCOPE_KEY, scope); } catch { /* ignore */ }
  };

  const handleRoleChange = (r: RoleId) => {
    setRole(r);
    const assigned = roleModels[r];
    if (assigned) {
      setProvider(assigned.provider);
      setModel(assigned.model);
    }
  };

  const handleKeySave = (providerId: string, value: string) => {
    const next = { ...keys, [providerId]: value };
    setKeys(next);
    saveProviderKeys(next);
  };

  const handleApply = useCallback(async (files?: PendingChange[]) => {
    setApplying(true);
    try {
      const results = await repo.applyChanges(files);
      setApplyResults(results);
      setAppliedPaths(new Set(results.filter(r => r.ok).map(r => r.path)));
      if (results.some(r => r.ok) && repo.sandboxId) {
        // First successful write: start Preview (auto-detects html vs npm)
        // and switch the right pane so you see the app, not the terminal.
        setPreviewKick(k => k + 1);
        if (!autoSwitchedToPreview.current) {
          autoSwitchedToPreview.current = true;
          setDesktopRightTab('preview');
          setMobileTab('preview');
        }
      }
      return results;
    } finally { setApplying(false); }
  }, [repo]);

  // ── Compare: the persona's brief to two coders, and the chosen version back ──
  const compareRef = useRef<CompareHandle>(null);
  const queuedCompareRef = useRef<{ brief: string; picks?: { a: SeatModel; b: SeatModel } } | null>(null);
  const handleCompareBrief = useCallback((brief: string, picks?: { a: SeatModel; b: SeatModel }) => {
    setShowCompare(true);
    if (repo.sandboxId) { compareRef.current?.runBrief(brief, picks); return; }
    // Compare's two previews need a sandbox: open one, then run.
    queuedCompareRef.current = { brief, picks };
    void ensureProject().then(sid => { if (!sid) queuedCompareRef.current = null; });
  }, [repo.sandboxId, ensureProject]);
  useEffect(() => {
    if (!repo.sandboxId || !queuedCompareRef.current) return;
    const q = queuedCompareRef.current;
    queuedCompareRef.current = null;
    compareRef.current?.runBrief(q.brief, q.picks);
  }, [repo.sandboxId]);


  const autoVerify = useAutoVerify(repo.root, repo.sandboxId, termRef, chatRef, repo.applyChanges);

  const runVerify = useCallback(async () => {
    if (verifyingRef.current) return autoVerify.verifyState === 'passed' ? 'passed' as const : 'idle' as const;
    verifyingRef.current = true;
    // Stay on Chat — don't yank the user to Terminal.
    try { return await autoVerify.verify(); }
    finally { verifyingRef.current = false; }
  }, [autoVerify]);

  // The orchestrator opens the Push request: the form shows once the check has passed (it runs it if not).
  const [openPushSignal, setOpenPushSignal] = useState(0);
  const handleOpenPush = useCallback(() => {
    if (autoVerify.pushAllowed) { setOpenPushSignal(n => n + 1); return; }
    void runVerify().then(outcome => { if (outcome === 'passed') setOpenPushSignal(n => n + 1); });
  }, [autoVerify.pushAllowed, runVerify]);

  const handleApplyAndVerify = useCallback(async (files?: PendingChange[]) => {
    const results = await handleApply(files);
    const written = results.filter(r => r.ok).map(r => r.path);
    if (written.length && autoVerifyOn && (repo.root || repo.sandboxId) && !verifyingRef.current) {
      const outcome = await runVerify();
      // The persona reads notes: it reports the real test result instead of
      // "presumed done".
      const failed = results.filter(r => !r.ok).map(r => r.path);
      const files = `${written.join(', ')}${failed.length ? `; couldn't write ${failed.join(', ')}` : ''}`;
      if (outcome === 'passed') chatRef.current?.addNote(`Auto-test passed (wrote ${files}).`);
      else if (outcome === 'failed') chatRef.current?.addNote(`Auto-test still failing after the fix attempts (wrote ${files}). The last output is in the Terminal.`);
    }
    return results;
  }, [handleApply, autoVerifyOn, repo.root, repo.sandboxId, runVerify]);

  const handleUseBuild = useCallback(async (build: BuildChoice) => {
    if (!repo.sandboxId) {
      setRestoreNote('Open a blank project or a GitHub repo first, then use the build again.');
      return;
    }
    // Same path as a normal build: write, then auto-test, so Push can unlock and the
    // persona hears the real result for the version you picked.
    const results = await handleApplyAndVerify(Object.entries(build.files).map(([path, content]) => ({ path, content })));
    const ok = results.filter(r => r.ok).map(r => r.path);
    const failed = results.filter(r => !r.ok).map(r => r.path);
    setShowCompare(false);
    setMobileTab('chat');
    chatRef.current?.addNote(
      `Took "${build.title}" (${build.model}) from Compare into the project — ${ok.length} file${ok.length === 1 ? '' : 's'}: ${ok.join(', ')}.`
      + (failed.length ? ` Couldn't write: ${failed.join(', ')}.` : '')
      + ' Keep building on this version.',
    );
  }, [repo.sandboxId, handleApplyAndVerify]);

  // ── WIP backup to GitHub ──────────────────────────────────────────────────
  const runWipBackup = useCallback(async (reason?: string) => {
    if (!repo.sandboxId || backupBusyRef.current) return;
    let token = '';
    try { token = (localStorage.getItem('gh_push_token') || '').trim(); } catch { /* ignore */ }
    if (!token) { setBackupNote('Backups need a GitHub token once — open Push and paste one, then turn this on.'); return; }
    backupBusyRef.current = true;
    setBackupNote('Backing up to GitHub…');
    try {
      const res = await fetch(`${API_URL}/git-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sandbox-Session': repo.sandboxId },
        body: JSON.stringify({ wip: true, token, message: reason || sessionTitle || 'Code Space progress', repoName: sessionTitle }),
      });
      const data = await res.json().catch(() => ({})) as { pushed?: boolean; branch?: string; checkPassed?: boolean; createdRepoUrl?: string; error?: string };
      if (!res.ok) { setBackupNote(`Backup failed: ${data.error || `HTTP ${res.status}`}`); return; }
      if (!data.pushed) { setBackupNote('Up to date — nothing new to back up.'); return; }
      const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      setBackupNote(
        `Backed up to “${data.branch}”${data.checkPassed === false ? ' (flagged broken/incomplete)' : ' (tests passed)'} at ${at}.`
        + (data.createdRepoUrl ? ` Repo: ${data.createdRepoUrl}` : ''),
      );
    } catch (e) {
      setBackupNote(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      backupBusyRef.current = false;
    }
  }, [repo.sandboxId, sessionTitle]);

  const scheduleBackup = useCallback(() => {
    if (!wipBackupOn || !repo.sandboxId) return;
    if (backupTimerRef.current) clearTimeout(backupTimerRef.current);
    backupTimerRef.current = setTimeout(() => { void runWipBackup(); }, 4000);
  }, [wipBackupOn, repo.sandboxId, runWipBackup]);

  const toggleWipBackup = useCallback((on: boolean) => {
    setWipBackupOn(on);
    try { localStorage.setItem('workspace_wip_backup_v1', on ? '1' : '0'); } catch { /* ignore */ }
    if (on) void runWipBackup('Enabled backup');
    else setBackupNote(null);
  }, [runWipBackup]);

  // After files are written (snapshot changes), debounce a backup.
  useEffect(() => {
    if (!wipBackupOn || !repo.sandboxId) return;
    scheduleBackup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.snapshot]);

  // And a periodic safety net while a project is open.
  useEffect(() => {
    if (!wipBackupOn || !repo.sandboxId) return;
    const id = setInterval(() => { void runWipBackup(); }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [wipBackupOn, repo.sandboxId, runWipBackup]);

  const handleAutoContext = useCallback(async (query: string): Promise<{
    hits: SearchHit[];
    files: Map<string, string>;
  }> => {
    // Whole repo stays open in the sandbox. Each chat turn only pulls what it
    // needs — same idea as Cursor/Claude. Simple "hey" must NOT load files.
    const empty = { hits: [] as SearchHit[], files: new Map<string, string>() };
    if (!repo.root) {
      setAutoCtxFiles([]);
      setSearchHits([]);
      return empty;
    }
    if (!needsCodeContext(query)) {
      setAutoCtxFiles([]);
      setSearchHits([]);
      return empty;
    }

    const audit = looksLikeSuggestRequest(query);
    const maxHits = audit ? 12 : 8;
    const maxFull = audit ? MAX_AUDIT_FULL_FILES : MAX_AUTO_FULL_FILES;
    try {
      let hits = await fetchAutoContext(repo.root, query, repo.sandboxId, maxHits);

      // Non-coders won't name files. If search is thin, pick likely source files
      // from the tree so the agent still has something real to read/fix.
      if (hits.length < 3 && repo.tree.length > 0) {
        const seeds = pickAuditSeedPaths(flattenTreePaths(repo.tree), maxFull);
        const have = new Set(hits.map(h => h.path));
        for (const path of seeds) {
          if (have.has(path)) continue;
          hits.push({ path, score: 0, reason: 'auto-picked', snippets: [] });
          have.add(path);
        }
      }

      setSearchHits(hits);

      const toOpen = hits
        .filter(h => isSourcePath(h.path))
        .filter(h => {
          // Unknown size (seed) — try load. Very huge files still load truncated.
          if (h.size == null || h.size <= 0) return true;
          return h.size <= MAX_AUTO_FULL_FILE_CHARS * 3;
        })
        .slice(0, maxFull);

      const opened = new Map<string, string>();
      for (const h of toOpen) {
        if (repo.contextFiles.has(h.path)) continue;
        const content = await fetchFileContent(
          repo.root, h.path, repo.sandboxId, MAX_AUTO_FULL_FILE_CHARS,
        );
        if (content != null) opened.set(h.path, content);
      }

      setAutoCtxFiles([
        ...hits.map(h => h.path),
        ...[...opened.keys()].filter(p => !hits.some(h => h.path === p)),
      ]);
      return { hits, files: opened };
    } catch {
      setAutoCtxFiles([]);
      setSearchHits([]);
      return empty;
    }
  }, [repo.root, repo.sandboxId, repo.tree, repo.contextFiles]);

  const handleFileChanges = useCallback(async (changes: PendingChange[]) => {
    if (autoApplyOn && (!repo.root || !repo.sandboxId)) {
      // No project open (you came from chat): hold the files until the one
      // Build started is ready, then write and test them as usual.
      const sid = await ensureProject();
      if (sid) {
        queuedFilesRef.current.push(...changes);
        setQueueTick(t => t + 1);
        return;
      }
    }
    // Group by path — multiple Edit: blocks against the same file must apply
    // in order, each against the previous one's result, not all independently
    // against the same starting content.
    const byPath = new Map<string, PendingChange[]>();
    for (const c of changes) {
      const arr = byPath.get(c.path) ?? [];
      arr.push(c);
      byPath.set(c.path, arr);
    }

    const fetchOriginal = async (path: string): Promise<string | undefined> => {
      if (!repo.root) return undefined;
      try {
        const headers: Record<string, string> = {};
        if (repo.sandboxId) headers['X-Sandbox-Session'] = repo.sandboxId;
        const url = repo.sandboxId
          ? `${API_URL}/file?path=${encodeURIComponent(path)}`
          : `${API_URL}/file?root=${encodeURIComponent(repo.root)}&path=${encodeURIComponent(path)}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return undefined;
        const data = await res.json() as { content?: string };
        return data.content;
      } catch { return undefined; }
    };

    const resolved: PendingChange[] = [];
    for (const [path, group] of byPath) {
      const original = await fetchOriginal(path);

      // A full File: block (no .edit) always wins for this path — it's an
      // explicit full rewrite, so any Edit: blocks for the same path in this
      // batch are superseded rather than composed with it.
      const fullFile = [...group].reverse().find(c => !c.edit);
      if (fullFile) {
        resolved.push({ ...fullFile, original });
        continue;
      }

      // Sequentially apply every Edit: block for this path, each against the
      // previous result, so multiple edits to the same file compose correctly.
      let running = original;
      let applyError: string | undefined;
      for (const c of group) {
        if (!c.edit) continue;
        const result = applyFileEdit(running, c.edit);
        if ('error' in result) { applyError = result.error; break; }
        running = result.content;
      }
      resolved.push(
        applyError
          ? { path, content: original ?? '', original, applyError }
          : { path, content: running ?? '', original },
      );
    }

    repo.setPendingChanges(resolved);
    setAppliedPaths(new Set());
    setApplyResults([]);
    // Don't reset verify state mid-loop — the retry injector owns that lifecycle.
    if (!verifyingRef.current) autoVerify.reset();

    // Default path: write immediately. During an active verify loop we only
    // write (the loop applies explicitly too) — never nest another verify().
    if (autoApplyOn && repo.root && resolved.length > 0) {
      if (verifyingRef.current) {
        await handleApply(resolved);
      } else {
        await handleApplyAndVerify(resolved);
      }
    }
  }, [repo, autoVerify, autoApplyOn, handleApply, handleApplyAndVerify, ensureProject]);

  useEffect(() => {
    if (!repo.root || !repo.sandboxId) return;
    blankStartRef.current = null;
    if (!queuedFilesRef.current.length) return;
    const queued = queuedFilesRef.current;
    queuedFilesRef.current = [];
    void handleFileChanges(queued);
  }, [repo.root, repo.sandboxId, queueTick, handleFileChanges]);

  const handleRunCode = useCallback((code: string, lang: string) => {
    // Run in the background terminal without stealing the Chat tab.
    // User can open Terminal when they want to see output.
    termRef.current?.runCode(code, lang);
  }, []);

  /** Multi-slice Generate → parse File: blocks and feed the apply pipeline. */
  const handleSliceGenerateComplete = useCallback((
    results: GenerateChunkResult[],
    combined: string,
  ) => {
    const summary = results
      .map((r) => {
        const badge = r.badge || r.model || '?';
        return r.ok
          ? `✓ ${r.label} · ${badge}${r.usedFallback ? ' (fallback)' : ''}`
          : `✗ ${r.label} · ${r.error || 'failed'}`;
      })
      .join('\n');

    const report = extractFileChangeReport(combined);
    // Last write wins when slices emit the same path.
    const byPath = new Map<string, string>();
    const dupes: string[] = [];
    for (const c of report.accepted) {
      if (byPath.has(c.path)) dupes.push(c.path);
      byPath.set(c.path, c.content);
    }
    const changes = [...byPath.entries()].map(([path, content]) => ({ path, content }));

    const applyNotes: string[] = [];
    if (!repo.root || !repo.sandboxId) {
      applyNotes.push('⚠ No sandbox open — File: blocks were not saved. Start blank / Open repo, then re-run Generate.');
    } else if (!changes.length && !report.rejected.length) {
      applyNotes.push('⚠ No File: blocks found — nothing written to the sandbox.');
    } else if (changes.length) {
      applyNotes.push(`→ Applying ${changes.length} file${changes.length === 1 ? '' : 's'} to sandbox…`);
    }
    if (dupes.length) {
      const uniq = [...new Set(dupes)];
      applyNotes.push(`⚠ Duplicate path${uniq.length === 1 ? '' : 's'} (last slice wins): ${uniq.join(', ')}`);
    }
    const rejectWarn = formatRejectedSandboxWarning(report.rejected);

    const body = [
      '## Slice generate',
      summary,
      applyNotes.length ? `\n${applyNotes.join('\n')}` : '',
      rejectWarn ? `\n${rejectWarn}` : '',
      combined ? `\n${combined}` : '',
    ].filter(Boolean).join('\n');

    setChatMessages((prev) => [
      ...prev,
      {
        id: `gen-${Date.now()}`,
        role: 'assistant' as const,
        content: body,
      },
    ]);

    if (changes.length && repo.root && repo.sandboxId) {
      void handleFileChanges(changes);
    }
    setMobileTab('chat');
  }, [handleFileChanges, repo.root, repo.sandboxId]);

  const handlePush = useCallback(async (token: string, message: string) => {
    if (!repo.sandboxId) {
      setPushError('Start a blank project or open a GitHub URL first.');
      return;
    }
    setPushing(true);
    setPushError(null);
    setPushOk(null);
    try {
      // Ensure pending drafts are written to the sandbox before commit.
      const paths = repo.pendingChanges.map(c => c.path);
      if (repo.pendingChanges.length > 0) {
        await handleApply(repo.pendingChanges);
      }

      // Client gate: never offer a push the sandbox hasn't proven.
      // (Server still re-runs checks — belt and suspenders.)
      if (autoVerifyOn) {
        const result = autoVerify.verifyState === 'passed'
          ? 'passed'
          : await runVerify();
        if (result !== 'passed') {
          throw new Error(
            'Push blocked — sandbox tests/smoke did not pass.\n' +
            'Keep Auto-test on and let the agent fix until you see “Verified — Push unlocked”.\n' +
            (autoVerify.lastFailDetail ? `\nLast failure:\n${autoVerify.lastFailDetail}` : ''),
          );
        }
      }

      const res = await fetch(`${API_URL}/git-push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sandbox-Session': repo.sandboxId,
        },
        body: JSON.stringify({
          token,
          message,
          // Empty => git add -A (covers already-saved sandbox edits too)
          files: paths.length ? paths : undefined,
        }),
      });
      const data = await res.json() as {
        ok?: boolean; pushed?: boolean; branch?: string;
        message?: string; error?: string; detail?: string; checkFailed?: boolean;
        createdRepoUrl?: string | null; pullRequestUrl?: string | null;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (data.pushed) {
        const bits = [
          `Pushed to GitHub${data.branch ? ` (${data.branch})` : ''} after checks passed.`,
        ];
        if (data.createdRepoUrl) bits.push(`New private repo: ${data.createdRepoUrl}`);
        if (data.pullRequestUrl) bits.push(`PR: ${data.pullRequestUrl}`);
        setPushOk(bits.join(' '));
        chatRef.current?.addNote(bits.join(' '));
      } else {
        setPushOk(data.message ?? 'Nothing new to push.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setPushError(msg);
      // The Push bar sits under the verify banner and is easy to miss: say it in the chat too.
      chatRef.current?.addNote(`Push to GitHub failed: ${msg.slice(0, 700)}`);
    } finally {
      setPushing(false);
    }
  }, [repo.sandboxId, repo.pendingChanges, handleApply, autoVerifyOn, autoVerify.verifyState, autoVerify.lastFailDetail, runVerify]);

  // ── Shared topbar ────────────────────────────────────────────────────────
  const topbar = (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0,
      borderBottom: '1px solid #18151D', background: '#09080C' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '6px 12px' }}>
        <a href="/" style={{ color: '#FF1F5A', fontSize: 16, textDecoration: 'none',
          whiteSpace: 'nowrap', padding: '2px 0', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <img src="/logo-mark.png" alt="Jive" style={{ height: 30, width: 'auto', filter: 'drop-shadow(0 0 6px rgba(255,31,90,.5))' }} />
          ← Chat
        </a>
        <button type="button" onClick={() => { setHomeList(listSessions()); setShowHome(true); }}
          title="Browse saved code space conversations"
          style={{ background: showHome ? 'rgba(212,255,63,0.16)' : 'transparent',
            color: '#FF1F5A', border: '1px solid #C8123F', borderRadius: 4,
            padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14,
            fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Home
        </button>
        <span style={{ color: '#FF1F5A', fontSize: 15, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}
          title={sessionTitle}>
          {sessionTitle}
        </span>
        {fromChat && (
          <span style={{ fontSize: 14, color: '#C8123F', whiteSpace: 'nowrap' }}>
            from chat
          </span>
        )}
        <button type="button" onClick={startFreshHome}
          style={{ background: 'transparent', color: '#A39AA8', border: '1px solid #2A2030',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 14 }}>
          New
        </button>
        <button type="button" data-testid="wip-backup-toggle"
          onClick={() => toggleWipBackup(!wipBackupOn)}
          title={wipBackupOn
            ? 'Auto-backup to GitHub is ON — saves your progress to a branch (flagged broken when tests fail) after each change and every few minutes. Tap to turn off.'
            : 'Auto-backup to GitHub: keep your progress safe from a VM reset even while the app is broken. Needs a GitHub token (paste once in Push). Tap to turn on.'}
          style={{ background: wipBackupOn ? 'rgba(96,165,250,.16)' : 'transparent',
            color: wipBackupOn ? '#8CC2FF' : '#A39AA8', border: `1px solid ${wipBackupOn ? '#2B6CB0' : '#2A2030'}`,
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, whiteSpace: 'nowrap' }}>
          {wipBackupOn ? '⟲ Backup on' : '⟲ Backup'}
        </button>
        {wipBackupOn && repo.sandboxId && (
          <button type="button" data-testid="wip-backup-now" onClick={() => { void runWipBackup('Manual backup'); }}
            title="Back up right now"
            style={{ background: 'transparent', color: '#8CC2FF', border: '1px solid #2B6CB0',
              borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>
            Now
          </button>
        )}
        {(repo.repoUrl || chatMessages.length > 0) && (
          <button type="button"
            onClick={() => {
              if (!confirm('Delete this code space conversation on this device?')) return;
              clearSession(sessionId);
              const next = listSessions()[0];
              if (next) openStoredSession(next);
              else startFreshHome();
            }}
            style={{ background: 'transparent', color: '#756B7B', border: '1px solid #2A2030',
              borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 14 }}>
            Delete
          </button>
        )}
        <select value={orchPrefs.personaId} onChange={e => handlePersonaChange(e.target.value)}
          data-testid="persona-select"
          title={orchPersona
            ? `You talk to ${orchPersona.name} (on ${orchPersona.model}); it briefs the coder below`
            : 'Off — your messages go straight to the coder'}
          style={{ background: orchPersona ? 'rgba(255,31,90,.12)' : '#100E14', color: '#F2ECEF',
            border: `1px solid ${orchPersona ? '#C8123F' : '#2A2030'}`,
            borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 15, cursor: 'pointer' }}>
          {(personaList.length ? personaList : orchPrefs.personaId
            ? [{ id: orchPrefs.personaId, name: orchPrefs.personaId }] : []
          ).map(p => <option key={p.id} value={p.id}>🎭 {p.name}</option>)}
          <option value="">No persona — coder direct</option>
        </select>
        <select value={role} onChange={e => handleRoleChange(e.target.value as RoleId)}
          title="Role — uses the model you assigned for write / review / plan"
          style={{ background: '#100E14', color: '#F2ECEF', border: '1px solid #2A2030',
            borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 15, cursor: 'pointer' }}>
          {ROLE_LIST.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <select value={modelScope} onChange={e => handleScopeChange(e.target.value as 'coders' | 'provider')}
          title="Coders shows the coding models across every provider; All models shows one provider's full catalog"
          style={{ background: '#100E14', color: '#F2ECEF', border: '1px solid #2A2030',
            borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 15, cursor: 'pointer' }}>
          <option value="coders">Coders</option>
          <option value="provider">All models</option>
        </select>
        {modelScope === 'provider' && (
          <select value={provider} onChange={e => handleProviderChange(e.target.value)}
            style={{ background: '#100E14', color: '#F2ECEF', border: '1px solid #2A2030',
              borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 15, cursor: 'pointer' }}>
            {PROVIDER_LIST.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        )}
        {modelScope === 'coders' ? (
          <select value={coderKey(provider, model)} onChange={e => handleCoderChange(e.target.value)}
            disabled={modelsLoading}
            title="Coding models — free ones run without a password, paid ones need the unlock"
            style={{ background: '#100E14', color: '#F2ECEF', border: '1px solid #2A2030',
              borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 15,
              cursor: 'pointer', maxWidth: 260, flex: 1, minWidth: 0 }}>
            {coderBrands.map(brand => (
              <optgroup key={brand.id} label={brand.paidOnly ? `${brand.label} · unlock to use` : brand.label}>
                {brand.models.map(m => {
                  const locked = !m.free && !paidUnlocked();
                  return (
                    <option key={coderKey(m.provider, m.id)} value={coderKey(m.provider, m.id)} disabled={locked}>
                      {m.name}{m.free ? ` · free ${m.limit}` : ' · paid'}{locked ? ' 🔒' : ''}
                    </option>
                  );
                })}
              </optgroup>
            ))}
            {/* A handoff from chat can arrive on a non-coder model; keep it
                selectable so the dropdown never shows a blank value. */}
            {!flattenCoderModels(coderBrands).some(m => m.provider === provider && m.id === model) && (
              <optgroup label="From chat">
                <option value={coderKey(provider, model)}>{model}</option>
              </optgroup>
            )}
          </select>
        ) : (
          <select value={model} onChange={e => handleModelChange(e.target.value)}
            disabled={modelsLoading}
            style={{ background: '#100E14', color: '#F2ECEF', border: '1px solid #2A2030',
              borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 15,
              cursor: 'pointer', maxWidth: 220, flex: 1, minWidth: 0 }}>
            {models.map(m => {
              const locked = m.free === false && !paidUnlocked();
              return (
                <option key={m.id} value={m.id} disabled={locked}>
                  {m.name}{m.free ? ' · free' : ' · paid'}{locked ? ' 🔒' : ''}
                </option>
              );
            })}
          </select>
        )}
        <button type="button"
          onClick={() => {
            if (paidUnlocked()) {
              savePaidPassword('');
              // Both lists carry 🔒 state, so both need the nudge.
              setModels(ms => [...ms]); // re-render disabled state
              setCoderBrands(bs => [...bs]);
              if (teamPrefsRef.current.preset !== 'custom') applyPreset(teamPrefsRef.current.preset);
              return;
            }
            const pw = window.prompt('Paid models password');
            if (!pw) return;
            fetch('/api/unlock-paid', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: pw }),
            })
              .then(async (res) => {
                const data = await res.json().catch(() => ({})) as { error?: string };
                if (!res.ok) throw new Error(data.error || 'Wrong password');
                savePaidPassword(pw);
                setModels(ms => [...ms]);
                setCoderBrands(bs => [...bs]);
                // The team was on free stand-ins while locked — give it its real seats.
                if (teamPrefsRef.current.preset !== 'custom') applyPreset(teamPrefsRef.current.preset);
              })
              .catch((err: Error) => window.alert(err.message || 'Unlock failed'));
          }}
          title={paidUnlocked() ? 'Paid models unlocked on this device — click to lock' : 'Unlock paid models'}
          style={{ background: paidUnlocked() ? 'rgba(52,211,153,.16)' : '#16131B',
            color: paidUnlocked() ? '#34D399' : '#A39AA8',
            border: '1px solid #2A2030', borderRadius: 4, padding: '3px 8px',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>
          {paidUnlocked() ? 'Paid ✓' : 'Unlock'}
        </button>
        {repo.sandboxId && (
          <span style={{ fontSize: 12, color: '#3E3048', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}
            title={repo.sandboxId}>● {repo.sandboxId.slice(0, 20)}</span>
        )}
        <button type="button" className="ws-btn" onClick={() => setShowCompare(true)}
          title="Compare — two models, one prompt, two live previews"
          aria-haspopup="dialog" aria-expanded={showCompare}
          style={{ background: 'var(--surface-2)', color: 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 15, marginLeft: 'auto' }}>
          ⇄
        </button>
        <button type="button" className="ws-btn" onClick={() => setShowSettings(true)}
          title="Settings — API keys, role models, automation, per-chunk models"
          aria-haspopup="dialog" aria-expanded={showSettings}
          style={{ background: activeApiKey ? 'var(--success-dim)' : 'var(--surface-2)',
            color: activeApiKey ? 'var(--success)' : 'var(--text-muted)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 16 }}>
          ⚙
        </button>
      </div>
      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        keys={keys}
        onKeySave={handleKeySave}
        roleSummary={{
          write: roleModels.write.model.split('/').pop() ?? roleModels.write.model,
          review: roleModels.review.model.split('/').pop() ?? roleModels.review.model,
          plan: roleModels.plan.model.split('/').pop() ?? roleModels.plan.model,
        }}
        autoApplyOn={autoApplyOn} setAutoApplyOn={setAutoApplyOn}
        autoRun={autoRun} setAutoRun={setAutoRun}
        autoVerifyOn={autoVerifyOn} setAutoVerifyOn={setAutoVerifyOn}
        sandboxReady={!!repo.sandboxId && !!repo.root}
        contextText={
          [
            repo.repoUrl ? `Repo: ${repo.repoUrl}` : '',
            repo.tree.length
              ? `File tree (sample): ${repo.tree.slice(0, 40).map((n) => n.path).join(', ')}`
              : '',
          ].filter(Boolean).join('\n')
        }
        onSliceComplete={handleSliceGenerateComplete}
        teamSection={
          <div data-testid="team-settings" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select data-testid="team-settings-select"
                value={teamPrefs.preset !== 'custom' ? teamPrefs.preset
                  : teamPrefs.savedId && savedTeams.some(t => t.id === teamPrefs.savedId) ? `saved:${teamPrefs.savedId}` : ''}
                onChange={e => {
                  const v = e.target.value;
                  if (v.startsWith('saved:')) pickSavedTeam(v.slice(6));
                  else if (v) applyPreset(v as PresetId);
                }}
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', padding: '5px 8px', fontFamily: 'inherit', fontSize: 14, maxWidth: '100%' }}>
                {teamPrefs.preset === 'custom' && !(teamPrefs.savedId && savedTeams.some(t => t.id === teamPrefs.savedId)) &&
                  <option value="">Custom (your picks)</option>}
                <optgroup label="Teams">
                  {(Object.keys(PRESETS) as PresetId[]).map(id => (
                    <option key={id} value={id}>{PRESETS[id].label}{teamStars[id] ? ` ${stars(teamStars[id]!)}` : ''}</option>
                  ))}
                </optgroup>
                {savedTeamMenu.length > 0 && (
                  <optgroup label="Your teams">
                    {savedTeamMenu.map(t => <option key={t.id} value={`saved:${t.id}`}>{t.name} {stars(t.stars)}</option>)}
                  </optgroup>
                )}
              </select>
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                {teamPrefs.preset !== 'custom' ? PRESETS[teamPrefs.preset].blurb
                  : savedTeams.find(t => t.id === teamPrefs.savedId)
                    ? `Your team “${savedTeams.find(t => t.id === teamPrefs.savedId)!.name}”.`
                    : 'Pick a team to reset every seat.'}
              </span>
            </div>
            {SEATS.map(seat => {
              const sm = teamSeats[seat.id];
              const open = isUncensoredModel(sm.provider, sm.model);
              return (
                <div key={seat.id} style={{ display: 'flex', gap: 8, fontSize: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <strong style={{ width: 56 }}>{seat.label}</strong>
                  <span style={{ color: 'var(--text)' }}>{sm.model}</span>
                  <span style={{ fontSize: 12, color: open ? '#34D399' : '#FFB86B' }}>
                    {open ? 'uncensored' : 'filtered'} · {stars(costStars(sm.provider, (teamCatalogs[sm.provider] || []).find(m => m.id === sm.model)))}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>— {seat.job}</span>
                </div>
              );
            })}
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={teamPrefs.askFirst} onChange={e => setAskFirst(e.target.checked)} />
              Ask me who builds it before any code is written
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" data-testid="team-settings-save"
                onClick={() => {
                  const current = savedTeams.find(t => t.id === teamPrefs.savedId)?.name || '';
                  const name = window.prompt('Name this team', current)?.trim();
                  if (name) saveTeamAs(name, teamSeats);
                }}
                style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', padding: '5px 10px', fontFamily: 'inherit', fontSize: 14, cursor: 'pointer' }}>
                ★ Save these seats as a team
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                Teams and seat picks are kept on the server too, so clearing this browser doesn't lose them.
              </span>
            </div>
            {savedTeams.map(t => (
              <div key={t.id} data-testid="saved-team-row" style={{ display: 'flex', gap: 8, fontSize: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{t.name}</strong>
                <span style={{ fontSize: 12 }}>{stars(seatsStars(t.seats, teamCatalogs))}</span>
                <span style={{ fontSize: 12, color: 'var(--text-dim)', flex: '1 1 200px' }}>
                  {SEATS.map(x => `${x.label}: ${t.seats[x.id].model}`).join(' · ')}
                </span>
                <button type="button" onClick={() => pickSavedTeam(t.id)}
                  style={{ background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', padding: '3px 8px', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer' }}>
                  Use
                </button>
                <button type="button" data-testid="saved-team-delete"
                  onClick={() => { if (window.confirm(`Delete the team “${t.name}”?`)) deleteSavedTeam(t.id); }}
                  style={{ background: 'transparent', color: '#FF6B6B', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', padding: '3px 8px', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer' }}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        }
      />
    </div>
  );

  // ── apply-results banner (reused in both layouts) ─────────────────────────
  const applyFailed = applyResults.filter(r => !r.ok);
  const applyOk = applyResults.filter(r => r.ok);
  const applyBanner = applyResults.length > 0 ? (
    <div data-testid="apply-banner" style={{
      padding: '8px 12px',
      background: applyFailed.length ? '#3a1010' : 'rgba(52,211,153,.16)',
      borderBottom: `2px solid ${applyFailed.length ? '#ff6a6a' : 'rgba(52,211,153,.16)'}`,
      flexShrink: 0, fontSize: 16, lineHeight: 1.45,
    }}>
      {applyFailed.length > 0 ? (
        <div style={{ color: '#ffb4b4', fontWeight: 800, marginBottom: 4, letterSpacing: '0.03em' }}>
          ⛔ SANDBOX PROTECTED — {applyFailed.length} write{applyFailed.length === 1 ? '' : 's'} blocked
        </div>
      ) : (
        <div style={{ color: '#34D399', fontWeight: 700 }}>
          Saved {applyOk.length} file{applyOk.length === 1 ? '' : 's'}
        </div>
      )}
      {applyFailed.length > 0 && applyOk.map(r => (
        <div key={r.path} style={{ color: '#34D399' }}>✓ {r.path}</div>
      ))}
      {applyFailed.map(r => (
        <div key={r.path} style={{ color: '#ff6a6a', marginTop: 2 }}>
          ✗ {r.path}{r.error ? ` — ${r.error}` : ''}
        </div>
      ))}
    </div>
  ) : null;

  // ── the ChatPane column (always has input at bottom) ──────────────────────
  const chatColumn = (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {restoreNote && (
        <div data-testid="restore-note" style={{ padding: '8px 12px', background: 'rgba(52,211,153,.12)',
          borderBottom: '1px solid rgba(52,211,153,.3)', color: '#C9F2E0', fontSize: 15,
          display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ flex: 1 }}>{restoreNote}</span>
          <button type="button" onClick={() => setRestoreNote(null)}
            style={{ background: 'transparent', border: 'none', color: '#A39AA8', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
      )}
      {backupNote && (
        <div data-testid="backup-note" style={{ padding: '8px 12px', background: 'rgba(96,165,250,.12)',
          borderBottom: '1px solid rgba(96,165,250,.3)', color: '#CBE2FF', fontSize: 15,
          display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ flex: 1 }}>{backupNote}</span>
          <button type="button" onClick={() => setBackupNote(null)}
            style={{ background: 'transparent', border: 'none', color: '#A39AA8', cursor: 'pointer', fontSize: 16 }}>✕</button>
        </div>
      )}
      {applyBanner}
      {/* flex:1 + minHeight:0 lets the messages scroll without pushing the form off */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden',
        display: 'flex', flexDirection: 'column' }}>
        <ChatPane
          key={sessionKey}
          ref={chatRef}
          repoRoot={repo.root}
          repoUrl={repo.repoUrl}
          sandboxId={repo.sandboxId}
          provider={provider}
          model={model}
          role={role}
          persona={orchPersona}
          onModelReplaced={handleModelReplaced}
          onOpenPush={handleOpenPush}
          onCompareBrief={handleCompareBrief}
          askBeforeBuild={teamPrefs.askFirst}
          buildPicker={renderBuildPicker}
          fixer={teamPrefs.seats ? withKey(teamSeats.fix) : null}
          apiKey={activeApiKey || undefined}
          tree={repo.tree}
          contextFiles={repo.contextFiles}
          autoRun={autoRun}
          appliedPaths={appliedPaths}
          autoSelectedFiles={autoCtxFiles}
          initialMessages={chatMessages}
          onMessagesChange={setChatMessages}
          onRunCode={handleRunCode}
          onFileChanges={handleFileChanges}
          onUploadText={(name, content) => repo.injectContextFile(name, content)}
          onBeforeSend={handleAutoContext}
          searchHits={searchHits}
          pythonReady={repo.pythonReady}
          pythonDetail={repo.pythonDetail}
          rustReady={repo.rustReady}
          rustDetail={repo.rustDetail}
          goReady={repo.goReady}
          goDetail={repo.goDetail}
        />
      </div>
      <DiffPanel
        changes={repo.pendingChanges} applying={applying}
        appliedPaths={appliedPaths}
        canPush={!!repo.sandboxId && autoVerify.pushAllowed}
        projectOpen={!!repo.sandboxId}
        openPushSignal={openPushSignal}
        pushBlockedReason={
          !repo.sandboxId
            ? null
            : autoVerify.pushAllowed
              ? null
              : autoVerify.verifyState === 'failed'
                ? 'Push locked — tests/smoke failed. Retry Auto-test until verified.'
                : autoVerify.verifyState === 'running' || autoVerify.verifyState === 'detecting' || String(autoVerify.verifyState).startsWith('retry')
                  ? 'Push locked — sandbox is still verifying…'
                  : 'Push locked until Auto-test passes in the sandbox.'
        }
        pushing={pushing}
        pushError={pushError}
        pushOk={pushOk}
        onApply={() => { void handleApplyAndVerify(); }}
        onRunTest={() => { void runVerify(); }}
        onDismiss={p => repo.setPendingChanges(repo.pendingChanges.filter(c => c.path !== p))}
        onDismissAll={() => { repo.clearChanges(); setPushError(null); setPushOk(null); }}
        onPush={(token, message) => { void handlePush(token, message); }}
        onCopyGitCommands={async () => {
          const cmd = buildPushShellCommands({ commitMessage: 'Apply agent changes' });
          const ok = await copyText(cmd);
          if (ok) {
            setPushOk('Git commands copied — paste into Terminal. For push with auth, use Push to GitHub (only after verified).');
            setMobileTab('terminal');
          }
        }}
      />
      <VerifyBanner
        verifyState={autoVerify.verifyState}
        attempt={autoVerify.attempt}
        testCommand={autoVerify.testCommand}
        askCommand={autoVerify.askCommand}
        onRun={() => { void runVerify(); }}
        onSetCommand={cmd => { autoVerify.setCustomCommand(cmd); void runVerify(); }}
        onDismiss={autoVerify.reset}
      />
    </div>
  );

  const fileTree = (
    <FileTree
      repoRoot={repo.root} repoUrl={repo.repoUrl} tree={repo.tree} totalFiles={repo.totalFiles}
      contextFiles={repo.contextFiles} loading={repo.loading} error={repo.error}
      pythonReady={repo.pythonReady} pythonDetail={repo.pythonDetail}
      rustReady={repo.rustReady} rustDetail={repo.rustDetail}
      goReady={repo.goReady} goDetail={repo.goDetail}
      onOpenRepo={repo.openRepo}
      onStartBlank={() => { void repo.startBlankProject(); }}
      onAddToContext={repo.addToContext}
      onRemoveFromContext={repo.removeFromContext} onClearContext={repo.clearContext}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column',
      height: '100dvh', maxHeight: '100dvh', width: '100%', maxWidth: '100%',
      background: '#09080C', fontFamily: '"JetBrains Mono",ui-monospace,monospace',
      overflow: 'hidden' }}>
      {topbar}

      {showHome && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.72)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 16px 16px' }}
          onClick={() => setShowHome(false)}>
          <div role="dialog" aria-label="Code Space home"
            onClick={e => e.stopPropagation()}
            style={{ width: 'min(520px, 100%)', maxHeight: 'min(80dvh, 640px)', overflow: 'auto',
              background: '#100E14', border: '1px solid #FF1F5A', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <h2 style={{ margin: 0, flex: 1, fontSize: 18, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: '#FF1F5A' }}>Home · Code Spaces</h2>
              <button type="button" onClick={startFreshHome}
                style={{ background: 'rgba(212,255,63,0.12)', color: '#FF1F5A', border: '1px solid #C8123F',
                  borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 15, fontWeight: 700 }}>New</button>
              <button type="button" onClick={() => setShowHome(false)}
                style={{ background: 'transparent', color: '#A39AA8', border: '1px solid #2A2030',
                  borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 15 }}>Close</button>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: 16, color: '#A39AA8', lineHeight: 1.4 }}>
              Open a saved code space conversation, or start a fresh Home code space.
              Opening <b style={{ color: '#FF1F5A' }}>Code Space</b> from Chat always loads that chat here.
            </p>
            {homeList.length === 0 ? (
              <p style={{ color: '#756B7B', fontSize: 16 }}>No saved code spaces yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                {homeList.map(s => (
                  <li key={s.id}>
                    <button type="button" onClick={() => openStoredSession(s)}
                      style={{ width: '100%', textAlign: 'left', background: s.id === sessionId ? 'rgba(212,255,63,0.1)' : '#09080C',
                        border: `1px solid ${s.id === sessionId ? '#FF1F5A' : '#2A2030'}`, borderRadius: 6,
                        padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
                      <div style={{ color: '#FF1F5A', fontSize: 18, fontWeight: 700,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.title || 'Code Space'}
                      </div>
                      <div style={{ color: '#756B7B', fontSize: 15, marginTop: 4 }}>
                        {(s.messages || []).length} messages
                        {s.fromChat ? ' · from chat' : ''}
                        {' · '}
                        {s.savedAt ? new Date(s.savedAt).toLocaleString() : ''}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <ComparePanel ref={compareRef} open={showCompare} onClose={() => setShowCompare(false)}
        sandboxId={repo.sandboxId} onUseBuild={handleUseBuild} />

      {!isMobile ? (
        /* ── Desktop: 3-column grid (single ChatPane + Terminal) ── */
        <div style={{ flex: 1, minHeight: 0, display: 'grid',
          gridTemplateColumns: '240px 1fr 420px', overflow: 'hidden' }}>
          <div style={{ borderRight: '1px solid #18151D', overflow: 'hidden',
            display: 'flex', flexDirection: 'column' }}>
            {fileTree}
          </div>
          <div style={{ borderRight: '1px solid #18151D', overflow: 'hidden',
            display: 'flex', flexDirection: 'column' }}>
            {chatColumn}
          </div>
          <div style={{ overflow: 'hidden', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', borderBottom: '1px solid #18151D', flexShrink: 0 }}>
              {(['terminal', 'preview'] as const).map(t => (
                <button key={t} type="button" onClick={() => setDesktopRightTab(t)}
                  style={{ flex: 1, padding: '8px 0', background: desktopRightTab === t ? '#100E14' : 'transparent',
                    color: desktopRightTab === t ? '#FF1F5A' : '#A39AA8', border: 'none',
                    borderBottom: desktopRightTab === t ? '2px solid #FF1F5A' : '2px solid transparent',
                    fontFamily: 'inherit', fontSize: 15, fontWeight: desktopRightTab === t ? 700 : 500,
                    cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  {t === 'terminal' ? 'Terminal' : 'Preview'}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              <div style={{ position: 'absolute', inset: 0, overflow: 'hidden',
                display: desktopRightTab === 'terminal' ? 'flex' : 'none', flexDirection: 'column' }}>
                <SandboxTerminal ref={termRef} sandboxId={repo.sandboxId} onDevServerPort={handleDevServerPort} />
              </div>
              <div style={{ position: 'absolute', inset: 0, overflow: 'hidden',
                display: desktopRightTab === 'preview' ? 'flex' : 'none', flexDirection: 'column' }}>
                <PreviewPanel sandboxId={repo.sandboxId} detectedPort={previewPort} autoStartKey={previewKick} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ── Mobile: single ChatPane/Terminal instance; hide inactive tabs
            with display (don't unmount) so chat history + termRef survive. ── */
        <>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, overflow: 'hidden',
              display: mobileTab === 'files' ? 'flex' : 'none', flexDirection: 'column' }}>
              {fileTree}
            </div>
            <div style={{ position: 'absolute', inset: 0, overflow: 'hidden',
              display: mobileTab === 'chat' ? 'flex' : 'none', flexDirection: 'column' }}>
              {chatColumn}
            </div>
            <div style={{ position: 'absolute', inset: 0, overflow: 'hidden',
              display: mobileTab === 'terminal' ? 'flex' : 'none', flexDirection: 'column' }}>
              <SandboxTerminal ref={termRef} sandboxId={repo.sandboxId} onDevServerPort={handleDevServerPort} />
            </div>
            <div style={{ position: 'absolute', inset: 0, overflow: 'hidden',
              display: mobileTab === 'preview' ? 'flex' : 'none', flexDirection: 'column' }}>
              <PreviewPanel sandboxId={repo.sandboxId} detectedPort={previewPort} autoStartKey={previewKick} />
            </div>
          </div>
          <div style={{ display: 'flex', flexShrink: 0, borderTop: '1px solid #18151D',
            background: '#09080C', paddingBottom: 'env(safe-area-inset-bottom)',
            position: 'relative', zIndex: 50 }}
            className="mobile-tabs">
            {([
              { id: 'files' as const, label: `Files${repo.tree.length ? ` (${repo.totalFiles})` : ''}` },
              { id: 'chat' as const, label: 'Chat' },
              { id: 'terminal' as const, label: 'Terminal' },
              { id: 'preview' as const, label: 'Preview' },
            ]).map(t => (
              <button key={t.id} type="button" onClick={() => setMobileTab(t.id)}
                aria-current={mobileTab === t.id ? 'page' : undefined}
                style={{ flex: 1, padding: '14px 0', minHeight: 48,
                  background: mobileTab === t.id ? '#100E14' : 'transparent',
                  color: mobileTab === t.id ? '#FF1F5A' : '#A39AA8', border: 'none',
                  borderTop: mobileTab === t.id ? '2px solid #FF1F5A' : '2px solid transparent',
                  fontFamily: 'inherit', fontSize: 16, fontWeight: mobileTab === t.id ? 700 : 500,
                  cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.08em',
                  WebkitTapHighlightColor: 'transparent' }}>
                {t.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
