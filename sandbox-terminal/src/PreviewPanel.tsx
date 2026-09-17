/**
 * PreviewPanel — live preview of whatever dev server is running in the
 * sandbox. Calls POST /api/preview-start (lib/sandbox-api/preview-start.js),
 * which launches the command detached inside the sandbox VM and returns the
 * sandbox's public domain for that port (Vercel Sandbox's `sandbox.domain()`).
 * Rendered in a sandboxed iframe; "open in new tab" covers any dev server
 * that blocks framing.
 *
 * Leave the command box empty to auto-detect: npm run dev, npm start, or a
 * static `python3 -m http.server` for a plain HTML page.
 */

import React, { useEffect, useRef, useState } from 'react';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

interface Props {
  sandboxId: string | null;
  /** Auto-detected port from terminal output, if any — prefilled, editable. */
  detectedPort: number | null;
  /** Increment to auto-start (or restart) preview after files are written. */
  autoStartKey?: number;
}

export function PreviewPanel({ sandboxId, detectedPort, autoStartKey = 0 }: Props) {
  const [command, setCommand] = useState('');
  const [port, setPort] = useState<string>(String(detectedPort ?? 3000));
  const [url, setUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const lastKick = useRef(0);

  // Auto-detected port only ever raises the prefill — never fights a value
  // the user already typed in manually.
  const lastAutoPort = React.useRef<number | null>(null);
  if (detectedPort !== null && detectedPort !== lastAutoPort.current) {
    lastAutoPort.current = detectedPort;
    if (!url) setPort(String(detectedPort));
  }

  async function start() {
    if (!sandboxId) {
      setError('No active sandbox session. Start a blank project or open a GitHub URL first.');
      return;
    }
    const p = parseInt(port, 10);
    if (!Number.isInteger(p) || p <= 0 || p >= 65536) {
      setError('Enter a valid port number.');
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/preview-start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sandbox-Session': sandboxId },
        body: JSON.stringify({
          ...(command.trim() ? { command: command.trim() } : {}),
          port: p,
        }),
      });
      const data = await res.json() as { url?: string; error?: string; command?: string };
      if (!res.ok || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.command && !command.trim()) setCommand(data.command);
      setUrl(data.url);
      setReloadKey(k => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!autoStartKey || autoStartKey === lastKick.current) return;
    if (!sandboxId) return;
    lastKick.current = autoStartKey;
    void start();
    // start reads latest command/port/sandboxId from the closure of this render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartKey, sandboxId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, padding: 10, borderBottom: '1px solid #191D27', flexShrink: 0 }}>
        <input
          value={command}
          onChange={e => setCommand(e.target.value)}
          placeholder="auto (html → python server, else npm run dev)"
          style={{ flex: 1, background: '#12151D', color: '#ECEEF3', border: '1px solid #232838',
            borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 12 }}
        />
        <input
          value={port}
          onChange={e => setPort(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="port"
          style={{ width: 64, background: '#12151D', color: '#ECEEF3', border: '1px solid #232838',
            borderRadius: 4, padding: '6px 8px', fontFamily: 'inherit', fontSize: 12 }}
        />
        <button type="button" onClick={() => void start()} disabled={starting}
          style={{ background: '#FF3D8E', color: '#0B0D12', border: 'none', borderRadius: 4,
            padding: '6px 12px', cursor: starting ? 'default' : 'pointer', fontFamily: 'inherit',
            fontSize: 12, fontWeight: 700, opacity: starting ? 0.6 : 1, whiteSpace: 'nowrap' }}>
          {starting ? 'Starting…' : url ? 'Restart' : 'Start preview'}
        </button>
        {url && (
          <>
            <button type="button" onClick={() => setReloadKey(k => k + 1)}
              style={{ background: '#171B26', color: '#9198AA', border: '1px solid #232838',
                borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
              ↻
            </button>
            <a href={url} target="_blank" rel="noreferrer"
              style={{ background: '#171B26', color: '#9198AA', border: '1px solid #232838',
                borderRadius: 4, padding: '6px 10px', fontFamily: 'inherit', fontSize: 12,
                textDecoration: 'none', display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
              Open ↗
            </a>
          </>
        )}
      </div>

      {error && (
        <div style={{ padding: '8px 12px', color: '#ff9b9b', fontSize: 12, borderBottom: '1px solid #191D27' }}>
          {error}
        </div>
      )}

      {url ? (
        <iframe
          key={reloadKey}
          src={url}
          title="Live preview"
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
          style={{ flex: 1, minHeight: 0, border: 'none', background: '#fff' }}
        />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#656C7E', fontSize: 12, textAlign: 'center', padding: 20 }}>
          Write a file (or hit Start preview). Plain HTML pages are served automatically —
          no npm, no typed command.
        </div>
      )}
    </div>
  );
}
