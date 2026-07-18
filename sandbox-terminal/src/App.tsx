import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileTree }         from './FileTree.js';
import { ChatPane }         from './ChatPane.js';
import type { ChatHandle }  from './ChatPane.js';
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
import { looksLikeAuditRequest } from './agentParse.js';
import type { FileNode } from './types.js';

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
      <div style={{ fontSize: 11, color: '#888', marginBottom: 5 }}>Test command not detected — enter it:</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={cmd} onChange={e => setCmd(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && cmd.trim() && onSetCommand(cmd.trim())}
          placeholder="npm test / pytest / cargo test…"
          style={{ flex: 1, background: '#151515', color: '#e8e8e8', border: '1px solid #333',
            borderRadius: 4, padding: '4px 8px', fontFamily: 'inherit', fontSize: 12, outline: 'none' }} />
        <button onClick={() => cmd.trim() && onSetCommand(cmd.trim())}
          style={{ background: '#d4ff3f', color: '#0a0a0a', border: 'none', borderRadius: 4,
            padding: '4px 12px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
          Set & Run</button>
        <button onClick={onDismiss}
          style={{ background: 'transparent', color: '#555', border: '1px solid #222',
            borderRadius: 4, padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}>
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

  const [provider,     setProvider]     = useState('venice');
  const [model,        setModel]        = useState('venice-uncensored');
  const [autoRun,      setAutoRun]      = useState(true);
  const [autoApplyOn,  setAutoApplyOn]  = useState(true);
  const [autoVerifyOn, setAutoVerifyOn] = useState(true);
  const [applying,     setApplying]     = useState(false);
  const [appliedPaths, setAppliedPaths] = useState<Set<string>>(new Set());
  const [applyResults, setApplyResults] = useState<Array<{ path: string; ok: boolean; error?: string }>>([]);
  const [autoCtxFiles, setAutoCtxFiles] = useState<string[]>([]);
  const [searchHits,   setSearchHits]   = useState<SearchHit[]>([]);
  const [mobileTab,    setMobileTab]    = useState<MobileTab>('chat');
  const isMobile = useIsMobile();

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
    setMobileTab('terminal');
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
    // Cursor-style: search snippets first, then open a small budgeted working set
    // of SOURCE files. Never open dist/bundles — those blew the 131k window.
    const empty = { hits: [] as SearchHit[], files: new Map<string, string>() };
    if (!repo.root) {
      setAutoCtxFiles([]);
      setSearchHits([]);
      return empty;
    }
    const audit = looksLikeAuditRequest(query);
    const maxHits = audit ? 10 : 6;
    const maxFull = audit ? MAX_AUDIT_FULL_FILES : MAX_AUTO_FULL_FILES;
    try {
      let hits = await fetchAutoContext(repo.root, query, repo.sandboxId, maxHits);

      // Broad audits often have weak keywords — seed from the file tree.
      if (audit && hits.length < 3 && repo.tree.length > 0) {
        const seeds = pickAuditSeedPaths(flattenTreePaths(repo.tree), maxFull);
        const have = new Set(hits.map(h => h.path));
        for (const path of seeds) {
          if (have.has(path)) continue;
          hits.push({ path, score: 0, reason: 'audit seed', snippets: [] });
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
    setMobileTab('terminal');
    termRef.current?.runCode(code, lang);
  }, []);

  // ── Shared topbar ────────────────────────────────────────────────────────
  const topbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '6px 12px', borderBottom: '1px solid #1e1e1e', background: '#080808',
      flexShrink: 0 }}>
      <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.08em',
        textTransform: 'uppercase', whiteSpace: 'nowrap' }}>// agent</span>
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
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
          Auto-apply <input type="checkbox" checked={autoApplyOn} onChange={e => setAutoApplyOn(e.target.checked)}
            style={{ accentColor: '#d4ff3f' }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
          Auto-run <input type="checkbox" checked={autoRun} onChange={e => setAutoRun(e.target.checked)}
            style={{ accentColor: '#d4ff3f' }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
          Auto-verify <input type="checkbox" checked={autoVerifyOn} onChange={e => setAutoVerifyOn(e.target.checked)}
            style={{ accentColor: '#d4ff3f' }} />
        </label>
      </div>
    </div>
  );

  // ── apply-results banner (reused in both layouts) ─────────────────────────
  const applyBanner = applyResults.length > 0 ? (
    <div style={{ padding: '4px 10px', background: '#0c1a0c', borderBottom: '1px solid #1e3a1e',
      flexShrink: 0, fontSize: 11 }}>
      {applyResults.map(r => (
        <span key={r.path} style={{ marginRight: 10, color: r.ok ? '#8fbf6f' : '#ff6a6a' }}>
          {r.ok ? '✓' : '✗'} {r.path}
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
          ref={chatRef}
          repoRoot={repo.root}
          sandboxId={repo.sandboxId}
          provider={provider}
          model={model}
          tree={repo.tree}
          contextFiles={repo.contextFiles}
          autoRun={autoRun}
          appliedPaths={appliedPaths}
          autoSelectedFiles={autoCtxFiles}
          onRunCode={handleRunCode}
          onFileChanges={handleFileChanges}
          onBeforeSend={handleAutoContext}
          searchHits={searchHits}
        />
      </div>
      <DiffPanel
        changes={repo.pendingChanges} applying={applying}
        appliedPaths={appliedPaths} onApply={() => { void handleApplyAndVerify(); }}
        onDismiss={p => repo.setPendingChanges(repo.pendingChanges.filter(c => c.path !== p))}
        onDismissAll={repo.clearChanges}
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
            <SandboxTerminal ref={termRef} />
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
              <SandboxTerminal ref={termRef} />
            </div>
          </div>
          <div style={{ display: 'flex', flexShrink: 0, borderTop: '1px solid #1e1e1e',
            background: '#080808', paddingBottom: 'env(safe-area-inset-bottom)' }}
            className="mobile-tabs">
            {(['files','chat','terminal'] as MobileTab[]).map(t => (
              <button key={t} onClick={() => setMobileTab(t)}
                style={{ flex: 1, padding: '10px 0', background: mobileTab === t ? '#111' : 'transparent',
                  color: mobileTab === t ? '#d4ff3f' : '#555', border: 'none',
                  borderTop: mobileTab === t ? '2px solid #d4ff3f' : '2px solid transparent',
                  fontFamily: 'inherit', fontSize: 11, cursor: 'pointer',
                  textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {t === 'files' ? `Files${repo.tree.length ? ` (${repo.totalFiles})` : ''}` :
                 t === 'chat'  ? `Chat${repo.contextFiles.size ? ` (${repo.contextFiles.size})` : ''}` :
                 'Terminal'}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
