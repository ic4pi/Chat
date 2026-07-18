/**
 * DiffPanel — shows pending file changes from the LLM before they're written
 * to disk. Each file is collapsible. A single "Apply all to disk" button
 * writes everything; individual files can be dismissed.
 *
 * Renders a simple old/new diff by line — no external diff library needed.
 */

import React, { useState } from 'react';
import type { PendingChange } from './useRepoContext.js';

// ---------------------------------------------------------------------------
// Minimal line-diff (added / removed / unchanged)
// ---------------------------------------------------------------------------

type DiffLine = { kind: '+' | '-' | ' '; text: string };

function computeDiff(original: string | undefined, next: string): DiffLine[] {
  if (!original) {
    // New file — show all as added
    return next.split('\n').map(text => ({ kind: '+', text }));
  }

  const oldLines = original.split('\n');
  const newLines = next.split('\n');

  // Very simple LCS-based diff — good enough for small files
  // For large files we just show the new content as additions
  if (oldLines.length + newLines.length > 400) {
    return newLines.map(text => ({ kind: '+', text }));
  }

  const m = oldLines.length, n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i]![j] = oldLines[i] === newLines[j]
        ? 1 + (dp[i + 1]?.[j + 1] ?? 0)
        : Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);

  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      result.push({ kind: ' ', text: oldLines[i]! }); i++; j++;
    } else if (j < n && (i >= m || (dp[i]?.[j + 1] ?? 0) >= (dp[i + 1]?.[j] ?? 0))) {
      result.push({ kind: '+', text: newLines[j]! }); j++;
    } else {
      result.push({ kind: '-', text: oldLines[i]! }); i++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Single file diff view
// ---------------------------------------------------------------------------

function FileDiff({ change, onDismiss }: {
  change: PendingChange;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(true);
  const diff   = computeDiff(change.original, change.content);
  const added   = diff.filter(l => l.kind === '+').length;
  const removed = diff.filter(l => l.kind === '-').length;
  const isNew   = !change.original;

  return (
    <div style={{ border: '1px solid #2a2a2a', borderRadius: 6,
      overflow: 'hidden', marginBottom: 8 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', background: '#111',
        borderBottom: open ? '1px solid #1e1e1e' : 'none' }}>
        <button onClick={() => setOpen(o => !o)}
          style={{ background: 'transparent', border: 'none',
            color: '#888', cursor: 'pointer', fontSize: 11, padding: 0 }}>
          {open ? '▾' : '▸'}
        </button>
        <span style={{ fontSize: 11, color: '#e8e8e8', flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {change.path}
        </span>
        {isNew && <span style={{ fontSize: 10, color: '#d4ff3f', border: '1px solid #d4ff3f',
          borderRadius: 3, padding: '1px 5px' }}>new</span>}
        <span style={{ fontSize: 10, color: '#8fbf6f' }}>+{added}</span>
        {removed > 0 && <span style={{ fontSize: 10, color: '#ff6a6a' }}>−{removed}</span>}
        <button onClick={onDismiss}
          style={{ background: 'transparent', border: 'none', color: '#555',
            cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
      </div>

      {/* diff lines */}
      {open && (
        <pre style={{ margin: 0, maxHeight: 300, overflowY: 'auto',
          fontSize: 11.5, lineHeight: 1.5, fontFamily: 'inherit' }}>
          {diff.map((line, i) => (
            <div key={i} style={{
              padding: '0 10px',
              background: line.kind === '+' ? 'rgba(143,191,111,.1)'
                : line.kind === '-' ? 'rgba(255,106,106,.1)' : 'transparent',
              color: line.kind === '+' ? '#8fbf6f'
                : line.kind === '-' ? '#ff6a6a' : '#888',
            }}>
              <span style={{ opacity: .4, marginRight: 8, userSelect: 'none' }}>
                {line.kind}
              </span>
              {line.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffPanel
// ---------------------------------------------------------------------------

interface Props {
  changes:        PendingChange[];
  applying:       boolean;
  appliedPaths:   Set<string>;
  onApply:        () => void;
  onDismiss:      (path: string) => void;
  onDismissAll:   () => void;
}

export function DiffPanel({
  changes, applying, appliedPaths, onApply, onDismiss, onDismissAll,
}: Props) {
  if (changes.length === 0) return null;

  const pending = changes.filter(c => !appliedPaths.has(c.path));

  return (
    <div style={{ borderTop: '1px solid #1e1e1e', background: '#0a0a0a',
      fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>
      {/* sticky header */}
      <div style={{ padding: '8px 12px', background: '#0f0f0f',
        borderBottom: '1px solid #1e1e1e', position: 'sticky', top: 0, zIndex: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 10, color: '#d4ff3f', letterSpacing: '0.1em',
            textTransform: 'uppercase' }}>
            {pending.length} proposed change{pending.length !== 1 ? 's' : ''}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onDismissAll}
              style={{ background: 'transparent', color: '#555',
                border: '1px solid #222', borderRadius: 4,
                padding: '4px 10px', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 11 }}>
              Discard
            </button>
            <button onClick={onApply} disabled={applying || pending.length === 0}
              data-testid="apply-btn"
              style={{ background: pending.length > 0 ? '#d4ff3f' : '#1a1a1a',
                color: pending.length > 0 ? '#0a0a0a' : '#444',
                border: 'none', borderRadius: 4, padding: '4px 14px',
                cursor: pending.length > 0 ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
              {applying ? 'Saving…' : 'Save to sandbox'}
            </button>
          </div>
        </div>
        <div style={{ marginTop: 6, fontSize: 10, color: '#666', lineHeight: 1.4 }}>
          Draft only until you save. Saves to the cloud sandbox — not GitHub, not your phone.
        </div>
      </div>

      {/* file diffs */}
      <div style={{ padding: '8px 12px', maxHeight: 360, overflowY: 'auto' }}>
        {changes.map(c => (
          <FileDiff key={c.path} change={c}
            onDismiss={() => onDismiss(c.path)} />
        ))}
      </div>
    </div>
  );
}
