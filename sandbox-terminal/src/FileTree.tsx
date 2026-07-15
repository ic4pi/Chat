/**
 * FileTree — three-zone left panel:
 *   1. Repo path input + Open button
 *   2. Collapsible directory tree (click file = add to LLM context)
 *   3. Active context list (files currently sent to the model)
 */

import React, { useState, useCallback } from 'react';
import type { FileNode } from './types.js';

const EXT_COLOR: Record<string, string> = {
  '.ts': '#5b8dee', '.tsx': '#5b8dee', '.js': '#d4ff3f', '.jsx': '#d4ff3f',
  '.py': '#89ddff', '.rb': '#ff6a6a', '.go': '#89ddff', '.rs': '#ff9b9b',
  '.json': '#c792ea', '.yaml': '#c792ea', '.yml': '#c792ea', '.toml': '#c792ea',
  '.md': '#8fbf6f', '.sh': '#8fbf6f', '.bash': '#8fbf6f',
  '.css': '#89ddff', '.html': '#ff9b9b', '.sql': '#c792ea',
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
          onMouseEnter={e => (e.currentTarget.style.background = '#1a1a1a')}
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
      title={inCtx ? 'In context — click to remove' : 'Click to add to context'}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '2px 4px 2px 0', paddingLeft: 8 + depth * 14,
        cursor: 'pointer', fontSize: 12, borderRadius: 3,
        background: inCtx ? 'rgba(212,255,63,.08)' : 'transparent',
        borderLeft: inCtx ? '2px solid #d4ff3f' : '2px solid transparent',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = inCtx ? 'rgba(212,255,63,.12)' : '#1a1a1a')}
      onMouseLeave={e => (e.currentTarget.style.background = inCtx ? 'rgba(212,255,63,.08)' : '')}
    >
      <span style={{ color, fontSize: 10, fontWeight: 700, minWidth: 26,
        textAlign: 'right', opacity: .7 }}>
        {node.ext?.slice(1) ?? ''}
      </span>
      <span style={{ color: inCtx ? '#e8e8e8' : '#ccc', flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
      {inCtx && <span style={{ fontSize: 9, color: '#d4ff3f', opacity: .7 }}>●</span>}
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
  onOpenRepo:     (path: string) => void;
  onAddToContext: (relPath: string) => void;
  onRemoveFromContext: (relPath: string) => void;
  onClearContext: () => void;
}

export function FileTree({
  repoRoot, tree, totalFiles, contextFiles, loading, error,
  onOpenRepo, onAddToContext, onRemoveFromContext, onClearContext,
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
  const contextTokenEst = [...contextFiles.values()]
    .reduce((sum, c) => sum + Math.ceil(c.length / 4), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%',
      background: '#090909', fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>

      {/* ── repo path input ── */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #1e1e1e', flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: '#555', letterSpacing: '0.1em',
          textTransform: 'uppercase', marginBottom: 6 }}>// repo</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={inputPath}
            onChange={e => setInputPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleOpen()}
            placeholder="/path/to/your/repo"
            style={{ flex: 1, minWidth: 0, background: '#111', color: '#e8e8e8',
              border: '1px solid #2a2a2a', borderRadius: 4, padding: '4px 8px',
              fontFamily: 'inherit', fontSize: 11, outline: 'none' }} />
          <button onClick={handleOpen} disabled={loading || !inputPath.trim()}
            style={{ background: inputPath.trim() ? '#d4ff3f' : '#1a1a1a',
              color: inputPath.trim() ? '#0a0a0a' : '#444',
              border: 'none', borderRadius: 4, padding: '4px 10px',
              cursor: inputPath.trim() ? 'pointer' : 'default',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
            {loading ? '…' : 'Open'}
          </button>
        </div>
        {error && (
          <div style={{ marginTop: 5, fontSize: 11, color: '#ff6a6a' }}>✗ {error}</div>
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
            Enter an absolute path above to load a repo.
            <br /><br />
            Click any file to add it to the LLM context.
          </div>
        )}
        {tree.map(node => (
          <TreeNode key={node.path} node={node} depth={0}
            contextPaths={contextPaths} onClickFile={handleClick} />
        ))}
      </div>

      {/* ── context summary ── */}
      {contextFiles.size > 0 && (
        <div style={{ borderTop: '1px solid #1e1e1e', padding: '8px 10px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontSize: 10, color: '#d4ff3f', letterSpacing: '0.08em',
              textTransform: 'uppercase' }}>
              Context ({contextFiles.size})
            </span>
            <button onClick={onClearContext}
              style={{ background: 'transparent', color: '#555', border: 'none',
                fontSize: 10, cursor: 'pointer', padding: 0 }}>
              clear all
            </button>
          </div>
          {[...contextFiles.keys()].map(p => (
            <div key={p} style={{ display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', padding: '2px 0', gap: 6 }}>
              <span style={{ fontSize: 10, color: '#aaa', flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={p}>{p}</span>
              <button onClick={() => onRemoveFromContext(p)}
                style={{ background: 'transparent', color: '#555', border: 'none',
                  fontSize: 11, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
            </div>
          ))}
          <div style={{ marginTop: 5, fontSize: 10, color: '#444' }}>
            ~{contextTokenEst.toLocaleString()} tokens
          </div>
        </div>
      )}
    </div>
  );
}
