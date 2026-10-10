/**
 * FileTree — three-zone left panel:
 *   1. Repo path input + Open button
 *   2. Collapsible directory tree (click file = open in viewer; the ● dot
 *      pins/unpins it into LLM context without opening anything)
 *   3. Active context list (files currently sent to the model)
 */

import { useState, useCallback, useEffect } from 'react';
import type { FileNode } from './types.js';

// Sandbox VMs take 15-30s to boot on first use — with no feedback that reads
// as a hang, not "working". Stage through real status text keyed off elapsed
// time so it's obvious progress is happening even though the backend only
// returns one response at the end (no streaming).
const BOOT_STAGES: [seconds: number, label: string][] = [
  [0,  'Starting…'],
  [3,  'Booting sandbox VM…'],
  [10, 'Installing Python…'],
  [18, 'Almost there…'],
  [30, 'Still going — first boot can take a minute…'],
];

function useStagedLabel(active: boolean, idleLabel: string) {
  const [label, setLabel] = useState(idleLabel);
  useEffect(() => {
    if (!active) {
      setLabel(idleLabel);
      return;
    }
    const start = Date.now();
    setLabel(BOOT_STAGES[0]![1]);
    const id = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      let current = BOOT_STAGES[0]![1];
      for (const [t, msg] of BOOT_STAGES) if (elapsed >= t) current = msg;
      setLabel(current);
    }, 1000);
    return () => clearInterval(id);
  }, [active, idleLabel]);
  return label;
}

const EXT_COLOR: Record<string, string> = {
  '.ts': '#5b8dee', '.tsx': '#5b8dee', '.js': '#FF3D8E', '.jsx': '#FF3D8E',
  '.py': '#89ddff', '.rb': '#ff6a6a', '.go': '#89ddff', '.rs': '#ff9b9b',
  '.json': '#c792ea', '.yaml': '#c792ea', '.yml': '#c792ea', '.toml': '#c792ea',
  '.md': '#34D399', '.sh': '#34D399', '.bash': '#34D399',
  '.css': '#89ddff', '.html': '#ff9b9b', '.sql': '#c792ea',
};

// ---------------------------------------------------------------------------
// TreeNode
// ---------------------------------------------------------------------------

function TreeNode({ node, depth, contextPaths, onClickFile, onViewFile }: {
  node: FileNode;
  depth: number;
  contextPaths: Set<string>;
  onClickFile: (n: FileNode) => void;
  onViewFile: (n: FileNode) => void;
}) {
  const [open, setOpen] = useState(depth < 2);

  if (node.type === 'dir') {
    return (
      <div>
        <div
          onClick={() => setOpen(o => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 4,
            padding: '2px 0 2px 4px', cursor: 'pointer', fontSize: 16,
            color: '#9198AA', paddingLeft: 8 + depth * 14,
            userSelect: 'none', borderRadius: 3 }}
          onMouseEnter={e => (e.currentTarget.style.background = '#191D27')}
          onMouseLeave={e => (e.currentTarget.style.background = '')}
        >
          <span style={{ fontSize: 14, opacity: .6 }}>{open ? '▾' : '▸'}</span>
          <span>{node.name}</span>
        </div>
        {open && node.children?.map(c => (
          <TreeNode key={c.path} node={c} depth={depth + 1}
            contextPaths={contextPaths} onClickFile={onClickFile} onViewFile={onViewFile} />
        ))}
      </div>
    );
  }

  const inCtx = contextPaths.has(node.path);
  const color  = EXT_COLOR[node.ext ?? ''] ?? '#9198AA';

  return (
    <div
      onClick={() => onViewFile(node)}
      title="Click to open — pin icon adds it to LLM context"
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '2px 4px 2px 0', paddingLeft: 8 + depth * 14,
        cursor: 'pointer', fontSize: 16, borderRadius: 3,
        background: inCtx ? 'rgba(212,255,63,.08)' : 'transparent',
        borderLeft: inCtx ? '2px solid #FF3D8E' : '2px solid transparent',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = inCtx ? 'rgba(212,255,63,.12)' : '#191D27')}
      onMouseLeave={e => (e.currentTarget.style.background = inCtx ? 'rgba(212,255,63,.08)' : '')}
    >
      <span style={{ color, fontSize: 14, fontWeight: 700, minWidth: 26,
        textAlign: 'right', opacity: .7 }}>
        {node.ext?.slice(1) ?? ''}
      </span>
      <span style={{ color: inCtx ? '#ECEEF3' : '#ECEEF3', flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.name}
      </span>
      <span
        onClick={e => { e.stopPropagation(); onClickFile(node); }}
        title={inCtx ? 'Pinned — click to unpin' : 'Pin to LLM context'}
        style={{ fontSize: 13, color: inCtx ? '#FF3D8E' : '#323A50', opacity: inCtx ? 1 : .6,
          padding: '0 4px', lineHeight: 1 }}
      >
        ●
      </span>
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
  /** Open a file in the read-only viewer (copy / download live there). */
  onViewFile:     (node: FileNode) => void;
}

export function FileTree({
  repoRoot, tree, totalFiles, contextFiles, loading, error,
  pythonReady, pythonDetail, rustReady, rustDetail, goReady, goDetail,
  onOpenRepo, onStartBlank, onAddToContext, onRemoveFromContext, onClearContext, onViewFile,
}: Props) {
  const [inputPath, setInputPath] = useState(repoRoot || '');
  // Both buttons share one `loading` flag from the hook — track which one was
  // actually pressed so the staged status text doesn't animate on the other.
  const [pendingAction, setPendingAction] = useState<'open' | 'blank' | null>(null);
  useEffect(() => {
    if (!loading) setPendingAction(null);
  }, [loading]);

  const handleOpen = useCallback(() => {
    const p = inputPath.trim();
    if (p) {
      setPendingAction('open');
      onOpenRepo(p);
    }
  }, [inputPath, onOpenRepo]);

  const handleClick = useCallback((node: FileNode) => {
    if (contextFiles.has(node.path)) onRemoveFromContext(node.path);
    else onAddToContext(node.path);
  }, [contextFiles, onAddToContext, onRemoveFromContext]);

  const contextPaths = new Set(contextFiles.keys());
  const blankLabel = useStagedLabel(loading && pendingAction === 'blank', 'Start blank project (no clone)');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%',
      background: '#0B0D12', fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>

      {/* ── repo path input ── */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #191D27', flexShrink: 0 }}>
        <div style={{ fontSize: 14, color: '#656C7E', letterSpacing: '0.1em',
          textTransform: 'uppercase', marginBottom: 6 }}>// project</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={inputPath}
            onChange={e => setInputPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleOpen()}
            placeholder="https://github.com/you/private-repo"
            style={{ flex: 1, minWidth: 0, background: '#12151D', color: '#ECEEF3',
              border: '1px solid #232838', borderRadius: 4, padding: '4px 8px',
              fontFamily: 'inherit', fontSize: 15, outline: 'none' }} />
          <button onClick={handleOpen} disabled={loading || !inputPath.trim()}
            style={{ background: inputPath.trim() ? '#FF3D8E' : '#191D27',
              color: inputPath.trim() ? '#0B0D12' : '#323A50',
              border: 'none', borderRadius: 4, padding: '4px 10px',
              cursor: inputPath.trim() ? 'pointer' : 'default',
              fontFamily: 'inherit', fontSize: 15, fontWeight: 700 }}>
            {loading ? '…' : 'Open'}
          </button>
        </div>
        {onStartBlank && (
          <button
            type="button"
            onClick={() => { setPendingAction('blank'); onStartBlank(); }}
            disabled={loading}
            style={{
              marginTop: 8, width: '100%',
              background: '#191D27', color: '#FF3D8E',
              border: '1px solid rgba(52,211,153,.16)', borderRadius: 4,
              padding: '6px 10px', cursor: loading ? 'default' : 'pointer',
              fontFamily: 'inherit', fontSize: 15, fontWeight: 700,
            }}
          >
            {blankLabel}
          </button>
        )}
        {error && (
          <div style={{ marginTop: 5, fontSize: 15, color: '#ff6a6a' }}>✗ {error}</div>
        )}
        <div style={{ marginTop: 6, fontSize: 14, color: '#656C7E', lineHeight: 1.4 }}>
          Private repos use the GitHub token from Push (saved in this browser).
          Paste one there once, then Open works without making the repo public.
        </div>
        {pythonReady != null && (
          <div style={{
            marginTop: 5, fontSize: 14, lineHeight: 1.4,
            color: pythonReady ? '#34D399' : '#ff6a6a',
          }}>
            {pythonReady ? '●' : '✗'} Python {pythonReady ? 'ready' : 'missing'}
            {pythonDetail ? ` — ${pythonDetail.slice(0, 80)}` : ''}
          </div>
        )}
        {rustReady != null && (
          <div style={{
            marginTop: 3, fontSize: 14, lineHeight: 1.4,
            color: rustReady ? '#34D399' : '#ff6a6a',
          }}>
            {rustReady ? '●' : '✗'} Rust {rustReady ? 'ready' : 'missing'}
            {rustDetail ? ` — ${rustDetail.slice(0, 80)}` : ''}
          </div>
        )}
        {goReady != null && (
          <div style={{
            marginTop: 3, fontSize: 14, lineHeight: 1.4,
            color: goReady ? '#34D399' : '#ff6a6a',
          }}>
            {goReady ? '●' : '✗'} Go {goReady ? 'ready' : 'missing'}
            {goDetail ? ` — ${goDetail.slice(0, 80)}` : ''}
          </div>
        )}
        {repoRoot && !loading && (
          <div style={{ marginTop: 4, fontSize: 14, color: '#656C7E' }}>
            {totalFiles} files
          </div>
        )}
      </div>

      {/* ── file tree ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {tree.length === 0 && !loading && !repoRoot && (
          <div style={{ padding: '12px 10px', fontSize: 15, color: '#323A50',
            lineHeight: 1.6 }}>
            Tap <b style={{ color: '#9198AA' }}>Start blank project</b> to begin without GitHub,
            or paste a repo URL and Open.
          </div>
        )}
        {tree.map(node => (
          <TreeNode key={node.path} node={node} depth={0}
            contextPaths={contextPaths} onClickFile={handleClick} onViewFile={onViewFile} />
        ))}
      </div>

      {/* ── optional pinned files (advanced; auto-pick does the real work) ── */}
      {contextFiles.size > 0 && (
        <div style={{ borderTop: '1px solid #191D27', padding: '8px 10px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontSize: 14, color: '#FF3D8E', letterSpacing: '0.08em',
              textTransform: 'uppercase' }}>
              Pinned ({contextFiles.size})
            </span>
            <button onClick={onClearContext}
              style={{ background: 'transparent', color: '#656C7E', border: 'none',
                fontSize: 14, cursor: 'pointer', padding: 0 }}>
              clear
            </button>
          </div>
          <div style={{ fontSize: 14, color: '#323A50', marginBottom: 6, lineHeight: 1.4 }}>
            Optional — the agent already finds files from your question.
          </div>
          {[...contextFiles.keys()].map(p => (
            <div key={p} style={{ display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', padding: '2px 0', gap: 6 }}>
              <span style={{ fontSize: 14, color: '#9198AA', flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={p}>{p.split('/').pop()}</span>
              <button onClick={() => onRemoveFromContext(p)}
                style={{ background: 'transparent', color: '#656C7E', border: 'none',
                  fontSize: 15, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
