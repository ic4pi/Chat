/**
 * Tokens section of Settings. Browser-only, like the API keys.
 *
 * The GitHub token lives under the same `gh_push_token` key Push, auto-backup
 * and private-repo clone already read, so saving it here is all it takes.
 * Other tokens (Vercel, Render, …) are stored by name in `workspace_tokens_v1`.
 */

import React, { useState } from 'react';

export const GH_TOKEN_KEY = 'gh_push_token';
export const GH_TOKEN_EVENT = 'gh-token-changed';
const EXTRA_KEY = 'workspace_tokens_v1';
const PRESETS = ['Vercel', 'Render', 'Supabase'];

function readGh(): string {
  try { return localStorage.getItem(GH_TOKEN_KEY) || ''; } catch { return ''; }
}
function writeGh(v: string): void {
  try {
    const t = v.trim();
    if (t) localStorage.setItem(GH_TOKEN_KEY, t); else localStorage.removeItem(GH_TOKEN_KEY);
    sessionStorage.removeItem(GH_TOKEN_KEY);
    window.dispatchEvent(new Event(GH_TOKEN_EVENT));
  } catch { /* blocked storage */ }
}
function readExtra(): Record<string, string> {
  try {
    const o = JSON.parse(localStorage.getItem(EXTRA_KEY) || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}
function writeExtra(o: Record<string, string>): void {
  try { localStorage.setItem(EXTRA_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

/** Read a saved extra token by name (e.g. getSavedToken('Vercel')). */
export function getSavedToken(name: string): string {
  return readExtra()[name] || '';
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', padding: '7px 10px', fontFamily: 'inherit', fontSize: 14,
};

function TokenField({ label, value, onChange, onRemove }: {
  label: string; value: string; onChange: (v: string) => void; onRemove?: () => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--text-muted)' }}>
      <span style={{ display: 'flex', justifyContent: 'space-between' }}>
        {label}
        {onRemove && (
          <button type="button" onClick={onRemove}
            style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 12 }}>
            remove
          </button>
        )}
      </span>
      <input type="password" autoComplete="off" className="ws-input" value={value}
        placeholder={`${label} token`} onChange={e => onChange(e.target.value)} style={inputStyle} />
    </label>
  );
}

export function TokenSettings() {
  const [gh, setGh] = useState(readGh);
  const [extra, setExtra] = useState(readExtra);
  const [newName, setNewName] = useState('');

  const setExtraToken = (name: string, v: string) => {
    const next = { ...extra, [name]: v };
    setExtra(next); writeExtra(next);
  };
  const removeExtra = (name: string) => {
    const { [name]: _gone, ...rest } = extra;
    setExtra(rest); writeExtra(rest);
  };
  const addExtra = (name: string) => {
    const n = name.trim();
    if (!n || n in extra || n === 'GitHub') return;
    setExtraToken(n, '');
    setNewName('');
  };

  const missingPresets = PRESETS.filter(p => !(p in extra));

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <TokenField label="GitHub (repo scope)" value={gh} onChange={v => { setGh(v); writeGh(v); }} />
      {Object.keys(extra).map(name => (
        <TokenField key={name} label={name} value={extra[name] || ''}
          onChange={v => setExtraToken(name, v)} onRemove={() => removeExtra(name)} />
      ))}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {missingPresets.map(p => (
          <button key={p} type="button" className="ws-btn" onClick={() => addExtra(p)}
            style={{ background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
            + {p}
          </button>
        ))}
      </div>
      <form onSubmit={e => { e.preventDefault(); addExtra(newName); }} style={{ display: 'flex', gap: 6 }}>
        <input className="ws-input" value={newName} onChange={e => setNewName(e.target.value)}
          placeholder="Add another (name)" style={{ ...inputStyle, flex: 1 }} />
        <button type="submit" className="ws-btn" disabled={!newName.trim()}
          style={{ background: 'var(--accent)', color: '#0B0D12', border: 'none',
            borderRadius: 'var(--radius)', padding: '0 14px', cursor: newName.trim() ? 'pointer' : 'default',
            opacity: newName.trim() ? 1 : 0.5 }}>
          Add
        </button>
      </form>
    </div>
  );
}
