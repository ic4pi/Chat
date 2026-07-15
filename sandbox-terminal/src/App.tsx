/**
 * App — 3-panel layout wired with:
 *   • Auto-context: before the user's first message, or when context is empty,
 *     grep the repo for relevant files and auto-load them.
 *   • Auto-verify: after applying file changes, detect + run the test command,
 *     inject failures back into chat, retry up to 3 times.
 */

import React, { useCallback, useRef, useState } from 'react';
import { FileTree }          from './FileTree.js';
import { ChatPane }          from './ChatPane.js';
import type { ChatHandle }   from './ChatPane.js';
import { DiffPanel }         from './DiffPanel.js';
import { SandboxTerminal }   from './Terminal.js';
import type { TerminalHandle } from './Terminal.js';
import { useRepoContext }    from './useRepoContext.js';
import { useAutoVerify }     from './useAutoVerify.js';
import type { PendingChange } from './useRepoContext.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Auto-context helper
// ---------------------------------------------------------------------------

async function fetchAutoContext(root: string, query: string): Promise<string[]> {
  const res = await fetch(`${API_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, query, maxFiles: 5 }),
  });
  if (!res.ok) return [];
  const data = await res.json() as { matches?: Array<{ path: string }> };
  return (data.matches ?? []).map(m => m.path);
}

// ---------------------------------------------------------------------------
// VerifyBanner — strip below the diff panel showing verify state
// ---------------------------------------------------------------------------

function VerifyBanner({
  verifyState, attempt, testCommand, askCommand,
  onRun, onSetCommand, onDismiss,
}: {
  verifyState:  string;
  attempt:      number;
  testCommand:  string | null;
  askCommand:   boolean;
  onRun:        () => void;
  onSetCommand: (cmd: string) => void;
  onDismiss:    () => void;
}) {
  const [customCmd, setCustomCmd] = useState('');

  if (verifyState === 'idle') return null;

  const color =
    verifyState === 'passed'  ? '#8fbf6f' :
    verifyState === 'failed'  ? '#ff6a6a' :
    verifyState === 'running' ? '#5b8dee' :
    verifyState === 'detecting' ? '#888' :
    '#d4ff3f'; // retry-N

  const label =
    verifyState === 'detecting'  ? 'Detecting test command…' :
    verifyState === 'running'    ? `Running: ${testCommand ?? '…'}` :
    verifyState === 'passed'     ? '✓ Tests passed' :
    verifyState === 'failed'     ? `✗ Tests failed after ${attempt} attempts` :
    `⟳ Tests failed — retrying (attempt ${attempt}/${3})`;

  if (askCommand) {
    return (
      <div style={{ padding: '8px 12px', background: '#0f0f0f',
        borderTop: '1px solid #2a2a2a', flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
          Could not detect a test command. Enter it manually:
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={customCmd} onChange={e => setCustomCmd(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && customCmd.trim() && onSetCommand(customCmd.trim())}
            placeholder="npm test / python3 -m pytest / cargo test…"
            style={{ flex: 1, background: '#151515', color: '#e8e8e8',
              border: '1px solid #333', borderRadius: 4, padding: '4px 8px',
              fontFamily: 'inherit', fontSize: 12, outline: 'none' }} />
          <button onClick={() => customCmd.trim() && onSetCommand(customCmd.trim())}
            style={{ background: '#d4ff3f', color: '#0a0a0a', border: 'none',
              borderRadius: 4, padding: '4px 12px', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
            Set & Run
          </button>
          <button onClick={onDismiss}
            style={{ background: 'transparent', color: '#555', border: '1px solid #222',
              borderRadius: 4, padding: '4px 8px', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11 }}>
            Skip
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10,
      padding: '6px 12px', background: '#0c0c0c',
      borderTop: '1px solid #1e1e1e', flexShrink: 0 }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%',
        background: color, flexShrink: 0,
        boxShadow: verifyState === 'running' ? `0 0 5px ${color}` : 'none' }} />
      <span style={{ fontSize: 11, color, flex: 1 }}>{label}</span>
      {verifyState === 'passed' && (
        <button onClick={onDismiss}
          style={{ background: 'transparent', color: '#555', border: 'none',
            fontSize: 11, cursor: 'pointer', padding: 0 }}>dismiss</button>
      )}
      {verifyState === 'failed' && (
        <>
          <button onClick={onRun}
            style={{ background: '#1a2a0a', color: '#8fbf6f', border: '1px solid #2a4a1a',
              borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11 }}>
            Retry
          </button>
          <button onClick={onDismiss}
            style={{ background: 'transparent', color: '#555', border: 'none',
              fontSize: 11, cursor: 'pointer', padding: 0 }}>dismiss</button>
        </>
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

  const [autoRun,        setAutoRun]        = useState(true);
  const [autoVerifyOn,   setAutoVerifyOn]   = useState(true);
  const [applying,       setApplying]       = useState(false);
  const [appliedPaths,   setAppliedPaths]   = useState<Set<string>>(new Set());
  const [applyResults,   setApplyResults]   = useState<Array<{ path: string; ok: boolean; error?: string }>>([]);
  const [autoCtxFiles,   setAutoCtxFiles]   = useState<string[]>([]);

  // ── Apply changes to disk ────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    setApplying(true);
    try {
      const results = await repo.applyChanges();
      setApplyResults(results);
      const ok = new Set(results.filter(r => r.ok).map(r => r.path));
      setAppliedPaths(ok);
      return results;
    } finally {
      setApplying(false);
    }
  }, [repo]);

  // ── Auto-verify loop ─────────────────────────────────────────────────────
  const autoVerify = useAutoVerify(
    repo.root,
    termRef,
    chatRef,
    // applyChanges callback — the verify loop calls this after each retry fix
    repo.applyChanges,
  );

  const handleApplyAndVerify = useCallback(async () => {
    const results = await handleApply();
    const anyOk = results.some(r => r.ok);
    if (anyOk && autoVerifyOn && repo.root) {
      await autoVerify.verify();
    }
  }, [handleApply, autoVerifyOn, repo.root, autoVerify]);

  // ── Auto-context ─────────────────────────────────────────────────────────
  const handleAutoContext = useCallback(async (query: string) => {
    if (!repo.root) { setAutoCtxFiles([]); return; }
    setAutoCtxFiles([]);
    try {
      const paths = await fetchAutoContext(repo.root, query);
      for (const p of paths) await repo.addToContext(p);
      setAutoCtxFiles(paths);
    } catch { /* silently ignore */ }
  }, [repo]);

  // ── File changes from chat ───────────────────────────────────────────────
  const handleFileChanges = useCallback((changes: PendingChange[]) => {
    const withOriginals = changes.map(async c => {
      if (!repo.root) return c;
      try {
        const res = await fetch(
          `${API_URL}/file?root=${encodeURIComponent(repo.root)}&path=${encodeURIComponent(c.path)}`
        );
        if (!res.ok) return c;
        const data = await res.json() as { content?: string };
        return { ...c, original: data.content };
      } catch { return c; }
    });
    Promise.all(withOriginals).then(repo.setPendingChanges);
    setAppliedPaths(new Set());
    setApplyResults([]);
    autoVerify.reset();
  }, [repo, autoVerify]);

  const handleRunCode = useCallback((code: string, lang: string) => {
    termRef.current?.runCode(code, lang);
  }, []);

  const handleDismiss = useCallback((p: string) => {
    repo.setPendingChanges(repo.pendingChanges.filter(c => c.path !== p));
  }, [repo]);

  // ── When user sends any message, clear auto-ctx highlight ────────────────
  const handleClearAutoCtx = useCallback(() => setAutoCtxFiles([]), []);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '240px 1fr 480px',
      height: '100vh',
      background: '#0a0a0a',
      fontFamily: '"JetBrains Mono",ui-monospace,monospace',
      overflow: 'hidden',
    }}>

      {/* ── left: file tree ── */}
      <div style={{ borderRight: '1px solid #1e1e1e', overflow: 'hidden',
        display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '6px 10px', borderBottom: '1px solid #1e1e1e',
          background: '#080808', flexShrink: 0 }}>
          <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.1em',
            textTransform: 'uppercase' }}>// files</span>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <FileTree
            repoRoot={repo.root} tree={repo.tree} totalFiles={repo.totalFiles}
            contextFiles={repo.contextFiles} loading={repo.loading} error={repo.error}
            onOpenRepo={repo.openRepo}
            onAddToContext={repo.addToContext}
            onRemoveFromContext={repo.removeFromContext}
            onClearContext={repo.clearContext}
          />
        </div>
      </div>

      {/* ── center: chat + diff + verify ── */}
      <div style={{ display: 'flex', flexDirection: 'column',
        borderRight: '1px solid #1e1e1e', overflow: 'hidden' }}>

        {/* topbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 14px', borderBottom: '1px solid #1e1e1e', background: '#080808',
          flexShrink: 0, gap: 12 }}>
          <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.08em',
            textTransform: 'uppercase' }}>// sandbox agent</span>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none' }}>
              Auto-run
              <input type="checkbox" checked={autoRun}
                onChange={e => setAutoRun(e.target.checked)}
                style={{ accentColor: '#d4ff3f' }} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none' }}>
              Auto-verify
              <input type="checkbox" checked={autoVerifyOn}
                onChange={e => setAutoVerifyOn(e.target.checked)}
                style={{ accentColor: '#d4ff3f' }} />
            </label>
          </div>
        </div>

        {/* apply results banner */}
        {applyResults.length > 0 && (
          <div style={{ padding: '5px 12px', background: '#0c1a0c',
            borderBottom: '1px solid #1e3a1e', flexShrink: 0, fontSize: 11 }}>
            {applyResults.map(r => (
              <span key={r.path} style={{ marginRight: 12,
                color: r.ok ? '#8fbf6f' : '#ff6a6a' }}>
                {r.ok ? '✓' : '✗'} {r.path}{r.error ? ` (${r.error})` : ''}
              </span>
            ))}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <ChatPane
            ref={chatRef}
            repoRoot={repo.root}
            tree={repo.tree}
            contextFiles={repo.contextFiles}
            autoRun={autoRun}
            appliedPaths={appliedPaths}
            autoSelectedFiles={autoCtxFiles}
            onRunCode={handleRunCode}
            onFileChanges={handleFileChanges}
            onBeforeSend={async (query) => {
              // Auto-context: load relevant files if context is empty
              if (repo.contextFiles.size === 0 && repo.root) {
                await handleAutoContext(query);
              } else {
                setAutoCtxFiles([]);
              }
            }}
          />
        </div>

        <DiffPanel
          changes={repo.pendingChanges}
          applying={applying}
          appliedPaths={appliedPaths}
          onApply={handleApplyAndVerify}
          onDismiss={handleDismiss}
          onDismissAll={repo.clearChanges}
        />

        <VerifyBanner
          verifyState={autoVerify.verifyState}
          attempt={autoVerify.attempt}
          testCommand={autoVerify.testCommand}
          askCommand={autoVerify.askCommand}
          onRun={autoVerify.verify}
          onSetCommand={(cmd) => {
            autoVerify.setCustomCommand(cmd);
            autoVerify.verify();
          }}
          onDismiss={autoVerify.reset}
        />
      </div>

      {/* ── right: terminal ── */}
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '6px 14px', borderBottom: '1px solid #1e1e1e',
          background: '#080808', flexShrink: 0 }}>
          <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.08em',
            textTransform: 'uppercase' }}>// sandbox terminal</span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <SandboxTerminal ref={termRef} />
        </div>
      </div>

    </div>
  );
}
