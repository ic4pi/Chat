/**
 * SandboxTerminal — React component that connects to the sandbox-runner
 * SSE endpoint, streams stdout/stderr into xterm.js in real time, and
 * lets the user type commands manually.
 *
 * Backend contract (POST http://localhost:3001/run):
 *   Body:    { command: string }
 *   Stream:  text/event-stream, each message is:
 *              event: status|stdout|stderr|exit|timeout|error
 *              data: "<JSON-encoded string>"
 *
 * The data field is always JSON.parse()-able to a plain string.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

// ---------------------------------------------------------------------------
// Config — override with VITE_API_URL env var
// ---------------------------------------------------------------------------
const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type RunStatus = 'idle' | 'connecting' | 'streaming' | 'done' | 'error' | 'cancelled';

// Expose the Terminal instance on window so the Puppeteer verify script can
// read the buffer programmatically without relying on visual screenshots alone.
declare global {
  interface Window {
    __sandboxTerm?: Terminal;
  }
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------
// Parses the raw SSE byte stream from a fetch response body into typed events.
// Format: each message is "event: <type>\ndata: <json-string>\n\n"

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

      // SSE messages are delimited by blank lines (\n\n).
      const messages = buf.split('\n\n');
      buf = messages.pop() ?? ''; // keep the incomplete trailing fragment

      for (const msg of messages) {
        let type = 'message';
        let rawData = '';
        for (const line of msg.split('\n')) {
          if (line.startsWith('event: ')) type = line.slice(7).trim();
          else if (line.startsWith('data: ')) rawData = line.slice(6).trim();
        }
        if (!rawData) continue;

        let text: string;
        try {
          text = JSON.parse(rawData) as string;
        } catch {
          text = rawData;
        }

        yield { type, text };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Xterm theme — matches the chat app's dark palette
// ---------------------------------------------------------------------------
const XTERM_THEME = {
  background:          '#0a0a0a',
  foreground:          '#e8e8e8',
  cursor:              '#d4ff3f',
  cursorAccent:        '#0a0a0a',
  selectionBackground: 'rgba(212,255,63,0.2)',
  black:               '#0a0a0a',
  red:                 '#ff6a6a',
  green:               '#8fbf6f',
  yellow:              '#d4ff3f',
  blue:                '#5b8dee',
  magenta:             '#c792ea',
  cyan:                '#89ddff',
  white:               '#e8e8e8',
  brightBlack:         '#555',
  brightRed:           '#ff9b9b',
  brightGreen:         '#b5d89b',
  brightYellow:        '#e8ff8a',
  brightBlue:          '#82aaff',
  brightMagenta:       '#dbb0f0',
  brightCyan:          '#aadeff',
  brightWhite:         '#ffffff',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function SandboxTerminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef      = useRef<Terminal | null>(null);
  const fitRef       = useRef<FitAddon | null>(null);
  const abortRef     = useRef<AbortController | null>(null);

  const [command,     setCommand]     = useState('');
  const [status,      setStatus]      = useState<RunStatus>('idle');
  const [exitCode,    setExitCode]    = useState<number | null>(null);
  const [historyIdx,  setHistoryIdx]  = useState(-1);
  const [history,     setHistory]     = useState<string[]>([]);

  // ---- xterm mount --------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || termRef.current) return;

    const term = new Terminal({
      theme:        XTERM_THEME,
      fontFamily:   '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace',
      fontSize:     14,
      lineHeight:   1.45,
      cursorBlink:  true,
      convertEol:   true,   // \n → \r\n so output renders on correct lines
      scrollback:   3000,
      allowProposedApi: true,
    });

    const fit   = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(containerRef.current);
    // Defer fit() by one frame so the container has been laid out.
    // Also guards against React StrictMode's double-invoke of effects.
    setTimeout(() => { try { fit.fit(); } catch { /* not yet laid out */ } }, 0);

    term.writeln('\x1b[2;36m// Sandbox Terminal\x1b[0m');
    term.writeln('\x1b[2;90m// Type a command in the bar above, press Enter or click Run.\x1b[0m');
    term.writeln('');

    termRef.current = term;
    fitRef.current  = fit;
    // Expose for the Puppeteer verify script
    window.__sandboxTerm = term;

    const obs = new ResizeObserver(() => fit.fit());
    obs.observe(containerRef.current);

    return () => {
      obs.disconnect();
      term.dispose();
      termRef.current  = null;
      fitRef.current   = null;
      delete window.__sandboxTerm;
    };
  }, []);

  // ---- run ----------------------------------------------------------------
  const run = useCallback(async (cmd: string) => {
    cmd = cmd.trim();
    if (!cmd) return;

    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    const term = termRef.current;
    if (!term) return;

    setStatus('connecting');
    setExitCode(null);
    setHistory(h => [cmd, ...h.filter(x => x !== cmd)].slice(0, 50));
    setHistoryIdx(-1);

    term.writeln(`\x1b[2;37m$ \x1b[0;37m${cmd}\x1b[0m`);

    try {
      const res = await fetch(`${API_URL}/run`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ command: cmd }),
        signal:  abort.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }

      setStatus('streaming');

      for await (const { type, text } of parseSse(res.body)) {
        switch (type) {
          case 'status':
            // dim cyan — operational messages, not user output
            term.writeln(`\x1b[2;36m[${text}]\x1b[0m`);
            break;

          case 'stdout':
            term.write(text);
            break;

          case 'stderr':
            // stderr in bright red so it's distinguishable
            term.write(`\x1b[91m${text}\x1b[0m`);
            break;

          case 'exit': {
            const code = Number(text);
            setExitCode(code);
            const color = code === 0 ? '\x1b[32m' : '\x1b[31m';
            term.writeln(`\n${color}[exit ${code}]\x1b[0m`);
            setStatus('done');
            break;
          }

          case 'timeout':
            term.writeln(`\n\x1b[33m[timeout: ${text}]\x1b[0m`);
            setStatus('done');
            break;

          case 'error':
            term.writeln(`\n\x1b[31m[error: ${text}]\x1b[0m`);
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
        term.writeln(`\n\x1b[31m[connection error: ${msg}]\x1b[0m`);
        setStatus('error');
      }
    } finally {
      // Safety net: if stream ended without an explicit exit/error/timeout event
      setStatus(s => (s === 'streaming' || s === 'connecting') ? 'done' : s);
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort(new Error('Cancelled by user'));
    setStatus('cancelled');
  }, []);

  const clear = useCallback(() => {
    termRef.current?.clear();
    setExitCode(null);
    setStatus('idle');
  }, []);

  const submit = useCallback(() => {
    if (command.trim()) run(command);
  }, [command, run]);

  const isRunning = status === 'connecting' || status === 'streaming';

  // ---- keyboard navigation in command input --------------------------------
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHistoryIdx(i => {
        const next = Math.min(i + 1, history.length - 1);
        setCommand(history[next] ?? '');
        return next;
      });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHistoryIdx(i => {
        const next = Math.max(i - 1, -1);
        setCommand(next === -1 ? '' : (history[next] ?? ''));
        return next;
      });
    }
  }, [submit, history]);

  // ---- status indicator colours -------------------------------------------
  const statusColor: Record<RunStatus, string> = {
    idle:       '#555',
    connecting: '#5b8dee',
    streaming:  '#8fbf6f',
    done:       exitCode === 0 ? '#8fbf6f' : exitCode !== null ? '#ff6a6a' : '#8fbf6f',
    error:      '#ff6a6a',
    cancelled:  '#888',
  };
  const dotColor = statusColor[status];

  // ---- render -------------------------------------------------------------
  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      height:         '100vh',
      background:     '#0a0a0a',
      color:          '#e8e8e8',
      fontFamily:     '"JetBrains Mono", ui-monospace, monospace',
      overflow:       'hidden',
    }}>

      {/* ── toolbar ── */}
      <div style={{
        display:        'flex',
        alignItems:     'center',
        gap:            '8px',
        padding:        '8px 12px',
        borderBottom:   '1px solid #1e1e1e',
        background:     '#0f0f0f',
        flexShrink:     0,
      }}>

        {/* wordmark */}
        <span style={{
          color:          '#d4ff3f',
          fontSize:       '11px',
          letterSpacing:  '0.1em',
          textTransform:  'uppercase',
          whiteSpace:     'nowrap',
          userSelect:     'none',
        }}>
          &#47;&#47;&nbsp;sandbox
        </span>

        {/* command input */}
        <input
          id="cmd-input"
          value={command}
          onChange={e => { setCommand(e.target.value); setHistoryIdx(-1); }}
          onKeyDown={handleKeyDown}
          placeholder="echo 'hello' && sleep 1 && echo 'world'"
          disabled={isRunning}
          autoFocus
          style={{
            flex:           1,
            minWidth:       0,
            background:     '#151515',
            color:          '#e8e8e8',
            border:         '1px solid #2a2a2a',
            borderRadius:   '4px',
            padding:        '5px 10px',
            fontFamily:     'inherit',
            fontSize:       '13px',
            outline:        'none',
            opacity:        isRunning ? 0.6 : 1,
            transition:     'border-color 0.15s',
          }}
          onFocus={e => (e.target.style.borderColor = '#3a3a3a')}
          onBlur={e  => (e.target.style.borderColor = '#2a2a2a')}
        />

        {/* run / cancel */}
        {isRunning ? (
          <button
            onClick={cancel}
            title="Cancel (sends abort to server)"
            style={{
              background:   '#2a1010',
              color:        '#ff6a6a',
              border:       '1px solid #5a2020',
              borderRadius: '4px',
              padding:      '5px 14px',
              cursor:       'pointer',
              fontFamily:   'inherit',
              fontSize:     '12px',
              fontWeight:   700,
              whiteSpace:   'nowrap',
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!command.trim()}
            title="Run command (Enter)"
            style={{
              background:   command.trim() ? '#d4ff3f' : '#1a1a1a',
              color:        command.trim() ? '#0a0a0a' : '#444',
              border:       'none',
              borderRadius: '4px',
              padding:      '5px 16px',
              cursor:       command.trim() ? 'pointer' : 'default',
              fontFamily:   'inherit',
              fontSize:     '12px',
              fontWeight:   700,
              whiteSpace:   'nowrap',
              transition:   'background 0.15s',
            }}
          >
            Run
          </button>
        )}

        {/* clear */}
        <button
          onClick={clear}
          title="Clear terminal"
          style={{
            background:   'transparent',
            color:        '#555',
            border:       '1px solid #222',
            borderRadius: '4px',
            padding:      '5px 10px',
            cursor:       'pointer',
            fontFamily:   'inherit',
            fontSize:     '12px',
          }}
        >
          Clear
        </button>

        {/* status dot */}
        <div
          title={`Status: ${status}${exitCode !== null ? ` (exit ${exitCode})` : ''}`}
          style={{
            display:    'flex',
            alignItems: 'center',
            gap:        '5px',
            color:      dotColor,
            fontSize:   '11px',
            minWidth:   '90px',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{
            width:      '7px',
            height:     '7px',
            borderRadius: '50%',
            background: dotColor,
            boxShadow:  isRunning ? `0 0 5px ${dotColor}` : 'none',
          }} />
          {status}{exitCode !== null && status === 'done' ? ` (${exitCode})` : ''}
        </div>

      </div>

      {/* ── xterm terminal ── */}
      <div
        ref={containerRef}
        data-testid="terminal"
        style={{ flex: 1, overflow: 'hidden' }}
      />

    </div>
  );
}
