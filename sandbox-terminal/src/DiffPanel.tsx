/**
 * DiffPanel — proposed file changes with real takeaway actions.
 * Collapsed by default so it does not bury the chat transcript.
 */

import React, { useState } from 'react';
import type { PendingChange } from './useRepoContext.js';
import { copyText, downloadAllFiles, downloadTextFile } from './downloadFile.js';

type DiffLine = { kind: '+' | '-' | ' '; text: string };

function computeDiff(original: string | undefined, next: string): DiffLine[] {
  if (!original) {
    return next.split('\n').map(text => ({ kind: '+', text }));
  }

  const oldLines = original.split('\n');
  const newLines = next.split('\n');

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

function FileDiff({ change, onDismiss }: {
  change: PendingChange;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const diff   = computeDiff(change.original, change.content);
  const added   = diff.filter(l => l.kind === '+').length;
  const removed = diff.filter(l => l.kind === '-').length;
  const isNew   = !change.original;
  const lines = change.content.split('\n').length;

  return (
    <div style={{ border: '1px solid #4A3624', borderRadius: 6,
      overflow: 'hidden', marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 8px', background: '#111',
        borderBottom: open ? '1px solid #35271C' : 'none', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setOpen(o => !o)}
          style={{ background: 'transparent', border: 'none',
            color: '#888', cursor: 'pointer', fontSize: 11, padding: 0 }}>
          {open ? '▾' : '▸'}
        </button>
        <span style={{ fontSize: 11, color: '#EEE0C8', flex: 1, minWidth: 80,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={change.path}>
          {change.path}
        </span>
        {isNew && <span style={{ fontSize: 10, color: '#C9963E', border: '1px solid #C9963E',
          borderRadius: 3, padding: '1px 5px' }}>new</span>}
        <span style={{ fontSize: 10, color: '#555' }}>{lines} lines</span>
        <span style={{ fontSize: 10, color: '#6BCB9E' }}>+{added}</span>
        {removed > 0 && <span style={{ fontSize: 10, color: '#ff6a6a' }}>−{removed}</span>}
        <button type="button"
          onClick={() => downloadTextFile(change.path, change.content)}
          style={{ background: '#1B2A22', color: '#6BCB9E', border: '1px solid #2E5747',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 10, fontWeight: 700 }}>
          Download
        </button>
        <button type="button"
          onClick={async () => {
            const ok = await copyText(change.content);
            if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
          }}
          style={{ background: 'transparent', color: copied ? '#C9963E' : '#888',
            border: '1px solid #333', borderRadius: 4, padding: '2px 8px',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 10 }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss}
          style={{ background: 'transparent', border: 'none', color: '#555',
            cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
      </div>

      {open && (
        <pre style={{ margin: 0, maxHeight: 140, overflowY: 'auto',
          fontSize: 11.5, lineHeight: 1.5, fontFamily: 'inherit' }}>
          {diff.map((line, i) => (
            <div key={i} style={{
              padding: '0 10px',
              background: line.kind === '+' ? 'rgba(143,191,111,.1)'
                : line.kind === '-' ? 'rgba(255,106,106,.1)' : 'transparent',
              color: line.kind === '+' ? '#6BCB9E'
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

interface Props {
  changes:        PendingChange[];
  applying:       boolean;
  appliedPaths:   Set<string>;
  canPush:        boolean;
  /** When set, show why Push is hidden/locked (unverified sandbox). */
  pushBlockedReason?: string | null;
  pushing:        boolean;
  pushError:      string | null;
  pushOk:         string | null;
  onApply:        () => void;
  onDismiss:      (path: string) => void;
  onDismissAll:   () => void;
  onPush:         (token: string, message: string) => void;
  onCopyGitCommands?: () => void;
}

const btnBase: React.CSSProperties = {
  borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 11, border: '1px solid #333',
};

export function DiffPanel({
  changes, applying, appliedPaths, canPush, pushBlockedReason, pushing, pushError, pushOk,
  onApply, onDismiss, onDismissAll, onPush, onCopyGitCommands,
}: Props) {
  // Collapsed by default — chat stays readable; expand to inspect diffs / push.
  const [expanded, setExpanded] = useState(false);
  const [showPush, setShowPush] = useState(false);
  const [token, setToken] = useState(() => {
    try {
      const persisted = localStorage.getItem('gh_push_token');
      if (persisted) return persisted;
      const sessionOnly = sessionStorage.getItem('gh_push_token');
      if (sessionOnly) {
        localStorage.setItem('gh_push_token', sessionOnly);
        sessionStorage.removeItem('gh_push_token');
        return sessionOnly;
      }
    } catch { /* private mode / blocked storage */ }
    return '';
  });
  const [commitMsg, setCommitMsg] = useState('Apply agent changes from sandbox');

  if (changes.length === 0) return null;

  const pending = changes.filter(c => !appliedPaths.has(c.path));
  const allFiles = changes.map(c => ({ path: c.path, content: c.content }));
  const names = changes.map(c => c.path.split('/').pop() || c.path).slice(0, 3).join(', ');
  const more = changes.length > 3 ? ` +${changes.length - 3}` : '';

  return (
    <div data-testid="diff-panel" style={{
      borderTop: '1px solid #35271C', background: '#1C140F', flexShrink: 0,
      fontFamily: '"JetBrains Mono",ui-monospace,monospace',
      maxHeight: expanded ? 'min(38vh, 320px)' : undefined,
      display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      {/* Always-visible compact action bar */}
      <div style={{ padding: '6px 10px', background: '#211812',
        borderBottom: expanded ? '1px solid #35271C' : 'none', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setExpanded(e => !e)}
            data-testid="diff-expand-btn"
            title={expanded ? 'Collapse changes panel' : 'Expand to review diffs'}
            style={{ ...btnBase, background: expanded ? 'rgba(212,255,63,0.12)' : 'transparent',
              color: '#C9963E', borderColor: '#3a4a18', fontWeight: 700, padding: '4px 8px' }}>
            {expanded ? '▾' : '▸'} {changes.length} file{changes.length !== 1 ? 's' : ''}
          </button>
          <span style={{ fontSize: 10, color: '#666', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={changes.map(c => c.path).join(', ')}>
            {names}{more}
          </span>
          <button type="button" onClick={onDismissAll}
            style={{ ...btnBase, background: 'transparent', color: '#555', borderColor: '#222' }}>
            Discard
          </button>
          <button type="button"
            onClick={() => { void downloadAllFiles(allFiles); }}
            data-testid="download-all-btn"
            style={{ ...btnBase, background: '#1B2A22', color: '#6BCB9E',
              borderColor: '#2E5747', fontWeight: 700 }}>
            Download
          </button>
          <button type="button" onClick={onApply} disabled={applying || pending.length === 0}
            data-testid="apply-btn"
            style={{ ...btnBase,
              background: pending.length > 0 ? '#222' : '#2C2018',
              color: pending.length > 0 ? '#EEE0C8' : '#444',
              cursor: pending.length > 0 ? 'pointer' : 'default' }}>
            {applying ? 'Saving…' : 'Save'}
          </button>
          {canPush ? (
            <button type="button" onClick={() => { setShowPush(s => !s); setExpanded(true); }}
              data-testid="push-toggle-btn"
              style={{ ...btnBase, background: '#C9963E', color: '#1C140F',
                border: 'none', fontWeight: 700, padding: '4px 12px' }}>
              {showPush ? 'Hide push' : 'Push'}
            </button>
          ) : (
            <span style={{ fontSize: 10, color: '#664', whiteSpace: 'nowrap' }}
              title={pushBlockedReason || 'Verify sandbox first'}>
              Push locked
            </span>
          )}
        </div>
        {!canPush && pushBlockedReason && (
          <div style={{ marginTop: 4, fontSize: 10, color: '#ffb4b4', lineHeight: 1.35 }}
            data-testid="push-blocked-reason">
            {pushBlockedReason}
          </div>
        )}
      </div>

      {expanded && (
        <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
          {showPush && canPush && (
            <div style={{ margin: '8px 10px', padding: '8px 10px', background: '#1C140F',
              border: '1px solid #4A3624', borderRadius: 6 }}>
              <div style={{ fontSize: 10, color: '#888', marginBottom: 6, lineHeight: 1.4 }}>
                GitHub token with <code style={{ color: '#C9963E' }}>repo</code> scope.
                Push re-runs sandbox checks and refuses on failure.
              </div>
              <input
                type="password"
                value={token}
                onChange={e => {
                  const next = e.target.value;
                  setToken(next);
                  try {
                    const trimmed = next.trim();
                    if (trimmed) localStorage.setItem('gh_push_token', trimmed);
                    else localStorage.removeItem('gh_push_token');
                  } catch { /* ignore */ }
                }}
                placeholder="ghp_… or github_pat_…"
                autoComplete="off"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6,
                  background: '#111', color: '#EEE0C8', border: '1px solid #333',
                  borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 12 }}
              />
              <input
                value={commitMsg}
                onChange={e => setCommitMsg(e.target.value)}
                placeholder="Commit message"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8,
                  background: '#111', color: '#EEE0C8', border: '1px solid #333',
                  borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 8, marginBottom: pushError || pushOk ? 8 : 0 }}>
                <button type="button"
                  disabled={pushing || !token.trim()}
                  onClick={() => {
                    try {
                      localStorage.setItem('gh_push_token', token.trim());
                      sessionStorage.removeItem('gh_push_token');
                    } catch { /* ignore */ }
                    onPush(token.trim(), commitMsg.trim() || 'Apply agent changes from sandbox');
                  }}
                  style={{ flex: 1, background: token.trim() && !pushing ? '#C9963E' : '#2C2018',
                    color: token.trim() && !pushing ? '#1C140F' : '#555',
                    border: 'none', borderRadius: 4, padding: '7px 14px',
                    cursor: token.trim() && !pushing ? 'pointer' : 'default',
                    fontFamily: 'inherit', fontSize: 12, fontWeight: 700 }}>
                  {pushing ? 'Pushing…' : 'Commit & push'}
                </button>
                {onCopyGitCommands && (
                  <button type="button" onClick={onCopyGitCommands}
                    style={{ ...btnBase, background: 'transparent', color: '#8FD9C4',
                      borderColor: '#234' }}>
                    Git cmds
                  </button>
                )}
                {token.trim() && (
                  <button type="button"
                    onClick={() => {
                      setToken('');
                      try {
                        localStorage.removeItem('gh_push_token');
                        sessionStorage.removeItem('gh_push_token');
                      } catch { /* ignore */ }
                    }}
                    style={{ ...btnBase, background: 'transparent', color: '#888' }}>
                    Clear token
                  </button>
                )}
              </div>
              {pushError && (
                <div style={{ fontSize: 11, color: '#ff6a6a', lineHeight: 1.4 }}>{pushError}</div>
              )}
              {pushOk && (
                <div style={{ fontSize: 11, color: '#6BCB9E', lineHeight: 1.4 }}>{pushOk}</div>
              )}
            </div>
          )}

          <div style={{ padding: '6px 10px 10px' }}>
            {changes.map(c => (
              <FileDiff key={c.path} change={c}
                onDismiss={() => onDismiss(c.path)} />
            ))}
          </div>
        </div>
      )}

      {/* Surface push result even when collapsed */}
      {!expanded && (pushError || pushOk) && (
        <div style={{ padding: '4px 10px 6px', fontSize: 11, lineHeight: 1.35,
          color: pushError ? '#ff6a6a' : '#6BCB9E' }}>
          {pushError || pushOk}
        </div>
      )}
    </div>
  );
}
