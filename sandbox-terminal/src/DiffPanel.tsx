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
    <div style={{ border: '1px solid #232838', borderRadius: 6,
      overflow: 'hidden', marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 8px', background: '#12151D',
        borderBottom: open ? '1px solid #191D27' : 'none', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setOpen(o => !o)}
          style={{ background: 'transparent', border: 'none',
            color: '#9198AA', cursor: 'pointer', fontSize: 15, padding: 0 }}>
          {open ? '▾' : '▸'}
        </button>
        <span style={{ fontSize: 15, color: '#ECEEF3', flex: 1, minWidth: 80,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={change.path}>
          {change.path}
        </span>
        {isNew && <span style={{ fontSize: 14, color: '#FF3D8E', border: '1px solid #FF3D8E',
          borderRadius: 3, padding: '1px 5px' }}>new</span>}
        <span style={{ fontSize: 14, color: '#656C7E' }}>{lines} lines</span>
        <span style={{ fontSize: 14, color: '#34D399' }}>+{added}</span>
        {removed > 0 && <span style={{ fontSize: 14, color: '#ff6a6a' }}>−{removed}</span>}
        <button type="button"
          onClick={() => downloadTextFile(change.path, change.content)}
          style={{ background: 'rgba(52,211,153,.16)', color: '#34D399', border: '1px solid rgba(52,211,153,.16)',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 14, fontWeight: 700 }}>
          Download
        </button>
        <button type="button"
          onClick={async () => {
            const ok = await copyText(change.content);
            if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
          }}
          style={{ background: 'transparent', color: copied ? '#FF3D8E' : '#9198AA',
            border: '1px solid #232838', borderRadius: 4, padding: '2px 8px',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss}
          style={{ background: 'transparent', border: 'none', color: '#656C7E',
            cursor: 'pointer', fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
      </div>

      {open && (
        <pre style={{ margin: 0, maxHeight: 140, overflowY: 'auto',
          fontSize: 16, lineHeight: 1.5, fontFamily: 'inherit' }}>
          {diff.map((line, i) => (
            <div key={i} style={{
              padding: '0 10px',
              background: line.kind === '+' ? 'rgba(143,191,111,.1)'
                : line.kind === '-' ? 'rgba(255,106,106,.1)' : 'transparent',
              color: line.kind === '+' ? '#34D399'
                : line.kind === '-' ? '#ff6a6a' : '#9198AA',
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
  /** Start Auto-test now — shown beside "Push locked" so a locked Push always has a way out. */
  onRunTest?:     () => void;
  /** A project is open: keep a slim Push bar even when nothing is waiting to be saved. */
  projectOpen?:   boolean;
}

const btnBase: React.CSSProperties = {
  borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 15, border: '1px solid #232838',
};

export function DiffPanel({
  changes, applying, appliedPaths, canPush, pushBlockedReason, pushing, pushError, pushOk,
  onApply, onDismiss, onDismissAll, onPush, onCopyGitCommands, onRunTest, projectOpen,
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

  // Saved work still needs a way to reach GitHub: with a project open and nothing unsaved, show just Push.
  if (changes.length === 0 && !projectOpen) return null;

  const pending = changes.filter(c => !appliedPaths.has(c.path));
  const allFiles = changes.map(c => ({ path: c.path, content: c.content }));
  const names = changes.map(c => c.path.split('/').pop() || c.path).slice(0, 3).join(', ');
  const more = changes.length > 3 ? ` +${changes.length - 3}` : '';

  return (
    <div data-testid="diff-panel" style={{
      borderTop: '1px solid #191D27', background: '#0B0D12', flexShrink: 0,
      fontFamily: '"JetBrains Mono",ui-monospace,monospace',
      maxHeight: expanded ? 'min(38vh, 320px)' : undefined,
      display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      {/* Always-visible compact action bar */}
      <div style={{ padding: '6px 10px', background: '#0B0D12',
        borderBottom: expanded ? '1px solid #191D27' : 'none', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {changes.length > 0 ? (
            <>
          <button type="button" onClick={() => setExpanded(e => !e)}
            data-testid="diff-expand-btn"
            title={expanded ? 'Collapse changes panel' : 'Expand to review diffs'}
            style={{ ...btnBase, background: expanded ? 'rgba(212,255,63,0.12)' : 'transparent',
              color: '#FF3D8E', borderColor: 'rgba(52,211,153,.16)', fontWeight: 700, padding: '4px 8px' }}>
            {expanded ? '▾' : '▸'} {changes.length} file{changes.length !== 1 ? 's' : ''}
          </button>
          <span style={{ fontSize: 14, color: '#656C7E', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={changes.map(c => c.path).join(', ')}>
            {names}{more}
          </span>
          <button type="button" onClick={onDismissAll}
            style={{ ...btnBase, background: 'transparent', color: '#656C7E', borderColor: '#232838' }}>
            Discard
          </button>
          <button type="button"
            onClick={() => { void downloadAllFiles(allFiles); }}
            data-testid="download-all-btn"
            style={{ ...btnBase, background: 'rgba(52,211,153,.16)', color: '#34D399',
              borderColor: 'rgba(52,211,153,.16)', fontWeight: 700 }}>
            Download
          </button>
          <button type="button" onClick={onApply} disabled={applying || pending.length === 0}
            data-testid="apply-btn"
            style={{ ...btnBase,
              background: pending.length > 0 ? '#232838' : '#191D27',
              color: pending.length > 0 ? '#ECEEF3' : '#323A50',
              cursor: pending.length > 0 ? 'pointer' : 'default' }}>
            {applying ? 'Saving…' : 'Save'}
          </button>
            </>
          ) : <span style={{ flex: 1 }} />}
          {canPush ? (
            <button type="button" onClick={() => { setShowPush(s => !s); setExpanded(true); }}
              data-testid="push-toggle-btn"
              style={{ ...btnBase, background: '#FF3D8E', color: '#0B0D12',
                border: 'none', fontWeight: 700, padding: '4px 12px' }}>
              {showPush ? 'Hide push' : 'Push'}
            </button>
          ) : (
            <>
              {onRunTest && pushBlockedReason && !/still verifying/.test(pushBlockedReason) && (
                <button type="button" onClick={onRunTest} data-testid="run-autotest-btn"
                  style={{ ...btnBase, background: '#FF3D8E', color: '#0B0D12', border: 'none',
                    fontWeight: 700, padding: '4px 12px' }}>
                  Run Auto-test
                </button>
              )}
              <span style={{ fontSize: 14, color: '#323A50', whiteSpace: 'nowrap' }}
                title={pushBlockedReason || 'Verify sandbox first'}>
                Push locked
              </span>
            </>
          )}
        </div>
        {!canPush && pushBlockedReason && (
          <div style={{ marginTop: 4, fontSize: 14, color: '#ffb4b4', lineHeight: 1.35 }}
            data-testid="push-blocked-reason">
            {pushBlockedReason}
          </div>
        )}
      </div>

      {expanded && (
        <div style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}>
          {(pushError || pushOk) && (
            <div data-testid="push-result" style={{ margin: '8px 10px 0', padding: '8px 10px', borderRadius: 6,
              fontSize: 15, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              background: pushError ? 'rgba(255,106,106,.12)' : 'rgba(52,211,153,.12)',
              border: `1px solid ${pushError ? '#ff6a6a' : '#34D399'}`,
              color: pushError ? '#ff9a9a' : '#34D399' }}>
              {pushError || pushOk}
            </div>
          )}
          {showPush && canPush && (
            <div style={{ margin: '8px 10px', padding: '8px 10px', background: '#0B0D12',
              border: '1px solid #232838', borderRadius: 6 }}>
              <div style={{ fontSize: 14, color: '#9198AA', marginBottom: 6, lineHeight: 1.4 }}>
                GitHub token with <code style={{ color: '#FF3D8E' }}>repo</code> scope.
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
                  background: '#12151D', color: '#ECEEF3', border: '1px solid #232838',
                  borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 16 }}
              />
              <input
                value={commitMsg}
                onChange={e => setCommitMsg(e.target.value)}
                placeholder="Commit message"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8,
                  background: '#12151D', color: '#ECEEF3', border: '1px solid #232838',
                  borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 16 }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button"
                  disabled={pushing || !token.trim()}
                  onClick={() => {
                    try {
                      localStorage.setItem('gh_push_token', token.trim());
                      sessionStorage.removeItem('gh_push_token');
                    } catch { /* ignore */ }
                    onPush(token.trim(), commitMsg.trim() || 'Apply agent changes from sandbox');
                  }}
                  style={{ flex: 1, background: token.trim() && !pushing ? '#FF3D8E' : '#191D27',
                    color: token.trim() && !pushing ? '#0B0D12' : '#656C7E',
                    border: 'none', borderRadius: 4, padding: '7px 14px',
                    cursor: token.trim() && !pushing ? 'pointer' : 'default',
                    fontFamily: 'inherit', fontSize: 16, fontWeight: 700 }}>
                  {pushing ? 'Pushing…' : 'Commit & push'}
                </button>
                {onCopyGitCommands && (
                  <button type="button" onClick={onCopyGitCommands}
                    style={{ ...btnBase, background: 'transparent', color: '#89ddff',
                      borderColor: '#232838' }}>
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
                    style={{ ...btnBase, background: 'transparent', color: '#9198AA' }}>
                    Clear token
                  </button>
                )}
              </div>
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
        <div style={{ padding: '4px 10px 6px', fontSize: 15, lineHeight: 1.35,
          color: pushError ? '#ff6a6a' : '#34D399' }}>
          {pushError || pushOk}
        </div>
      )}
    </div>
  );
}
