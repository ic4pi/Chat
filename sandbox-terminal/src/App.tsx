import { useCallback, useEffect, useRef, useState } from 'react';
import { FileTree }         from './FileTree.js';
import { ChatPane }         from './ChatPane.js';
import type { ChatHandle, Message }  from './ChatPane.js';
import { DiffPanel }        from './DiffPanel.js';
import { SandboxTerminal }  from './Terminal.js';
import type { TerminalHandle } from './Terminal.js';
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
  buildPushShellCommands,
  type StoredSession,
} from './sessionStore.js';
import { copyText } from './downloadFile.js';
import { peekWorkspaceHandoff } from './workspaceHandoff.js';
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
import { ChunkModelPanel, type GenerateChunkResult } from './ChunkModelPanel.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

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

type MobileTab = 'files' | 'chat' | 'terminal';

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
  const color = passed ? '#0a0a0a' : failed ? '#fff' : '#0a0a0a';
  const bg = passed ? '#8fbf6f' : failed ? '#8a1f1f' : '#d4ff3f';
  const shortCmd = testCommand
    ? (testCommand.length > 64 ? `${testCommand.slice(0, 64)}…` : testCommand)
    : '…';
  const label = verifyState === 'detecting' ? 'SANDBOX CHECK — detecting test / smoke…' :
    verifyState === 'running' ? `SANDBOX CHECK RUNNING — ${shortCmd}` :
    passed ? 'SANDBOX VERIFIED — Push unlocked. Incomplete stubs never get this far.' :
    failed ? `SANDBOX FAILED — Push LOCKED after ${attempt} attempts. Fix until green.` :
    `SANDBOX AUTO-FIX — attempt ${attempt}/5 (do not push yet)`;
  if (askCommand) return (
    <div data-testid="verify-banner" style={{ padding: '10px 12px', background: '#5a1010',
      borderTop: '2px solid #ff6a6a', flexShrink: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: '#ffb4b4', marginBottom: 4,
        letterSpacing: '0.04em' }}>
        PUSH LOCKED — no sandbox check found
      </div>
      <div style={{ fontSize: 11, color: '#ffd0d0', marginBottom: 6, lineHeight: 1.45 }}>
        Enter <code style={{ color: '#d4ff3f' }}>npm test</code> / your command, or add{' '}
        <code style={{ color: '#d4ff3f' }}>index.html</code> for built-in smoke. Nothing ships unproven.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={cmd} onChange={e => setCmd(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && cmd.trim() && onSetCommand(cmd.trim())}
          placeholder="e.g. npm test"
          style={{ flex: 1, background: '#151515', color: '#e8e8e8', border: '1px solid #333',
            borderRadius: 4, padding: '4px 8px', fontFamily: 'inherit', fontSize: 12, outline: 'none' }} />
        <button onClick={() => cmd.trim() && onSetCommand(cmd.trim())}
          style={{ background: '#d4ff3f', color: '#0a0a0a', border: 'none', borderRadius: 4,
            padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
          Set & Run</button>
        <button onClick={onDismiss}
          style={{ background: '#1a1a1a', color: '#888', border: '1px solid #333',
            borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}>
          Later</button>
      </div>
    </div>
  );
  return (
    <div data-testid="verify-banner" style={{ display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', background: bg, borderTop: `2px solid ${passed ? '#6a9a4a' : failed ? '#ff6a6a' : '#b8d92a'}`,
      flexShrink: 0 }}>
      <div style={{ width: 10, height: 10, borderRadius: '50%',
        background: passed || running ? '#0a0a0a' : '#fff', flexShrink: 0 }} />
      <span style={{ fontSize: 13, fontWeight: 800, color, flex: 1, lineHeight: 1.35,
        letterSpacing: '0.02em' }}>{label}</span>
      {(passed || failed) && (
        <button onClick={failed ? onRun : onDismiss}
          style={{ background: passed ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.35)',
            color, border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer',
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
  /** Prevents Auto-apply from starting a second verify while one is running. */
  const verifyingRef = useRef(false);
  const roleModelsRef = useRef(loadRoleModels());
  type Boot = { session: StoredSession | null; fromChat: boolean };
  const bootRef = useRef<Boot | null>(null);
  if (!bootRef.current) {
    const handoff = peekWorkspaceHandoff();
    if (handoff) {
      const id = handoff.chatId || `handoff-${handoff.createdAt || Date.now()}`;
      const title = handoff.title || 'From chat';
      const imported = (handoff.messages || [])
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          id: Math.random().toString(36).slice(2, 10),
          role: m.role as 'user' | 'assistant',
          content: m.content,
          kind: 'imported',
        }));
      // Always open THIS chat’s workspace thread — never keep a previous chat’s convo.
      const prev = loadSession(id);
      const session: StoredSession = {
        v: 2,
        id,
        title,
        savedAt: Date.now(),
        repoUrl: prev?.repoUrl ?? null,
        sandboxId: prev?.sandboxId ?? null,
        provider: handoff.provider || prev?.provider || roleModelsRef.current.write.provider || 'openrouter',
        model: handoff.model || prev?.model || roleModelsRef.current.write.model || 'openrouter/free',
        autoApplyOn: prev?.autoApplyOn ?? true,
        messages: imported.length ? imported : [],
        pendingChanges: imported.length ? [] : (prev?.pendingChanges || []),
        fromChat: true,
      };
      saveSession(session);
      setActiveSessionId(id);
      bootRef.current = { session, fromChat: true };
    } else {
      const session = loadSession();
      if (session) setActiveSessionId(session.id);
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
  const [keys,         setKeys]         = useState(() => loadProviderKeys());
  const [showKeys,     setShowKeys]     = useState(false);
  const [showRoles,    setShowRoles]    = useState(false);
  const [showSlices,   setShowSlices]   = useState(false);
  const [roleModels,   setRoleModels]   = useState(() => loadRoleModels());
  // Auto-save ON — generated files go to the sandbox immediately so you can download/push.
  const [autoRun,      setAutoRun]      = useState(false);
  const [autoApplyOn,  setAutoApplyOn]  = useState(restored.current?.autoApplyOn ?? true);
  const [autoVerifyOn, setAutoVerifyOn] = useState(true);
  const [applying,     setApplying]     = useState(false);
  const [appliedPaths, setAppliedPaths] = useState<Set<string>>(new Set());
  const [applyResults, setApplyResults] = useState<Array<{ path: string; ok: boolean; error?: string }>>([]);
  const [autoCtxFiles, setAutoCtxFiles] = useState<string[]>([]);
  const [searchHits,   setSearchHits]   = useState<SearchHit[]>([]);
  const [mobileTab,    setMobileTab]    = useState<MobileTab>('chat');
  const [pushing,      setPushing]      = useState(false);
  const [pushError,    setPushError]    = useState<string | null>(null);
  const [pushOk,       setPushOk]       = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(
    () => restored.current?.id || `home-${Date.now()}`,
  );
  const [sessionTitle, setSessionTitle] = useState(
    () => restored.current?.title || 'Home workspace',
  );
  const [chatMessages, setChatMessages] = useState<Message[]>(() => {
    const m = restored.current?.messages;
    if (!m?.length) return [];
    return m.map(x => ({
      id: x.id,
      role: x.role,
      content: x.content,
      kind: x.kind as Message['kind'],
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

  // Re-open last GitHub repo + restore pending file drafts once on mount.
  useEffect(() => {
    const s = restored.current;
    if (!s) return;
    let cancelled = false;
    (async () => {
      if (s.repoUrl) {
        await repo.openRepo(s.repoUrl);
      }
      if (!cancelled && s.pendingChanges?.length) {
        repo.setPendingChanges(s.pendingChanges);
      }
    })().catch(() => { /* open may fail if sandbox expired */ });
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
        id: m.id, role: m.role, content: m.content, kind: m.kind,
      })),
      pendingChanges: repo.pendingChanges,
    });
    setHomeList(listSessions());
  }, [
    sessionId, sessionTitle, fromChat,
    repo.repoUrl, repo.sandboxId, repo.pendingChanges,
    provider, model, autoApplyOn, chatMessages,
  ]);

  const openStoredSession = useCallback((s: StoredSession) => {
    setActiveSessionId(s.id);
    setSessionId(s.id);
    setSessionTitle(s.title || 'Workspace');
    setProvider(s.provider || 'openrouter');
    setModel(s.model || 'openrouter/free');
    setAutoApplyOn(s.autoApplyOn ?? true);
    setChatMessages((s.messages || []).map(x => ({
      id: x.id,
      role: x.role,
      content: x.content,
      kind: x.kind as Message['kind'],
    })));
    setPushError(null);
    setPushOk(null);
    setShowHome(false);
    setSessionKey(k => k + 1);
    if (s.pendingChanges?.length) repo.setPendingChanges(s.pendingChanges);
    else repo.clearChanges();
    if (s.repoUrl) void repo.openRepo(s.repoUrl);
  }, [repo]);

  const startFreshHome = useCallback(() => {
    const id = `home-${Date.now()}`;
    const session: StoredSession = {
      v: 2,
      id,
      title: 'Home workspace',
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

  const handleProviderChange = (p: string) => {
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
    setModel(m);
    setRoleModels(prev => {
      const next = { ...prev, [role]: { provider, model: m } };
      saveRoleModels(next);
      return next;
    });
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
      return results;
    } finally { setApplying(false); }
  }, [repo]);

  const autoVerify = useAutoVerify(repo.root, repo.sandboxId, termRef, chatRef, repo.applyChanges);

  const runVerify = useCallback(async () => {
    if (verifyingRef.current) return autoVerify.verifyState === 'passed' ? 'passed' as const : 'idle' as const;
    verifyingRef.current = true;
    // Stay on Chat — don't yank the user to Terminal.
    try { return await autoVerify.verify(); }
    finally { verifyingRef.current = false; }
  }, [autoVerify]);

  const handleApplyAndVerify = useCallback(async (files?: PendingChange[]) => {
    const results = await handleApply(files);
    if (results.some(r => r.ok) && autoVerifyOn && (repo.root || repo.sandboxId)) {
      await runVerify();
    }
    return results;
  }, [handleApply, autoVerifyOn, repo.root, repo.sandboxId, runVerify]);

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
  }, [repo, autoVerify, autoApplyOn, handleApply, handleApplyAndVerify]);

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
      setPushError('Open a GitHub repo first (blank projects have no remote yet).');
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
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (data.pushed) {
        setPushOk(
          `Pushed to GitHub${data.branch ? ` (${data.branch})` : ''} after checks passed. ` +
          'Open the repo on github.com to see the new commit.',
        );
      } else {
        setPushOk(data.message ?? 'Nothing new to push.');
      }
    } catch (err: unknown) {
      setPushError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  }, [repo.sandboxId, repo.pendingChanges, handleApply, autoVerifyOn, autoVerify.verifyState, autoVerify.lastFailDetail, runVerify]);

  // ── Shared topbar ────────────────────────────────────────────────────────
  const topbar = (
    <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0,
      borderBottom: '1px solid #1e1e1e', background: '#080808' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '6px 12px' }}>
        <a href="/" style={{ color: '#d4ff3f', fontSize: 12, textDecoration: 'none',
          whiteSpace: 'nowrap', padding: '2px 0', fontWeight: 700 }}>← Chat</a>
        <button type="button" onClick={() => { setHomeList(listSessions()); setShowHome(true); }}
          title="Browse saved workspace conversations"
          style={{ background: showHome ? 'rgba(212,255,63,0.16)' : 'transparent',
            color: '#d4ff3f', border: '1px solid #8fa62b', borderRadius: 4,
            padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10,
            fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Home
        </button>
        <span style={{ color: '#d4ff3f', fontSize: 11, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}
          title={sessionTitle}>
          {sessionTitle}
        </span>
        {fromChat && (
          <span style={{ fontSize: 10, color: '#8fa62b', whiteSpace: 'nowrap' }}>
            from chat
          </span>
        )}
        <button type="button" onClick={startFreshHome}
          style={{ background: 'transparent', color: '#888', border: '1px solid #333',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 10 }}>
          New
        </button>
        {(repo.repoUrl || chatMessages.length > 0) && (
          <button type="button"
            onClick={() => {
              if (!confirm('Delete this workspace conversation on this device?')) return;
              clearSession(sessionId);
              const next = listSessions()[0];
              if (next) openStoredSession(next);
              else startFreshHome();
            }}
            style={{ background: 'transparent', color: '#555', border: '1px solid #222',
              borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 10 }}>
            Delete
          </button>
        )}
        <select value={role} onChange={e => handleRoleChange(e.target.value as RoleId)}
          title="Role — uses the model you assigned for write / review / plan"
          style={{ background: '#111', color: '#e8e8e8', border: '1px solid #333',
            borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>
          {ROLE_LIST.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <select value={provider} onChange={e => handleProviderChange(e.target.value)}
          style={{ background: '#111', color: '#e8e8e8', border: '1px solid #333',
            borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>
          {PROVIDER_LIST.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <select value={model} onChange={e => handleModelChange(e.target.value)}
          disabled={modelsLoading}
          style={{ background: '#111', color: '#e8e8e8', border: '1px solid #333',
            borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 11,
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
        <button type="button"
          onClick={() => {
            if (paidUnlocked()) {
              savePaidPassword('');
              setModels(ms => [...ms]); // re-render disabled state
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
              })
              .catch((err: Error) => window.alert(err.message || 'Unlock failed'));
          }}
          title={paidUnlocked() ? 'Paid models unlocked on this device — click to lock' : 'Unlock paid models'}
          style={{ background: paidUnlocked() ? '#1a2a0a' : '#151515',
            color: paidUnlocked() ? '#8fbf6f' : '#888',
            border: '1px solid #2a2a2a', borderRadius: 4, padding: '3px 8px',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 10 }}>
          {paidUnlocked() ? 'Paid ✓' : 'Unlock'}
        </button>
        <button type="button" onClick={() => setShowKeys(s => !s)}
          title="Bring your own API keys"
          style={{ background: activeApiKey ? '#1a2a0a' : '#151515', color: activeApiKey ? '#8fbf6f' : '#888',
            border: '1px solid #2a2a2a', borderRadius: 4, padding: '3px 8px',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 10 }}>
          Keys
        </button>
        <button type="button" onClick={() => { setShowRoles(s => !s); setShowSlices(false); }}
          title="Assign models per role"
          style={{ background: showRoles ? '#1a2a0a' : '#151515', color: '#888',
            border: '1px solid #2a2a2a', borderRadius: 4, padding: '3px 8px',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 10 }}>
          Roles
        </button>
        <button type="button"
          onClick={() => { setShowSlices(s => !s); setShowRoles(false); }}
          title="Assign an LLM per coding chunk (HTML, CSS, JS…) and Generate"
          aria-expanded={showSlices}
          aria-controls="chunk-model-panel"
          style={{ background: showSlices ? '#1a2a0a' : '#151515',
            color: showSlices ? '#d4ff3f' : '#888',
            border: '1px solid #2a2a2a', borderRadius: 4, padding: '3px 8px',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 10 }}>
          Slices
        </button>
        {repo.sandboxId && (
          <span style={{ fontSize: 9, color: '#444', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}
            title={repo.sandboxId}>● {repo.sandboxId.slice(0, 20)}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <label title="Off by default. When on, suggested file changes save to the cloud sandbox only — not GitHub, not your phone."
            style={{ display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
            Auto-save <input type="checkbox" checked={autoApplyOn} onChange={e => setAutoApplyOn(e.target.checked)}
              style={{ accentColor: '#d4ff3f' }} />
          </label>
          <label title="Off by default. When on, code snippets run in the sandbox terminal."
            style={{ display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
            Auto-run <input type="checkbox" checked={autoRun} onChange={e => setAutoRun(e.target.checked)}
              style={{ accentColor: '#d4ff3f' }} />
          </label>
          <label title="On by default. Runs npm run check / project tests after saves so bad edits get fixed before you push."
            style={{ display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
            Auto-test <input type="checkbox" checked={autoVerifyOn} onChange={e => setAutoVerifyOn(e.target.checked)}
              style={{ accentColor: '#d4ff3f' }} />
          </label>
        </div>
      </div>
      {showKeys && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid #1a1a1a',
          display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          <div style={{ gridColumn: '1 / -1', fontSize: 10, color: '#666', lineHeight: 1.4 }}>
            Keys stay in this browser only. Used when set; otherwise the server env key is used.
          </div>
          {PROVIDER_LIST.map(p => (
            <label key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10, color: '#888' }}>
              {p.label}
              <input type="password" autoComplete="off"
                value={keys[p.id] || ''}
                placeholder={`${p.label} API key`}
                onChange={e => handleKeySave(p.id, e.target.value)}
                style={{ background: '#111', color: '#e8e8e8', border: '1px solid #333',
                  borderRadius: 4, padding: '4px 8px', fontFamily: 'inherit', fontSize: 11 }} />
            </label>
          ))}
        </div>
      )}
      {showRoles && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid #1a1a1a', fontSize: 10, color: '#888', lineHeight: 1.5 }}>
          Switch the role dropdown to use a different model for writing, reviewing, or planning.
          Changing provider/model while a role is selected saves that assignment.
          Current: write={roleModels.write.model.split('/').pop()} ·
          review={roleModels.review.model.split('/').pop()} ·
          plan={roleModels.plan.model.split('/').pop()}
        </div>
      )}
      {showSlices && (
        <div id="chunk-model-panel">
          <ChunkModelPanel
            sandboxReady={!!repo.sandboxId && !!repo.root}
            contextText={
              [
                repo.repoUrl ? `Repo: ${repo.repoUrl}` : '',
                repo.tree.length
                  ? `File tree (sample): ${repo.tree.slice(0, 40).map((n) => n.path).join(', ')}`
                  : '',
              ].filter(Boolean).join('\n')
            }
            onComplete={handleSliceGenerateComplete}
          />
        </div>
      )}
    </div>
  );

  // ── apply-results banner (reused in both layouts) ─────────────────────────
  const applyFailed = applyResults.filter(r => !r.ok);
  const applyOk = applyResults.filter(r => r.ok);
  const applyBanner = applyResults.length > 0 ? (
    <div data-testid="apply-banner" style={{
      padding: '8px 12px',
      background: applyFailed.length ? '#3a1010' : '#0c1a0c',
      borderBottom: `2px solid ${applyFailed.length ? '#ff6a6a' : '#1e3a1e'}`,
      flexShrink: 0, fontSize: 12, lineHeight: 1.45,
    }}>
      {applyFailed.length > 0 ? (
        <div style={{ color: '#ffb4b4', fontWeight: 800, marginBottom: 4, letterSpacing: '0.03em' }}>
          ⛔ SANDBOX PROTECTED — {applyFailed.length} write{applyFailed.length === 1 ? '' : 's'} blocked
        </div>
      ) : (
        <div style={{ color: '#8fbf6f', fontWeight: 700, marginBottom: 4 }}>
          Saved to sandbox — not GitHub yet. Push stays locked until Auto-test is green.
        </div>
      )}
      {applyOk.map(r => (
        <div key={r.path} style={{ color: '#8fbf6f' }}>✓ {r.path}</div>
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
        canPush={!!repo.sandboxId && !!repo.repoUrl && autoVerify.pushAllowed}
        pushBlockedReason={
          !repo.sandboxId || !repo.repoUrl
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
      repoRoot={repo.root} tree={repo.tree} totalFiles={repo.totalFiles}
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
      background: '#0a0a0a', fontFamily: '"JetBrains Mono",ui-monospace,monospace',
      overflow: 'hidden' }}>
      {topbar}

      {showHome && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,0.72)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '48px 16px 16px' }}
          onClick={() => setShowHome(false)}>
          <div role="dialog" aria-label="Workspace home"
            onClick={e => e.stopPropagation()}
            style={{ width: 'min(520px, 100%)', maxHeight: 'min(80dvh, 640px)', overflow: 'auto',
              background: '#131313', border: '1px solid #d4ff3f', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <h2 style={{ margin: 0, flex: 1, fontSize: 13, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: '#d4ff3f' }}>Home · Workspaces</h2>
              <button type="button" onClick={startFreshHome}
                style={{ background: 'rgba(212,255,63,0.12)', color: '#d4ff3f', border: '1px solid #8fa62b',
                  borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 11, fontWeight: 700 }}>New</button>
              <button type="button" onClick={() => setShowHome(false)}
                style={{ background: 'transparent', color: '#888', border: '1px solid #333',
                  borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 11 }}>Close</button>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: '#888', lineHeight: 1.4 }}>
              Open a saved workspace conversation, or start a fresh Home workspace.
              Opening <b style={{ color: '#d4ff3f' }}>Workspace</b> from Chat always loads that chat here.
            </p>
            {homeList.length === 0 ? (
              <p style={{ color: '#666', fontSize: 12 }}>No saved workspaces yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                {homeList.map(s => (
                  <li key={s.id}>
                    <button type="button" onClick={() => openStoredSession(s)}
                      style={{ width: '100%', textAlign: 'left', background: s.id === sessionId ? 'rgba(212,255,63,0.1)' : '#0a0a0a',
                        border: `1px solid ${s.id === sessionId ? '#d4ff3f' : '#333'}`, borderRadius: 6,
                        padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit' }}>
                      <div style={{ color: '#d4ff3f', fontSize: 13, fontWeight: 700,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.title || 'Workspace'}
                      </div>
                      <div style={{ color: '#666', fontSize: 11, marginTop: 4 }}>
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

      {!isMobile ? (
        /* ── Desktop: 3-column grid (single ChatPane + Terminal) ── */
        <div style={{ flex: 1, minHeight: 0, display: 'grid',
          gridTemplateColumns: '240px 1fr 420px', overflow: 'hidden' }}>
          <div style={{ borderRight: '1px solid #1e1e1e', overflow: 'hidden',
            display: 'flex', flexDirection: 'column' }}>
            {fileTree}
          </div>
          <div style={{ borderRight: '1px solid #1e1e1e', overflow: 'hidden',
            display: 'flex', flexDirection: 'column' }}>
            {chatColumn}
          </div>
          <div style={{ overflow: 'hidden', minHeight: 0 }}>
            <SandboxTerminal ref={termRef} sandboxId={repo.sandboxId} />
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
              <SandboxTerminal ref={termRef} sandboxId={repo.sandboxId} />
            </div>
          </div>
          <div style={{ display: 'flex', flexShrink: 0, borderTop: '1px solid #1e1e1e',
            background: '#080808', paddingBottom: 'env(safe-area-inset-bottom)',
            position: 'relative', zIndex: 50 }}
            className="mobile-tabs">
            {([
              { id: 'files' as const, label: `Files${repo.tree.length ? ` (${repo.totalFiles})` : ''}` },
              { id: 'chat' as const, label: 'Chat' },
              { id: 'terminal' as const, label: 'Terminal' },
            ]).map(t => (
              <button key={t.id} type="button" onClick={() => setMobileTab(t.id)}
                aria-current={mobileTab === t.id ? 'page' : undefined}
                style={{ flex: 1, padding: '14px 0', minHeight: 48,
                  background: mobileTab === t.id ? '#111' : 'transparent',
                  color: mobileTab === t.id ? '#d4ff3f' : '#aaa', border: 'none',
                  borderTop: mobileTab === t.id ? '2px solid #d4ff3f' : '2px solid transparent',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: mobileTab === t.id ? 700 : 500,
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
