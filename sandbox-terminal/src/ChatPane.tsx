/**
 * ChatPane — chat UI that:
 *   1. Sends user messages to POST /chat (local proxy or real LLM).
 *   2. Renders assistant replies, extracting fenced code blocks.
 *   3. Each code block gets a "▶ Run in Sandbox" button.
 *   4. When autoRun is enabled, code blocks run automatically.
 *   5. Calls onRunCode(code, language) when a block should execute.
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

// ── Types ────────────────────────────────────────────────────────────────────

interface CodeSegment { type: 'code'; lang: string; content: string }
interface TextSegment { type: 'text'; content: string }
type Segment = TextSegment | CodeSegment;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  segments?: Segment[];
}

interface Props {
  onRunCode: (code: string, language: string) => void;
  autoRun: boolean;
}

// ── Parse code fences ────────────────────────────────────────────────────────

function parseSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([a-zA-Z0-9_+\-.]*)\s*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', content: text.slice(last, m.index) });
    out.push({ type: 'code', lang: (m[1] || 'bash').toLowerCase(), content: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', content: text.slice(last) });
  return out;
}

// ── uid ──────────────────────────────────────────────────────────────────────

let _uid = 0;
const uid = () => String(++_uid);

// ── CodeBlock component ──────────────────────────────────────────────────────

function CodeBlock({ lang, content, onRun, autoRun }: {
  lang: string; content: string; onRun: () => void; autoRun: boolean;
}) {
  const didAutoRun = useRef(false);
  useEffect(() => {
    if (autoRun && !didAutoRun.current) {
      didAutoRun.current = true;
      onRun();
    }
  }, [autoRun, onRun]);

  return (
    <div style={{ margin: '10px 0', background: '#0b0b0b', border: '1px solid #2a2a2a', borderRadius: 8 }}>
      {/* header bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '5px 10px', borderBottom: '1px solid #1e1e1e' }}>
        <span style={{ fontSize: 10, color: '#666', textTransform: 'uppercase',
          letterSpacing: '0.12em', fontFamily: 'inherit' }}>{lang}</span>
        <button
          onClick={onRun}
          data-testid="run-code-btn"
          style={{ background: '#1a2a0a', color: '#8fbf6f', border: '1px solid #2a4a1a',
            borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
          ▶ Run in Sandbox
        </button>
      </div>
      {/* code */}
      <pre style={{ margin: 0, padding: '10px 12px', overflowX: 'auto',
        fontSize: 12.5, lineHeight: 1.5, color: '#e8e8e8', fontFamily: 'inherit',
        whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {content}
      </pre>
    </div>
  );
}

// ── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg, onRunCode, autoRun }: {
  msg: Message; onRunCode: (code: string, lang: string) => void; autoRun: boolean;
}) {
  if (msg.role === 'user') {
    return (
      <div style={{ alignSelf: 'flex-end', maxWidth: '80%', background: '#1f1f1f',
        border: '1px solid #2a2a2a', borderRadius: 10, padding: '8px 12px', fontSize: 13 }}>
        {msg.content}
      </div>
    );
  }

  const segs = msg.segments ?? parseSegments(msg.content);
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '100%', width: '100%' }}>
      {segs.map((seg, i) =>
        seg.type === 'text'
          ? <p key={i} style={{ margin: '4px 0', fontSize: 13, lineHeight: 1.55,
              color: '#ccc', whiteSpace: 'pre-wrap' }}>{seg.content.trim()}</p>
          : <CodeBlock key={i} lang={seg.lang} content={seg.content}
              autoRun={autoRun} onRun={() => onRunCode(seg.content, seg.lang)} />
      )}
    </div>
  );
}

// ── ChatPane ─────────────────────────────────────────────────────────────────

export function ChatPane({ onRunCode, autoRun }: Props) {
  const [messages,  setMessages]  = useState<Message[]>([
    { id: uid(), role: 'assistant', content:
      'Ask me to write code and I will send it straight to the sandbox.\n\n' +
      'Try:\n• "write a streaming Python script"\n• "write code that errors"\n• "write a bash loop"' }
  ]);
  const [input,     setInput]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { id: uid(), role: 'user', content: text };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const history = [...messages, userMsg]
        .filter(m => m.role !== 'assistant' || !m.content.startsWith('Ask me'))
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { reply?: string };
      const reply = data.reply ?? '(empty response)';
      const segments = parseSegments(reply);
      setMessages(m => [...m, { id: uid(), role: 'assistant', content: reply, segments }]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setMessages(m => [...m, { id: uid(), role: 'assistant',
        content: `⚠ Chat error: ${msg}` }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%',
      background: '#0a0a0a', fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>

      {/* header */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #1e1e1e',
        background: '#0f0f0f', flexShrink: 0 }}>
        <span style={{ color: '#d4ff3f', fontSize: 11, letterSpacing: '0.1em',
          textTransform: 'uppercase', userSelect: 'none' }}>// chat</span>
        {error && (
          <span style={{ marginLeft: 12, fontSize: 11, color: '#ff6a6a' }}>
            ✗ {error}
          </span>
        )}
      </div>

      {/* message list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.map(m => (
          <MessageBubble key={m.id} msg={m} onRunCode={onRunCode} autoRun={autoRun} />
        ))}
        {loading && (
          <div style={{ alignSelf: 'flex-start', fontSize: 12, color: '#555' }}>
            model is thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <form
        onSubmit={e => { e.preventDefault(); send(); }}
        style={{ borderTop: '1px solid #1e1e1e', padding: '10px 12px',
          display: 'flex', gap: 8, flexShrink: 0 }}>
        <input
          id="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), send())}
          placeholder="Ask for code…"
          disabled={loading}
          style={{ flex: 1, background: '#151515', color: '#e8e8e8',
            border: '1px solid #2a2a2a', borderRadius: 4, padding: '6px 10px',
            fontFamily: 'inherit', fontSize: 13, outline: 'none',
            opacity: loading ? .6 : 1 }} />
        <button type="submit" disabled={!input.trim() || loading}
          style={{ background: input.trim() && !loading ? '#d4ff3f' : '#1a1a1a',
            color: input.trim() && !loading ? '#0a0a0a' : '#444',
            border: 'none', borderRadius: 4, padding: '6px 14px',
            cursor: input.trim() && !loading ? 'pointer' : 'default',
            fontFamily: 'inherit', fontSize: 12, fontWeight: 700 }}>Send</button>
      </form>
    </div>
  );
}
