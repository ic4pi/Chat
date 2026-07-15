/**
 * App — split-pane layout: Chat (left) + SandboxTerminal (right).
 *
 * When the chat pane calls onRunCode(code, language), App forwards it to the
 * terminal via the TerminalHandle ref so the code executes immediately.
 * An "Auto-run" toggle in the header controls whether code blocks in chat
 * responses fire automatically or wait for the user to click "▶ Run".
 */

import React, { useCallback, useRef, useState } from 'react';
import { ChatPane } from './ChatPane.js';
import { SandboxTerminal, type TerminalHandle } from './Terminal.js';

export function App() {
  const termRef  = useRef<TerminalHandle>(null);
  const [autoRun, setAutoRun] = useState(true);
  const [lastCode, setLastCode] = useState<{ code: string; lang: string } | null>(null);

  const handleRunCode = useCallback((code: string, language: string) => {
    setLastCode({ code, lang: language });
    termRef.current?.runCode(code, language);
  }, []);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '100vh',
      height: '100vh',
      background: '#0a0a0a',
      fontFamily: '"JetBrains Mono",ui-monospace,monospace',
      overflow: 'hidden',
    }}>
      {/* ── left: chat pane ── */}
      <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid #1e1e1e' }}>
        {/* header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 14px', borderBottom: '1px solid #1e1e1e',
          background: '#080808', flexShrink: 0,
        }}>
          <span style={{ color: '#d4ff3f', fontSize: 12, letterSpacing: '0.08em',
            textTransform: 'uppercase' }}>
            &#47;&#47;&nbsp;Sandbox&nbsp;Chat
          </span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7,
            fontSize: 11, color: '#888', cursor: 'pointer', userSelect: 'none' }}>
            <span>Auto-run code</span>
            <input
              type="checkbox"
              checked={autoRun}
              onChange={e => setAutoRun(e.target.checked)}
              data-testid="autorun-toggle"
              style={{ accentColor: '#d4ff3f', width: 14, height: 14 }} />
          </label>
        </div>
        <ChatPane onRunCode={handleRunCode} autoRun={autoRun} />
      </div>

      {/* ── right: sandbox terminal ── */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 14px', borderBottom: '1px solid #1e1e1e',
          background: '#080808', flexShrink: 0,
        }}>
          <span style={{ color: '#d4ff3f', fontSize: 12, letterSpacing: '0.08em',
            textTransform: 'uppercase' }}>
            &#47;&#47;&nbsp;Sandbox&nbsp;Terminal
          </span>
          {lastCode && (
            <span style={{ fontSize: 10, color: '#555' }}>
              last: {lastCode.lang}&nbsp;snippet&nbsp;({lastCode.code.split('\n').length}&nbsp;lines)
            </span>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <SandboxTerminal ref={termRef} />
        </div>
      </div>
    </div>
  );
}
