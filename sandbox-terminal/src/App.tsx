import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { looksLikeSuggestRequest, needsCodeContext } from './agentParse.js';
import type { FileNode } from './types.js';
import { loadSession, saveSession, clearSession, buildPushShellCommands } from './sessionStore.js';
import { copyText } from './downloadFile.js';

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

// ---------------------------------------------------------------------------
// Provider / model options
// ---------------------------------------------------------------------------
const VENICE_MODELS = [
  { id: 'venice-uncensored',             label: 'Venice Uncensored (Dolphin 24B)' },
  { id: 'qwen3-235b-a22b-instruct-2507', label: 'Qwen3 235B Instruct' },
  { id: 'llama-3.3-70b',                 label: 'Llama 3.3 70B' },
  { id: 'mistral-31-24b',                label: 'Mistral 3.1 24B' },
  { id: 'hermes-3-llama-3.1-405b',       label: 'Hermes 3 405B' },
];
const OR_MODELS = [
  { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', label: 'Dolphin-Venice 24B (free)' },
  { id: 'nousresearch/hermes-3-llama-3.1-405b:free', label: 'Hermes 3 405B (free)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free',    label: 'Llama 3.3 70B (free)' },
];

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
    if (data.content.length > MAX_AUTO_FULL_FILE_CHARS * 1.25) return null;
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
  const color = verifyState === 'passed' ? '#8fbf6f' : verifyState === 'failed' ? '#ff6a6a' :
    verifyState === 'running' ? '#5b8dee' : '#d4ff3f';
  const label = verifyState === 'detecting' ? 'Detecting test command…' :
    verifyState === 'running' ? `Running: ${testCommand ?? '…'}` :
    verifyState === 'passed' ? '✓ Tests passed' :
    verifyState === 'failed' ? `✗ Tests failed after ${attempt} attempts` :
    `⟳ Retrying (attempt ${attempt}/3)`;
  if (askCommand) return (
    <div style={{ padding: '8px 12px', background: '#0f0f0f', borderTop: '1px solid #2a2a2a', flexShrink: 0 }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 5, lineHeight: 1.45 }}>
        Auto-test is optional. Skip unless you know your project’s test command.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={cmd} onChange={e => setCmd(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && cmd.trim() && onSetCommand(cmd.trim())}
          placeholder="only if you know it — or tap Skip"
          style={{ flex: 1, background: '#151515', color: '#e8e8e8', border: '1px solid #333',
            borderRadius: 4, padding: '4px 8px', fontFamily: 'inherit', fontSize: 12, outline: 'none' }} />
        <button onClick={() => cmd.trim() && onSetCommand(cmd.trim())}
          style={{ background: '#d4ff3f', color: '#0a0a0a', border: 'none', borderRadius: 4,
            padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
          Set & Run</button>
        <button onClick={onDismiss}
          style={{ background: '#1a1a1a', color: '#e8e8e8', border: '1px solid #333',
            borderRadius: 4, padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
          Skip</button>
      </div>
    </div>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
      background: '#0c0c0c', borderTop: '1px solid #1e1e1e', flexShrink: 0 }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 11, color, flex: 1 }}>{label}</span>
      {(verifyState === 'passed' || verifyState === 'failed') && (
        <button onClick={verifyState === 'failed' ? onRun : onDismiss}
          style={{ background: 'transparent', color: '#555', border: 'none', fontSize: 11, cursor: 'pointer' }}>
          {verifyState === 'failed' ? 'Retry' : 'Dismiss'}</button>
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
  const restored = useRef(loadSession());

  const [provider,     setProvider]     = useState(restored.current?.provider ?? 'venice');
  const [model,        setModel]        = useState(restored.current?.model ?? 'venice-uncensored');
  // Auto-save ON — generated files go to the sandbox immediately so you can download/push.
  const [autoRun,      setAutoRun]      = useState(false);
  const [autoApplyOn,  setAutoApplyOn]  = useState(restored.current?.autoApplyOn ?? true);
  const [autoVerifyOn, setAutoVerifyOn] = useState(false);
  const [applying,     setApplying]     = useState(false);
  const [appliedPaths, setAppliedPaths] = useState<Set<string>>(new Set());
  const [applyResults, setApplyResults] = useState<Array<{ path: string; ok: boolean; error?: string }>>([]);
  const [autoCtxFiles, setAutoCtxFiles] = useState<string[]>([]);
  const [searchHits,   setSearchHits]   = useState<SearchHit[]>([]);
  const [mobileTab,    setMobileTab]    = useState<MobileTab>('chat');
  const [pushing,      setPushing]      = useState(false);
  const [pushError,    setPushError]    = useState<string | null>(null);
  const [pushOk,       setPushOk]       = useState<string | null>(null);
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
  const [sessionKey,   setSessionKey]   = useState(0);
  const isMobile = useIsMobile();

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
      repoUrl: repo.repoUrl,
      sandboxId: repo.sandboxId,
      provider,
      model,
      autoApplyOn,
      messages: chatMessages.map(m => ({
        id: m.id, role: m.role, content: m.content, kind: m.kind,
      })),
      pendingChanges: repo.pendingChanges,
    });
  }, [
    repo.repoUrl, repo.sandboxId, repo.pendingChanges,
    provider, model, autoApplyOn, chatMessages,
  ]);

  const models = provider === 'venice' ? VENICE_MODELS : OR_MODELS;

  const handleProviderChange = (p: string) => {
    setProvider(p);
    setModel(p === 'venice' ? 'venice-uncensored' : 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free');
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

  const autoVerify = useAutoVerify(repo.root, termRef, chatRef, repo.applyChanges);

  const runVerify = useCallback(async () => {
    if (verifyingRef.current) return;
    verifyingRef.current = true;
    // Stay on Chat — don't yank the user to Terminal.
    try { await autoVerify.verify(); }
    finally { verifyingRef.current = false; }
  }, [autoVerify]);

  const handleApplyAndVerify = useCallback(async (files?: PendingChange[]) => {
    const results = await handleApply(files);
    if (results.some(r => r.ok) && autoVerifyOn && repo.root) {
      await runVerify();
    }
    return results;
  }, [handleApply, autoVerifyOn, repo.root, runVerify]);

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
          // Unknown size (seed) — try load; search hits respect size when present.
          if (h.size == null || h.size <= 0) return true;
          return h.size <= MAX_AUTO_FULL_FILE_CHARS;
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
    const enriched = await Promise.all(changes.map(async c => {
      if (!repo.root) return c;
      try {
        const headers: Record<string, string> = {};
        if (repo.sandboxId) headers['X-Sandbox-Session'] = repo.sandboxId;
        const url = repo.sandboxId
          ? `${API_URL}/file?path=${encodeURIComponent(c.path)}`
          : `${API_URL}/file?root=${encodeURIComponent(repo.root)}&path=${encodeURIComponent(c.path)}`;
        const res = await fetch(url, { headers });
        if (!res.ok) return c;
        const data = await res.json() as { content?: string };
        return { ...c, original: data.content };
      } catch { return c; }
    }));
    repo.setPendingChanges(enriched);
    setAppliedPaths(new Set());
    setApplyResults([]);
    // Don't reset verify state mid-loop — the retry injector owns that lifecycle.
    if (!verifyingRef.current) autoVerify.reset();

    // Default path: write immediately. During an active verify loop we only
    // write (the loop applies explicitly too) — never nest another verify().
    if (autoApplyOn && repo.root && enriched.length > 0) {
      if (verifyingRef.current) {
        await handleApply(enriched);
      } else {
        await handleApplyAndVerify(enriched);
      }
    }
  }, [repo, autoVerify, autoApplyOn, handleApply, handleApplyAndVerify]);

  const handleRunCode = useCallback((code: string, lang: string) => {
    // Run in the background terminal without stealing the Chat tab.
    // User can open Terminal when they want to see output.
    termRef.current?.runCode(code, lang);
  }, []);

  const handlePush = useCallback(async (token: string, message: string) => {
    if (!repo.sandboxId) {
      setPushError('Open a GitHub repo first.');
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
        message?: string; error?: string; detail?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.pushed) {
        setPushOk(
          `Pushed to GitHub${data.branch ? ` (${data.branch})` : ''}. ` +
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
  }, [repo.sandboxId, repo.pendingChanges, handleApply]);

  // ── Shared topbar ────────────────────────────────────────────────────────
  const topbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '6px 12px', borderBottom: '1px solid #1e1e1e', background: '#080808',
      flexShrink: 0 }}>
      <a href="/" style={{ color: '#888', fontSize: 11, textDecoration: 'none',
        whiteSpace: 'nowrap', padding: '2px 0' }}>← Chat</a>
      <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.08em',
        textTransform: 'uppercase', whiteSpace: 'nowrap' }}>// agent</span>
      {(repo.repoUrl || chatMessages.length > 0) && (
        <button type="button"
          onClick={() => {
            if (!confirm('Clear saved session (chat + drafts) on this device?')) return;
            clearSession();
            setChatMessages([]);
            repo.clearChanges();
            setPushError(null);
            setPushOk(null);
            setSessionKey(k => k + 1);
          }}
          style={{ background: 'transparent', color: '#555', border: '1px solid #222',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 10 }}>
          Clear session
        </button>
      )}
      <select value={provider} onChange={e => handleProviderChange(e.target.value)}
        style={{ background: '#111', color: '#e8e8e8', border: '1px solid #333',
          borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>
        <option value="venice">Venice</option>
        <option value="openrouter">OpenRouter</option>
      </select>
      <select value={model} onChange={e => setModel(e.target.value)}
        style={{ background: '#111', color: '#e8e8e8', border: '1px solid #333',
          borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 11,
          cursor: 'pointer', maxWidth: 200, flex: 1, minWidth: 0 }}>
        {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
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
        <label title="Off by default. Advanced: run project tests after saves."
          style={{ display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
          Auto-test <input type="checkbox" checked={autoVerifyOn} onChange={e => setAutoVerifyOn(e.target.checked)}
            style={{ accentColor: '#d4ff3f' }} />
        </label>
      </div>
    </div>
  );

  // ── apply-results banner (reused in both layouts) ─────────────────────────
  const applyBanner = applyResults.length > 0 ? (
    <div style={{ padding: '6px 10px', background: '#0c1a0c', borderBottom: '1px solid #1e3a1e',
      flexShrink: 0, fontSize: 11, lineHeight: 1.45 }}>
      <div style={{ color: '#8fbf6f', marginBottom: 4 }}>
        Saved to the cloud sandbox only — not GitHub, not your phone.
      </div>
      {applyResults.map(r => (
        <span key={r.path} style={{ marginRight: 10, color: r.ok ? '#8fbf6f' : '#ff6a6a' }}>
          {r.ok ? '✓' : '✗'} {r.path.split('/').pop()}
        </span>
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
          tree={repo.tree}
          contextFiles={repo.contextFiles}
          autoRun={autoRun}
          appliedPaths={appliedPaths}
          autoSelectedFiles={autoCtxFiles}
          initialMessages={sessionKey === 0 ? chatMessages : []}
          onMessagesChange={setChatMessages}
          onRunCode={handleRunCode}
          onFileChanges={handleFileChanges}
          onBeforeSend={handleAutoContext}
          searchHits={searchHits}
        />
      </div>
      <DiffPanel
        changes={repo.pendingChanges} applying={applying}
        appliedPaths={appliedPaths}
        canPush={!!repo.sandboxId && !!repo.repoUrl}
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
            setPushOk('Git commands copied — paste into Terminal. For push with auth, use Push to GitHub.');
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
      onOpenRepo={repo.openRepo} onAddToContext={repo.addToContext}
      onRemoveFromContext={repo.removeFromContext} onClearContext={repo.clearContext}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column',
      height: '100dvh', maxHeight: '100dvh', width: '100%', maxWidth: '100%',
      background: '#0a0a0a', fontFamily: '"JetBrains Mono",ui-monospace,monospace',
      overflow: 'hidden' }}>
      {topbar}

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
