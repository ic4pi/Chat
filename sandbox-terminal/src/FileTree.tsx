/**
 * FileTree — three-zone left panel:
 *   1. Repo path input + Open button
 *   2. Collapsible directory tree (click file = add to LLM context)
 *   3. Active context list (files currently sent to the model)
 */

import React, { useState, useCallback } from 'react';
import type { FileNode } from './types.js';

const EXT_COLOR: Record<string, string> = {
  '.ts': '#5b8dee', '.tsx': '#5b8dee', '.js': '#C9963E', '.jsx': '#C9963E',
  '.py': '#8FD9C4', '.rb': '#ff6a6a', '.go': '#8FD9C4', '.rs': '#ff9b9b',
  '.json': '#c792ea', '.yaml': '#c792ea', '.yml': '#c792ea', '.toml': '#c792ea',
  '.md': '#6BCB9E', '.sh': '#6BCB9E', '.bash': '#6BCB9E',
  '.css': '#8FD9C4', '.html': '#ff9b9b', '.sql': '#c792ea',
};

// ---------------------------------------------------------------------------
// TreeNode
// ---------------------------------------------------------------------------

function TreeNode({ node, depth, contextPaths, onClickFile }: {
  node: FileNode;
  depth: number;
  contextPaths: Set<string>;
  onClickFile: (n: FileNode) => void;
}) {
  const [open, setOpen] = useState(depth < 2);

  if (node.type === 'dir') {
    return (
      <div>
        <div
          onClick={() => setOpen(o => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 4,
            padding: '2px 0 2px 4px', cursor: 'pointer', fontSize: 12,
            color: '#888', paddingLeft: 8 + depth * 14,
            userSelect: 'none', borderRadius: 3 }}
          onMouseEnter={e => (e.currentTarget.style.background = '#2C2018')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
        >
          <span style={{ fontSize: 10, opacity: .6 }}>{open ? '▾' : '▸'}</span>
          <span>{node.name}</span>
        </div>
        {open && node.children?.map(c => (
          <TreeNode key={c.path} node={c} depth={depth + 1}
            contextPaths={contextPaths} onClickFile={onClickFile} />
        ))}
      </div>
    );
  }

  const inCtx = contextPaths.has(node.path);
  const color  = EXT_COLOR[node.ext ?? ''] ?? '#aaa';

  return (
    <div
      onClick={() => onClickFile(node)}
      title={inCtx ? 'Pinned — click to unpin' : 'Optional: pin this file'}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '2px 4px 2px 0', paddingLeft: 8 + depth * 14,
        cursor: 'pointer', fontSize: 12, borderRadius: 3,
        background: inCtx ? 'rgba(212,255,63,.08)' : 'transparent',
        borderLeft: inCtx ? '2px solid #C9963E' : '2px solid transparent',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = inCtx ? 'rgba(212,255,63,.12)' : '#2C2018')}
      onMouseLeave={e => (e.currentTarget.style.background = inCtx ? 'rgba(212,255,63,.08)' : '')}
    >
      <span style={{ color, fontSize: 10, fontWeight: 700, minWidth: 26,
        textAlign: 'right', opacity: .7 }}>
        {node.ext?.slice(1) ?? ''}
      </span>
      <span style={{ color: inCtx ? '#EEE0C8' : '#ccc', flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
      {inCtx && <span style={{ fontSize: 9, color: '#C9963E', opacity: .7 }}>●</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileTree panel
// ---------------------------------------------------------------------------

interface Props {
  repoRoot:       string;
  tree:           FileNode[];
  totalFiles:     number;
  contextFiles:   Map<string, string>;
  loading:        boolean;
  error:          string | null;
  pythonReady?:   boolean | null;
  pythonDetail?:  string | null;
  rustReady?:     boolean | null;
  rustDetail?:    string | null;
  goReady?:       boolean | null;
  goDetail?:      string | null;
  onOpenRepo:     (path: string) => void;
  onStartBlank?:  () => void;
  onAddToContext: (relPath: string) => void;
  onRemoveFromContext: (relPath: string) => void;
  onClearContext: () => void;
}

export function FileTree({
  repoRoot, tree, totalFiles, contextFiles, loading, error,
  pythonReady, pythonDetail, rustReady, rustDetail, goReady, goDetail,
  onOpenRepo, onStartBlank, onAddToContext, onRemoveFromContext, onClearContext,
}: Props) {
  const [inputPath, setInputPath] = useState(repoRoot || '');

  const handleOpen = useCallback(() => {
    const p = inputPath.trim();
    if (p) onOpenRepo(p);
  }, [inputPath, onOpenRepo]);

  const handleClick = useCallback((node: FileNode) => {
    if (contextFiles.has(node.path)) onRemoveFromContext(node.path);
    else onAddToContext(node.path);
  }, [contextFiles, onAddToContext, onRemoveFromContext]);

  const contextPaths = new Set(contextFiles.keys());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%',
      background: '#090909', fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>

      {/* ── repo path input ── */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #35271C', flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: '#555', letterSpacing: '0.1em',
          textTransform: 'uppercase', marginBottom: 6 }}>// project</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={inputPath}
            onChange={e => setInputPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleOpen()}
            placeholder="GitHub URL (optional) — or start blank"
            style={{ flex: 1, minWidth: 0, background: '#111', color: '#EEE0C8',
              border: '1px solid #4A3624', borderRadius: 4, padding: '4px 8px',
              fontFamily: 'inherit', fontSize: 11, outline: 'none' }} />
          <button onClick={handleOpen} disabled={loading || !inputPath.trim()}
            style={{ background: inputPath.trim() ? '#C9963E' : '#2C2018',
              color: inputPath.trim() ? '#1C140F' : '#444',
              border: 'none', borderRadius: 4, padding: '4px 10px',
              cursor: inputPath.trim() ? 'pointer' : 'default',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
            {loading ? '…' : 'Open'}
          </button>
        </div>
        {onStartBlank && (
          <button
            type="button"
            onClick={() => onStartBlank()}
            disabled={loading}
            style={{
              marginTop: 8, width: '100%',
              background: '#2C2018', color: '#C9963E',
              border: '1px solid #2E5747', borderRadius: 4,
              padding: '6px 10px', cursor: loading ? 'default' : 'pointer',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
            }}
          >
            {loading ? 'Starting…' : 'Start blank project (no clone)'}
          </button>
        )}
        {error && (
          <div style={{ marginTop: 5, fontSize: 11, color: '#ff6a6a' }}>✗ {error}</div>
        )}
        {pythonReady != null && (
          <div style={{
            marginTop: 5, fontSize: 10, lineHeight: 1.4,
            color: pythonReady ? '#6BCB9E' : '#ff6a6a',
          }}>
            {pythonReady ? '●' : '✗'} Python {pythonReady ? 'ready' : 'missing'}
            {pythonDetail ? ` — ${pythonDetail.slice(0, 80)}` : ''}
          </div>
        )}
        {rustReady != null && (
          <div style={{
            marginTop: 3, fontSize: 10, lineHeight: 1.4,
            color: rustReady ? '#6BCB9E' : '#ff6a6a',
          }}>
            {rustReady ? '●' : '✗'} Rust {rustReady ? 'ready' : 'missing'}
            {rustDetail ? ` — ${rustDetail.slice(0, 80)}` : ''}
          </div>
        )}
        {goReady != null && (
          <div style={{
            marginTop: 3, fontSize: 10, lineHeight: 1.4,
            color: goReady ? '#6BCB9E' : '#ff6a6a',
          }}>
            {goReady ? '●' : '✗'} Go {goReady ? 'ready' : 'missing'}
            {goDetail ? ` — ${goDetail.slice(0, 80)}` : ''}
          </div>
        )}
        {repoRoot && !loading && (
          <div style={{ marginTop: 4, fontSize: 10, color: '#555' }}>
            {totalFiles} files
          </div>
        )}
      </div>

      {/* ── file tree ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {tree.length === 0 && !loading && !repoRoot && (
          <div style={{ padding: '12px 10px', fontSize: 11, color: '#444',
            lineHeight: 1.6 }}>
            Tap <b style={{ color: '#888' }}>Start blank project</b> to begin without GitHub,
            or paste a repo URL and Open.
          </div>
        )}
        {tree.map(node => (
          <TreeNode key={node.path} node={node} depth={0}
            contextPaths={contextPaths} onClickFile={handleClick} />
        ))}
      </div>

      {/* ── optional pinned files (advanced; auto-pick does the real work) ── */}
      {contextFiles.size > 0 && (
        <div style={{ borderTop: '1px solid #35271C', padding: '8px 10px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontSize: 10, color: '#C9963E', letterSpacing: '0.08em',
              textTransform: 'uppercase' }}>
              Pinned ({contextFiles.size})
            </span>
            <button onClick={onClearContext}
              style={{ background: 'transparent', color: '#555', border: 'none',
                fontSize: 10, cursor: 'pointer', padding: 0 }}>
              clear
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#444', marginBottom: 6, lineHeight: 1.4 }}>
            Optional — the agent already finds files from your question.
          </div>
          {[...contextFiles.keys()].map(p => (
            <div key={p} style={{ display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', padding: '2px 0', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#aaa', flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={p}>{p.split('/').pop()}</span>
              <button onClick={() => onRemoveFromContext(p)}
                style={{ background: 'transparent', color: '#555', border: 'none',
                  fontSize: 11, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
