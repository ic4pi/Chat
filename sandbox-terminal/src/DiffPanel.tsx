/**
 * DiffPanel — proposed file changes with real takeaway actions:
 *   Download (complete file), Copy, Save to sandbox, Push to GitHub.
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
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const diff   = computeDiff(change.original, change.content);
  const added   = diff.filter(l => l.kind === '+').length;
  const removed = diff.filter(l => l.kind === '-').length;
  const isNew   = !change.original;
  const lines = change.content.split('\n').length;

  return (
    <div style={{ border: '1px solid #2a2a2a', borderRadius: 6,
      overflow: 'hidden', marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', background: '#111',
        borderBottom: open ? '1px solid #1e1e1e' : 'none', flexWrap: 'wrap' }}>
        <button onClick={() => setOpen(o => !o)}
          style={{ background: 'transparent', border: 'none',
            color: '#888', cursor: 'pointer', fontSize: 11, padding: 0 }}>
          {open ? '▾' : '▸'}
        </button>
        <span style={{ fontSize: 11, color: '#e8e8e8', flex: 1, minWidth: 80,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={change.path}>
          {change.path}
        </span>
        {isNew && <span style={{ fontSize: 10, color: '#d4ff3f', border: '1px solid #d4ff3f',
          borderRadius: 3, padding: '1px 5px' }}>new</span>}
        <span style={{ fontSize: 10, color: '#555' }}>{lines} lines</span>
        <span style={{ fontSize: 10, color: '#8fbf6f' }}>+{added}</span>
        {removed > 0 && <span style={{ fontSize: 10, color: '#ff6a6a' }}>−{removed}</span>}
        <button type="button"
          onClick={() => downloadTextFile(change.path, change.content)}
          style={{ background: '#1a2a0a', color: '#8fbf6f', border: '1px solid #2a4a1a',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 10, fontWeight: 700 }}>
          Download
        </button>
        <button type="button"
          onClick={async () => {
            const ok = await copyText(change.content);
            if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
          }}
          style={{ background: 'transparent', color: copied ? '#d4ff3f' : '#888',
            border: '1px solid #333', borderRadius: 4, padding: '2px 8px',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 10 }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={onDismiss}
          style={{ background: 'transparent', border: 'none', color: '#555',
            cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
      </div>

      {open && (
        <pre style={{ margin: 0, maxHeight: 220, overflowY: 'auto',
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

interface Props {
  changes:        PendingChange[];
  applying:       boolean;
  appliedPaths:   Set<string>;
  canPush:        boolean;
  pushing:        boolean;
  pushError:      string | null;
  pushOk:         string | null;
  onApply:        () => void;
  onDismiss:      (path: string) => void;
  onDismissAll:   () => void;
  onPush:         (token: string, message: string) => void;
}

export function DiffPanel({
  changes, applying, appliedPaths, canPush, pushing, pushError, pushOk,
  onApply, onDismiss, onDismissAll, onPush,
}: Props) {
  const [showPush, setShowPush] = useState(false);
  const [token, setToken] = useState(() => sessionStorage.getItem('gh_push_token') || '');
  const [commitMsg, setCommitMsg] = useState('Apply agent changes from sandbox');

  if (changes.length === 0) return null;

  const pending = changes.filter(c => !appliedPaths.has(c.path));
  const allFiles = changes.map(c => ({ path: c.path, content: c.content }));

  return (
    <div style={{ borderTop: '1px solid #1e1e1e', background: '#0a0a0a',
      fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>
      <div style={{ padding: '8px 12px', background: '#0f0f0f',
        borderBottom: '1px solid #1e1e1e', position: 'sticky', top: 0, zIndex: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: '#d4ff3f', letterSpacing: '0.1em',
            textTransform: 'uppercase' }}>
            {changes.length} new file{changes.length !== 1 ? 's' : ''}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" onClick={onDismissAll}
              style={{ background: 'transparent', color: '#555',
                border: '1px solid #222', borderRadius: 4,
                padding: '4px 10px', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 11 }}>
              Discard
            </button>
            <button type="button"
              onClick={() => { void downloadAllFiles(allFiles); }}
              data-testid="download-all-btn"
              style={{ background: '#1a2a0a', color: '#8fbf6f',
                border: '1px solid #2a4a1a', borderRadius: 4, padding: '4px 10px',
                cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
              Download all
            </button>
            <button type="button" onClick={onApply} disabled={applying || pending.length === 0}
              data-testid="apply-btn"
              style={{ background: pending.length > 0 ? '#222' : '#1a1a1a',
                color: pending.length > 0 ? '#e8e8e8' : '#444',
                border: '1px solid #333', borderRadius: 4, padding: '4px 10px',
                cursor: pending.length > 0 ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 11 }}>
              {applying ? 'Saving…' : 'Save to sandbox'}
            </button>
            {canPush && (
              <button type="button" onClick={() => setShowPush(s => !s)}
                data-testid="push-toggle-btn"
                style={{ background: '#d4ff3f', color: '#0a0a0a',
                  border: 'none', borderRadius: 4, padding: '4px 12px',
                  cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
                {showPush ? 'Hide push' : 'Push to GitHub'}
              </button>
            )}
          </div>
        </div>
        <div style={{ marginTop: 6, fontSize: 10, color: '#888', lineHeight: 1.45 }}>
          <strong style={{ color: '#ccc' }}>Download</strong> saves the complete file to your phone/computer.
          {' '}<strong style={{ color: '#ccc' }}>Push</strong> commits and sends it to your GitHub repo (needs a token).
        </div>

        {showPush && canPush && (
          <div style={{ marginTop: 10, padding: '10px', background: '#0a0a0a',
            border: '1px solid #2a2a2a', borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: '#ccc', marginBottom: 8, lineHeight: 1.45 }}>
              Paste a GitHub token with <code style={{ color: '#d4ff3f' }}>repo</code> access
              (github.com → Settings → Developer settings → Personal access tokens).
              Used once for this push — kept only in this browser tab.
            </div>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="ghp_… or github_pat_…"
              autoComplete="off"
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6,
                background: '#111', color: '#e8e8e8', border: '1px solid #333',
                borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 12 }}
            />
            <input
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              placeholder="Commit message"
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8,
                background: '#111', color: '#e8e8e8', border: '1px solid #333',
                borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 12 }}
            />
            <button type="button"
              disabled={pushing || !token.trim()}
              onClick={() => {
                sessionStorage.setItem('gh_push_token', token.trim());
                onPush(token.trim(), commitMsg.trim() || 'Apply agent changes from sandbox');
              }}
              style={{ background: token.trim() && !pushing ? '#d4ff3f' : '#1a1a1a',
                color: token.trim() && !pushing ? '#0a0a0a' : '#555',
                border: 'none', borderRadius: 4, padding: '7px 14px',
                cursor: token.trim() && !pushing ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 12, fontWeight: 700, width: '100%' }}>
              {pushing ? 'Pushing to GitHub…' : 'Commit & push'}
            </button>
            {pushError && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#ff6a6a', lineHeight: 1.4 }}>
                {pushError}
              </div>
            )}
            {pushOk && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#8fbf6f', lineHeight: 1.4 }}>
                {pushOk}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: '8px 12px', maxHeight: 'min(32vh, 260px)', overflowY: 'auto' }}>
        {changes.map(c => (
          <FileDiff key={c.path} change={c}
            onDismiss={() => onDismiss(c.path)} />
        ))}
      </div>
    </div>
  );
}
