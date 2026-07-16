/**
 * App — 3-panel layout on desktop, tab-based on mobile.
 *
 * Desktop: Files (240px) | Chat (flex) | Terminal (420px)
 * Mobile:  Tabs → Files / Chat / Terminal  (full-screen each)
 *
 * Provider + model selectors live in the topbar so the agent
 * can reach the user's Venice/OpenRouter models.
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
// Provider / model config
// ---------------------------------------------------------------------------

const VENICE_MODELS = [
  { id: 'venice-uncensored',            label: 'Venice Uncensored (Dolphin-Mistral 24B)' },
  { id: 'qwen3-235b-a22b-instruct-2507',label: 'Qwen3 235B Instruct' },
  { id: 'llama-3.3-70b',                label: 'Llama 3.3 70B' },
  { id: 'mistral-31-24b',               label: 'Mistral 3.1 24B' },
  { id: 'hermes-3-llama-3.1-405b',      label: 'Hermes 3 405B' },
];

const OR_MODELS = [
  { id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', label: 'Dolphin-Venice 24B (free)' },
  { id: 'nousresearch/hermes-3-llama-3.1-405b:free', label: 'Hermes 3 405B (free)' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free',    label: 'Llama 3.3 70B (free)' },
];

// ---------------------------------------------------------------------------
// Auto-context helper
// ---------------------------------------------------------------------------

async function fetchAutoContext(root: string, query: string, sandboxId: string | null): Promise<string[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sandboxId) headers['X-Sandbox-Session'] = sandboxId;
  const res = await fetch(`${API_URL}/search`, {
    method: 'POST', headers,
    body: JSON.stringify({ root, query, maxFiles: 5 }),
  });
  if (!res.ok) return [];
  const data = await res.json() as { matches?: Array<{ path: string }> };
  return (data.matches ?? []).map(m => m.path);
}

// ---------------------------------------------------------------------------
// Mobile tab type
// ---------------------------------------------------------------------------
type Tab = 'files' | 'chat' | 'terminal';

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const termRef = useRef<TerminalHandle>(null);
  const chatRef = useRef<ChatHandle>(null);
  const repo    = useRepoContext();

  const [provider,      setProvider]      = useState('venice');
  const [model,         setModel]         = useState('venice-uncensored');
  const [autoRun,       setAutoRun]       = useState(true);
  const [autoVerifyOn,  setAutoVerifyOn]  = useState(true);
  const [applying,      setApplying]      = useState(false);
  const [appliedPaths,  setAppliedPaths]  = useState<Set<string>>(new Set());
  const [applyResults,  setApplyResults]  = useState<Array<{ path: string; ok: boolean; error?: string }>>([]);
  const [autoCtxFiles,  setAutoCtxFiles]  = useState<string[]>([]);
  const [activeTab,     setActiveTab]     = useState<Tab>('chat');

  const models = provider === 'venice' ? VENICE_MODELS : OR_MODELS;

  const handleProviderChange = useCallback((p: string) => {
    setProvider(p);
    setModel(p === 'venice' ? 'venice-uncensored' : 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free');
  }, []);

  // ── Apply ────────────────────────────────────────────────────────────────
  const handleApply = useCallback(async () => {
    setApplying(true);
    try {
      const results = await repo.applyChanges();
      setApplyResults(results);
      setAppliedPaths(new Set(results.filter(r => r.ok).map(r => r.path)));
      return results;
    } finally { setApplying(false); }
  }, [repo]);

  // ── Auto-verify ──────────────────────────────────────────────────────────
  const autoVerify = useAutoVerify(repo.root, termRef, chatRef, repo.applyChanges);

  const handleApplyAndVerify = useCallback(async () => {
    const results = await handleApply();
    if (results.some(r => r.ok) && autoVerifyOn && repo.root) {
      setActiveTab('terminal');
      await autoVerify.verify();
    }
  }, [handleApply, autoVerifyOn, repo.root, autoVerify]);

  // ── Auto-context ─────────────────────────────────────────────────────────
  const handleAutoContext = useCallback(async (query: string) => {
    if (!repo.root) { setAutoCtxFiles([]); return; }
    setAutoCtxFiles([]);
    try {
      const paths = await fetchAutoContext(repo.root, query, repo.sandboxId);
      for (const p of paths) await repo.addToContext(p);
      setAutoCtxFiles(paths);
    } catch { /* ignore */ }
  }, [repo]);

  // ── File changes from chat ───────────────────────────────────────────────
  const handleFileChanges = useCallback((changes: PendingChange[]) => {
    const withOriginals = changes.map(async c => {
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
    });
    Promise.all(withOriginals).then(repo.setPendingChanges);
    setAppliedPaths(new Set());
    setApplyResults([]);
    autoVerify.reset();
  }, [repo, autoVerify]);

  const handleRunCode = useCallback((code: string, lang: string) => {
    setActiveTab('terminal');
    termRef.current?.runCode(code, lang);
  }, []);

  const handleDismiss = useCallback((p: string) => {
    repo.setPendingChanges(repo.pendingChanges.filter(c => c.path !== p));
  }, [repo]);

  // ── Shared panel contents ────────────────────────────────────────────────
  const filePanel = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%',
      borderRight: '1px solid #1e1e1e', overflow: 'hidden' }}>
      <FileTree
        repoRoot={repo.root} tree={repo.tree} totalFiles={repo.totalFiles}
        contextFiles={repo.contextFiles} loading={repo.loading} error={repo.error}
        onOpenRepo={repo.openRepo}
        onAddToContext={repo.addToContext}
        onRemoveFromContext={repo.removeFromContext}
        onClearContext={repo.clearContext}
      />
    </div>
  );

  const chatPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {applyResults.length > 0 && (
        <div style={{ padding: '4px 10px', background: '#0c1a0c',
          borderBottom: '1px solid #1e3a1e', flexShrink: 0, fontSize: 11 }}>
          {applyResults.map(r => (
            <span key={r.path} style={{ marginRight: 10, color: r.ok ? '#8fbf6f' : '#ff6a6a' }}>
              {r.ok ? '✓' : '✗'} {r.path}
            </span>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
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
          onBeforeSend={async (query) => {
            if (repo.contextFiles.size === 0 && repo.root) {
              await handleAutoContext(query);
            } else {
              setAutoCtxFiles([]);
            }
          }}
        />
      </div>
      <DiffPanel
        changes={repo.pendingChanges} applying={applying}
        appliedPaths={appliedPaths} onApply={handleApplyAndVerify}
        onDismiss={handleDismiss} onDismissAll={repo.clearChanges}
      />
    </div>
  );

  const termPanel = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <SandboxTerminal ref={termRef} />
    </div>
  );

  // ── Topbar ───────────────────────────────────────────────────────────────
  const topbar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 12px', borderBottom: '1px solid #1e1e1e',
      background: '#080808', flexShrink: 0, flexWrap: 'wrap',
    }}>
      <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.08em',
        textTransform: 'uppercase', whiteSpace: 'nowrap' }}>// agent</span>

      {/* provider */}
      <select value={provider} onChange={e => handleProviderChange(e.target.value)}
        style={{ background: '#111', color: '#e8e8e8', border: '1px solid #333',
          borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>
        <option value="venice">Venice</option>
        <option value="openrouter">OpenRouter</option>
      </select>

      {/* model */}
      <select value={model} onChange={e => setModel(e.target.value)}
        style={{ background: '#111', color: '#e8e8e8', border: '1px solid #333',
          borderRadius: 4, padding: '3px 6px', fontFamily: 'inherit', fontSize: 11,
          cursor: 'pointer', maxWidth: 200 }}>
        {models.map(m => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>

      {/* sandbox indicator */}
      {repo.sandboxId && (
        <span style={{ fontSize: 9, color: '#555', whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }}
          title={repo.sandboxId}>
          ● {repo.sandboxId}
        </span>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none',
          whiteSpace: 'nowrap' }}>
          Auto-run <input type="checkbox" checked={autoRun}
            onChange={e => setAutoRun(e.target.checked)} style={{ accentColor: '#d4ff3f' }} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4,
          fontSize: 10, color: '#555', cursor: 'pointer', userSelect: 'none',
          whiteSpace: 'nowrap' }}>
          Auto-verify <input type="checkbox" checked={autoVerifyOn}
            onChange={e => setAutoVerifyOn(e.target.checked)} style={{ accentColor: '#d4ff3f' }} />
        </label>
      </div>
    </div>
  );

  // ── Tab bar (mobile only) ─────────────────────────────────────────────────
  const tabBar = (
    <div className="mobile-tabs">
      {(['files', 'chat', 'terminal'] as Tab[]).map(t => (
        <button key={t} onClick={() => setActiveTab(t)}
          style={{
            flex: 1, padding: '10px 0', background: activeTab === t ? '#111' : 'transparent',
            color: activeTab === t ? '#d4ff3f' : '#555',
            border: 'none', borderTop: activeTab === t ? '2px solid #d4ff3f' : '2px solid transparent',
            fontFamily: 'inherit', fontSize: 12, cursor: 'pointer', textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}>
          {t === 'files' ? `Files${repo.tree.length ? ' (' + repo.totalFiles + ')' : ''}` :
           t === 'chat'  ? `Chat${repo.contextFiles.size ? ' (' + repo.contextFiles.size + ')' : ''}` :
                           'Terminal'}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <style>{`
        .agent-desktop { display: grid; grid-template-columns: 240px 1fr 420px; height: 100vh; }
        .mobile-tabs   { display: none; }
        .mobile-panel  { display: none; }
        @media (max-width: 900px) {
          .agent-desktop { display: none; }
          .mobile-tabs   { display: flex; background: #080808; border-top: 1px solid #1e1e1e;
                           position: fixed; bottom: 0; left: 0; right: 0; z-index: 20; }
          .mobile-panel  { display: flex; flex-direction: column;
                           height: calc(100vh - 44px); overflow: hidden; }
        }
      `}</style>

      {/* ── Desktop layout ── */}
      <div style={{ height: '100vh', background: '#0a0a0a',
        fontFamily: '"JetBrains Mono",ui-monospace,monospace',
        display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {topbar}

        {/* 3-column grid */}
        <div className="agent-desktop" style={{ flex: 1, minHeight: 0 }}>
          {filePanel}
          <div style={{ display: 'flex', flexDirection: 'column',
            borderRight: '1px solid #1e1e1e', overflow: 'hidden' }}>
            {chatPanel}
          </div>
          {termPanel}
        </div>

        {/* Mobile: show active tab only */}
        <div className="mobile-panel">
          {activeTab === 'files'    && filePanel}
          {activeTab === 'chat'     && chatPanel}
          {activeTab === 'terminal' && termPanel}
        </div>
        {tabBar}
      </div>
    </>
  );
}
