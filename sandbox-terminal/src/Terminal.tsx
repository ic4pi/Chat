/**
 * SandboxTerminal — xterm.js terminal wired to the sandbox-runner SSE backend.
 *
 * Two calling modes:
 *   1. Manual:  user types a raw shell command in the built-in input bar → POST /run
 *   2. Imperative: parent calls terminalRef.current.runCode(code, language) → POST /run-code
 *
 * SSE contract (both /run and /run-code):
 *   event: status   data: "<msg>"   — status lines (dim cyan)
 *   event: stdout   data: "<chunk>" — raw stdout (white)
 *   event: stderr   data: "<chunk>" — raw stderr (bright red)
 *   event: exit     data: "<code>"  — process exit code (green=0, red≠0)
 *   event: timeout  data: "<msg>"   — timeout banner (yellow)
 *   event: error    data: "<msg>"   — error banner (red), NOT a silent hang
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

type RunStatus = 'idle' | 'connecting' | 'streaming' | 'done' | 'error' | 'cancelled';

declare global {
  interface Window { __sandboxTerm?: Terminal; }
}

export interface TerminalHandle {
  /** Run a code snippet by language — calls POST /run-code */
  runCode: (code: string, language: string) => void;
  /** Kill any running command */
  cancel: () => void;
}

// ── xterm theme ──────────────────────────────────────────────────────────────
const THEME = {
  background: '#0a0a0a', foreground: '#e8e8e8',
  cursor: '#d4ff3f', cursorAccent: '#0a0a0a',
  selectionBackground: 'rgba(212,255,63,.2)',
  black: '#0a0a0a', red: '#ff6a6a', green: '#8fbf6f', yellow: '#d4ff3f',
  blue: '#5b8dee', magenta: '#c792ea', cyan: '#89ddff', white: '#e8e8e8',
  brightBlack: '#555', brightRed: '#ff9b9b', brightGreen: '#b5d89b',
  brightYellow: '#e8ff8a', brightBlue: '#82aaff', brightMagenta: '#dbb0f0',
  brightCyan: '#aadeff', brightWhite: '#ffffff',
};

// ── SSE parser ───────────────────────────────────────────────────────────────
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; text: string }> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const messages = buf.split('\n\n');
      buf = messages.pop() ?? '';
      for (const msg of messages) {
        let type = 'message'; let raw = '';
        for (const line of msg.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7).trim();
          else if (line.startsWith('data: ')) raw = line.slice(6).trim();
        }
        if (!raw) continue;
        let text: string;
        try { text = JSON.parse(raw) as string; } catch { text = raw; }
        yield { type, text };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── component ────────────────────────────────────────────────────────────────
export const SandboxTerminal = forwardRef<TerminalHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const abortRef     = useRef<AbortController | null>(null);

  const [command,   setCommand]   = useState('');
  const [status,    setStatus]    = useState<RunStatus>('idle');
  const [exitCode,  setExitCode]  = useState<number | null>(null);
  const [history,   setHistory]   = useState<string[]>([]);
  const [histIdx,   setHistIdx]   = useState(-1);

  // ── xterm mount ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      theme: THEME,
      fontFamily: '"JetBrains Mono","Fira Code",ui-monospace,monospace',
      fontSize: 14, lineHeight: 1.45, cursorBlink: true,
      convertEol: true, scrollback: 3000, allowProposedApi: true,
    });
    const fit   = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);
    setTimeout(() => { try { fit.fit(); } catch { /* not laid out yet */ } }, 0);

    term.writeln('\x1b[2;36m// Sandbox Terminal\x1b[0m');
    term.writeln('\x1b[2;90m// Type a command above, or code blocks from chat run here automatically.\x1b[0m');
    term.writeln('');

    termRef.current = term;
    fitRef.current  = fit;
    window.__sandboxTerm = term;

    const obs = new ResizeObserver(() => { try { fit.fit(); } catch { /* ok */ } });
    obs.observe(containerRef.current);

    return () => {
      obs.disconnect(); term.dispose();
      termRef.current = null; fitRef.current = null;
      delete window.__sandboxTerm;
    };
  }, []);

  // ── shared SSE consumer ───────────────────────────────────────────────────
  const streamToTerminal = useCallback(async (
    endpoint: string,
    body: Record<string, unknown>,
    label: string,
  ) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    const term = termRef.current;
    if (!term) return;

    setStatus('connecting');
    setExitCode(null);
    term.writeln(`\x1b[2;37m${label}\x1b[0m`);

    try {
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Server returned HTTP ${res.status}`);

      setStatus('streaming');

      for await (const { type, text } of parseSse(res.body)) {
        switch (type) {
          case 'status': term.writeln(`\x1b[2;36m[${text}]\x1b[0m`); break;
          case 'stdout': term.write(text); break;
          case 'stderr': term.write(`\x1b[91m${text}\x1b[0m`); break;
          case 'exit': {
            const code = Number(text);
            setExitCode(code);
            term.writeln(`\n${code === 0 ? '\x1b[32m' : '\x1b[31m'}[exit ${code}]\x1b[0m`);
            setStatus('done');
            break;
          }
          case 'timeout':
            term.writeln(`\n\x1b[33m⏱  Timeout: ${text}\x1b[0m`);
            setStatus('done');
            break;
          case 'error':
            // Explicit error — never a silent hang. Always shown in red.
            term.writeln(`\n\x1b[1;31m✗  Error: ${text}\x1b[0m`);
            setStatus('error');
            break;
        }
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        term.writeln('\n\x1b[2;90m[cancelled]\x1b[0m');
        setStatus('cancelled');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        // Surface connection errors clearly — server unreachable, timeout, etc.
        term.writeln(`\n\x1b[1;31m✗  Connection error: ${msg}\x1b[0m`);
        term.writeln('\x1b[2;31m   Is sandbox-runner running on port 3001?\x1b[0m');
        setStatus('error');
      }
    } finally {
      setStatus(s => (s === 'streaming' || s === 'connecting') ? 'done' : s);
    }
  }, []);

  // ── run shell command (manual input bar) ──────────────────────────────────
  const runCommand = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd || status === 'connecting' || status === 'streaming') return;
    setHistory(h => [cmd, ...h.filter(x => x !== cmd)].slice(0, 50));
    setHistIdx(-1);
    await streamToTerminal('/run', { command: cmd }, `$ ${cmd}`);
  }, [command, status, streamToTerminal]);

  // ── run code snippet (called by parent via ref) ────────────────────────────
  const runCode = useCallback((code: string, language: string) => {
    const lang = language || 'bash';
    streamToTerminal('/run-code', { code, language: lang }, `▶ Running ${lang} snippet…`);
  }, [streamToTerminal]);

  const cancel = useCallback(() => {
    abortRef.current?.abort(new Error('Cancelled by user'));
    setStatus('cancelled');
  }, []);

  const clear = useCallback(() => {
    termRef.current?.clear();
    setExitCode(null);
    setStatus('idle');
  }, []);

  // ── expose imperative handle ───────────────────────────────────────────────
  useImperativeHandle(ref, () => ({ runCode, cancel }), [runCode, cancel]);

  const isRunning = status === 'connecting' || status === 'streaming';

  const handleKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); runCommand(); }
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHistIdx(i => { const n = Math.min(i + 1, history.length - 1); setCommand(history[n] ?? ''); return n; });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHistIdx(i => { const n = Math.max(i - 1, -1); setCommand(n === -1 ? '' : (history[n] ?? '')); return n; });
    }
  }, [runCommand, history]);

  const dotColor = {
    idle: '#555', connecting: '#5b8dee', streaming: '#8fbf6f',
    done: exitCode === 0 ? '#8fbf6f' : exitCode !== null ? '#ff6a6a' : '#8fbf6f',
    error: '#ff6a6a', cancelled: '#888',
  }[status];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0a0a' }}>
      {/* toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid #1e1e1e', background: '#0f0f0f', flexShrink: 0 }}>
        <span style={{ color: '#d4ff3f', fontSize: 11, letterSpacing: '0.1em',
          textTransform: 'uppercase', whiteSpace: 'nowrap', userSelect: 'none' }}>
          // shell
        </span>
        <input id="cmd-input" value={command}
          onChange={e => { setCommand(e.target.value); setHistIdx(-1); }}
          onKeyDown={handleKey} disabled={isRunning}
          placeholder="bash -c '…'" autoFocus
          style={{ flex: 1, minWidth: 0, background: '#151515', color: '#e8e8e8',
            border: '1px solid #2a2a2a', borderRadius: 4, padding: '5px 10px',
            fontFamily: 'inherit', fontSize: 13, outline: 'none', opacity: isRunning ? .6 : 1 }} />
        {isRunning
          ? <button onClick={cancel} data-testid="cancel-btn"
              style={{ background: '#2a1010', color: '#ff6a6a', border: '1px solid #5a2020',
                borderRadius: 4, padding: '5px 14px', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: 12, fontWeight: 700 }}>Cancel</button>
          : <button onClick={runCommand} disabled={!command.trim()} data-testid="run-btn"
              style={{ background: command.trim() ? '#d4ff3f' : '#1a1a1a',
                color: command.trim() ? '#0a0a0a' : '#444', border: 'none',
                borderRadius: 4, padding: '5px 16px', cursor: command.trim() ? 'pointer' : 'default',
                fontFamily: 'inherit', fontSize: 12, fontWeight: 700 }}>Run</button>}
        <button onClick={clear} style={{ background: 'transparent', color: '#555',
          border: '1px solid #222', borderRadius: 4, padding: '5px 10px',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>Clear</button>
        <div title={`${status}${exitCode !== null ? ` (exit ${exitCode})` : ''}`}
          style={{ display: 'flex', alignItems: 'center', gap: 5, color: dotColor,
            fontSize: 11, minWidth: 90, whiteSpace: 'nowrap' }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor,
            boxShadow: isRunning ? `0 0 5px ${dotColor}` : 'none' }} />
          {status}{exitCode !== null && status === 'done' ? ` (${exitCode})` : ''}
        </div>
      </div>
      {/* xterm */}
      <div ref={containerRef} data-testid="terminal" style={{ flex: 1, overflow: 'hidden' }} />
    </div>
  );
});
SandboxTerminal.displayName = 'SandboxTerminal';
