/**
 * App — 3-panel layout:
 *   Left   (240px)  FileTree + context manager
 *   Center (flex)   ChatPane (agent chat)
 *   Right  (480px)  SandboxTerminal (xterm.js)
 *
 * Diff/Apply panel slides up from the bottom of the center column when the
 * LLM proposes file changes.
 */

import React, { useCallback, useRef, useState } from 'react';
import { FileTree }       from './FileTree.js';
import { ChatPane }       from './ChatPane.js';
import { DiffPanel }      from './DiffPanel.js';
import { SandboxTerminal, type TerminalHandle } from './Terminal.js';
import { useRepoContext } from './useRepoContext.js';
import type { PendingChange } from './useRepoContext.js';

export function App() {
  const termRef  = useRef<TerminalHandle>(null);
  const repo     = useRepoContext();
  const [autoRun,       setAutoRun]       = useState(true);
  const [applying,      setApplying]      = useState(false);
  const [appliedPaths,  setAppliedPaths]  = useState<Set<string>>(new Set());
  const [applyResults,  setApplyResults]  = useState<Array<{ path: string; ok: boolean; error?: string }>>([]);

  // When chat parses file changes out of the LLM reply
  const handleFileChanges = useCallback((changes: PendingChange[]) => {
    // Fetch the current on-disk version of each file so the diff panel can
    // show a real diff.  Failures (new files) are silently swallowed.
    const withOriginals = changes.map(async c => {
      if (!repo.root) return c;
      try {
        const res = await fetch(
          `http://localhost:3001/file?root=${encodeURIComponent(repo.root)}&path=${encodeURIComponent(c.path)}`
        );
        if (!res.ok) return c;
        const data = await res.json() as { content?: string };
        return { ...c, original: data.content };
      } catch { return c; }
    });
    Promise.all(withOriginals).then(repo.setPendingChanges);
    setAppliedPaths(new Set());
    setApplyResults([]);
  }, [repo]);

  const handleApply = useCallback(async () => {
    setApplying(true);
    try {
      const results = await repo.applyChanges();
      setApplyResults(results);
      const ok = new Set(results.filter(r => r.ok).map(r => r.path));
      setAppliedPaths(ok);
    } finally {
      setApplying(false);
    }
  }, [repo]);

  const handleDismiss = useCallback((path: string) => {
    repo.setPendingChanges(repo.pendingChanges.filter(c => c.path !== path));
  }, [repo]);

  const handleRunCode = useCallback((code: string, lang: string) => {
    termRef.current?.runCode(code, lang);
  }, []);

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
            repoRoot={repo.root}
            tree={repo.tree}
            totalFiles={repo.totalFiles}
            contextFiles={repo.contextFiles}
            loading={repo.loading}
            error={repo.error}
            onOpenRepo={repo.openRepo}
            onAddToContext={repo.addToContext}
            onRemoveFromContext={repo.removeFromContext}
            onClearContext={repo.clearContext}
          />
        </div>
      </div>

      {/* ── center: chat + diff panel ── */}
      <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid #1e1e1e',
        overflow: 'hidden' }}>
        {/* topbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 14px', borderBottom: '1px solid #1e1e1e', background: '#080808',
          flexShrink: 0 }}>
          <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.08em',
            textTransform: 'uppercase' }}>// sandbox agent</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 10, color: '#666', cursor: 'pointer', userSelect: 'none' }}>
            Auto-run snippets
            <input type="checkbox" checked={autoRun}
              onChange={e => setAutoRun(e.target.checked)}
              style={{ accentColor: '#d4ff3f' }} />
          </label>
        </div>

        {/* apply results banner */}
        {applyResults.length > 0 && (
          <div style={{ padding: '6px 12px', background: '#0c1a0c',
            borderBottom: '1px solid #1e3a1e', flexShrink: 0, fontSize: 11 }}>
            {applyResults.map(r => (
              <span key={r.path} style={{ marginRight: 12,
                color: r.ok ? '#8fbf6f' : '#ff6a6a' }}>
                {r.ok ? '✓' : '✗'} {r.path}
                {r.error && ` (${r.error})`}
              </span>
            ))}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <ChatPane
            repoRoot={repo.root}
            tree={repo.tree}
            contextFiles={repo.contextFiles}
            autoRun={autoRun}
            appliedPaths={appliedPaths}
            onRunCode={handleRunCode}
            onFileChanges={handleFileChanges}
          />
        </div>

        <DiffPanel
          changes={repo.pendingChanges}
          applying={applying}
          appliedPaths={appliedPaths}
          onApply={handleApply}
          onDismiss={handleDismiss}
          onDismissAll={repo.clearChanges}
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
