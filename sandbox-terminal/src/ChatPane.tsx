/**
 * ChatPane — agent-mode chat.
 *
 * What's injected into the LLM context automatically:
 *   1. A system prompt telling the model it's a coding agent.
 *   2. The file tree (condensed path list).
 *   3. Full content of every file the user added to context.
 *
 * What the model is asked to output when making changes:
 *   - Explanation in plain text.
 *   - Each file to be created/modified as a code block preceded by:
 *       File: <relative-path>
 *     e.g.
 *       File: src/auth.ts
 *       ```typescript
 *       // full new file content
 *       ```
 *   This is parsed by extractFileChanges() and surfaced as PendingChange[].
 *
 * The model can also produce normal code blocks (no File: header) which
 * are rendered as runnable snippets with "▶ Run in Sandbox".
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PendingChange } from './useRepoContext.js';
import type { FileNode } from './types.js';

// Imperative handle exposed to parent (used by auto-verify loop)
export interface ChatHandle {
  /** Send a message programmatically (e.g. from the verify loop injecting test
   *  failure output). Returns the file changes the model proposed, if any. */
  programmaticSend: (text: string, role?: 'retry-inject' | 'user') => Promise<PendingChange[]>;
}

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  repoRoot: string,
  tree: FileNode[],
  contextFiles: Map<string, string>,
): string {
  const parts: string[] = [];

  parts.push(
    'You are an expert coding agent. You have access to a local code repository.',
    'When asked to fix or build something:',
    '  1. Reason about the problem briefly.',
    '  2. Output the complete new content of every file you want to change or create.',
    '  3. Precede each file block with exactly this marker on its own line:',
    '       File: <path relative to repo root>',
    '     followed immediately by a fenced code block with the FULL file content.',
    '  4. Do NOT output partial files or diffs — always the complete file.',
    '  5. After the file blocks, summarize what you changed and why.',
    '',
    'If the task does not require file changes (e.g. a question), just answer directly.',
  );

  if (repoRoot) {
    parts.push('', `Repo root: ${repoRoot}`);
  }

  if (tree.length > 0) {
    const flatPaths = flattenTree(tree);
    parts.push('', 'File tree (gitignore-filtered):', flatPaths.join('\n'));
  }

  if (contextFiles.size > 0) {
    parts.push('', '── File contents ──');
    for (const [relPath, content] of contextFiles) {
      const ext  = relPath.split('.').pop() ?? '';
      parts.push('', `File: ${relPath}`, '```' + ext, content, '```');
    }
  }

  return parts.join('\n');
}

function flattenTree(nodes: FileNode[], prefix = ''): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === 'file') out.push(p);
    else if (n.children) out.push(...flattenTree(n.children, p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parse LLM output for "File: path\n```lang\ncontent```" blocks
// ---------------------------------------------------------------------------

export function extractFileChanges(text: string): PendingChange[] {
  const changes: PendingChange[] = [];
  // Match:   File: <path>\n```<lang?>\n<content>```
  const re = /^File:\s*(.+)\n```[a-zA-Z0-9_+\-.]*\n([\s\S]*?)```/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filePath = m[1]!.trim();
    const content  = m[2]!;
    if (filePath) changes.push({ path: filePath, content });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Parse text into segments (File-change blocks, plain code blocks, plain text)
// ---------------------------------------------------------------------------

type Segment =
  | { type: 'text';        content: string }
  | { type: 'file-change'; path: string; lang: string; content: string }
  | { type: 'code';        lang: string; content: string };

function parseSegments(text: string): Segment[] {
  const out: Segment[] = [];
  // Capture both "File: path\n```lang\ncontent```"  and bare "```lang\ncontent```"
  const re = /(?:^|\n)(File:\s*(.+)\n)?```([a-zA-Z0-9_+\-.]*)\s*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index + (m[0].startsWith('\n') ? 1 : 0));
    if (before.trim()) out.push({ type: 'text', content: before });
    if (m[2]) {
      out.push({ type: 'file-change', path: m[2].trim(), lang: m[3] ?? '', content: m[4] ?? '' });
    } else {
      out.push({ type: 'code', lang: m[3] ?? '', content: m[4] ?? '' });
    }
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()) out.push({ type: 'text', content: tail });
  return out;
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function FileChangeBlock({ path, lang, content, isApplied, onRun }: {
  path: string; lang: string; content: string;
  isApplied: boolean; onRun: () => void;
}) {
  const [showCode, setShowCode] = useState(false);
  const lines = content.split('\n').length;
  return (
    <div style={{ margin: '8px 0', border: '1px solid #2a4a1a',
      borderRadius: 6, background: '#0c1a0c', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '5px 10px', borderBottom: '1px solid #1e3a1e' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: '#8fbf6f', fontWeight: 700 }}>FILE</span>
          <span style={{ fontSize: 11, color: '#e8e8e8' }}>{path}</span>
          <span style={{ fontSize: 10, color: '#555' }}>{lines} lines</span>
          {isApplied && <span style={{ fontSize: 10, color: '#d4ff3f' }}>✓ applied</span>}
        </div>
        <button onClick={() => setShowCode(s => !s)}
          style={{ background: 'transparent', color: '#555', border: 'none',
            fontSize: 11, cursor: 'pointer', padding: 0 }}>
          {showCode ? 'hide' : 'show'}
        </button>
      </div>
      {showCode && (
        <pre style={{ margin: 0, padding: '8px 12px', overflowX: 'auto',
          fontSize: 11.5, lineHeight: 1.5, color: '#ccc', maxHeight: 400 }}>
          {content}
        </pre>
      )}
    </div>
  );
}

function CodeBlock({ lang, content, onRun }: {
  lang: string; content: string; onRun: () => void;
}) {
  return (
    <div style={{ margin: '8px 0', background: '#0b0b0b',
      border: '1px solid #2a2a2a', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 10px', borderBottom: '1px solid #1e1e1e' }}>
        <span style={{ fontSize: 10, color: '#666', textTransform: 'uppercase',
          letterSpacing: '0.1em' }}>{lang || 'code'}</span>
        <button onClick={onRun} data-testid="run-code-btn"
          style={{ background: '#1a2a0a', color: '#8fbf6f', border: '1px solid #2a4a1a',
            borderRadius: 4, padding: '2px 10px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
          ▶ Run in Sandbox
        </button>
      </div>
      <pre style={{ margin: 0, padding: '8px 12px', overflowX: 'auto',
        fontSize: 12, lineHeight: 1.5, color: '#e8e8e8',
        maxHeight: 300, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {content}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id:          string;
  role:        'user' | 'assistant';
  content:     string;
  kind?:       'user' | 'retry-inject';   // retry-inject = auto-sent by verify loop
  segments?:   Segment[];
  fileChanges?: PendingChange[];
}

let _id = 0;
const uid = () => String(++_id);

// ---------------------------------------------------------------------------
// ChatPane
// ---------------------------------------------------------------------------

interface Props {
  repoRoot:          string;
  sandboxId:         string | null;
  provider:          string;
  model:             string;
  tree:              FileNode[];
  contextFiles:      Map<string, string>;
  autoRun:           boolean;
  appliedPaths:      Set<string>;
  autoSelectedFiles: string[];
  onRunCode:         (code: string, lang: string)    => void;
  onFileChanges:     (changes: PendingChange[])      => void;
  onBeforeSend?:     (query: string) => Promise<void>;
}

export const ChatPane = forwardRef<ChatHandle, Props>(function ChatPane({
  repoRoot, sandboxId, provider, model, tree, contextFiles, autoRun, appliedPaths,
  autoSelectedFiles, onRunCode, onFileChanges, onBeforeSend,
}, ref) {
  const [messages,  setMessages]  = useState<Message[]>([
    { id: uid(), role: 'assistant', content:
      "Open a repo in the left panel and click files to add them to context.\n\n" +
      "Then describe what you want:\n" +
      '• "Fix the auth token expiry bug in src/auth.ts"\n' +
      '• "Add rate limiting to the /api/run endpoint"\n' +
      '• "Write a Python script that fetches GitHub stars"\n\n' +
      "I'll output complete files. You review and apply with one click." }
  ]);
  const [input,    setInput]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // ── shared send implementation ─────────────────────────────────────────────
  const sendText = useCallback(async (
    text: string,
    kind: 'user' | 'retry-inject' = 'user',
  ): Promise<PendingChange[]> => {
    if (!text || loading) return [];

    // 'retry-inject' shows as a muted system note, not a user bubble
    const userMsg: Message = { id: uid(), role: 'user', content: text, kind };
    setMessages(m => [...m, userMsg]);
    setLoading(true);
    setError(null);

    try {
      const history = [...messages, userMsg]
        .map(m => ({ role: m.role, content: m.content }));

      const systemPrompt = buildSystemPrompt(repoRoot, tree, contextFiles);

      // Use /agent-chat (which accepts systemPrompt override) when a sandbox
      // session is active (remote/Vercel), or local /chat endpoint otherwise.
      const chatEndpoint = sandboxId ? `${API_URL}/agent-chat` : `${API_URL}/chat`;
      const chatHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sandboxId) chatHeaders['X-Sandbox-Session'] = sandboxId;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 115_000);
      let res: Response;
      try {
        res = await fetch(chatEndpoint, {
          method: 'POST',
          headers: chatHeaders,
          body: JSON.stringify({ messages: history, systemPrompt, provider, model }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }

      const data   = await res.json() as { reply?: string };
      const reply  = data.reply ?? '(empty response)';
      const segs   = parseSegments(reply);
      const fc     = extractFileChanges(reply);

      setMessages(m => [...m, {
        id: uid(), role: 'assistant', content: reply, segments: segs, fileChanges: fc,
      }]);

      if (fc.length > 0) onFileChanges(fc);

      if (autoRun) {
        for (const seg of segs) {
          if (seg.type === 'code' && seg.content.trim()) onRunCode(seg.content, seg.lang);
        }
      }

      return fc;
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const lower = raw.toLowerCase();
      // iOS Safari surfaces timed-out/dropped fetches as "Load failed".
      const msg =
        lower === 'load failed' || lower === 'failed to fetch'
          ? 'Connection dropped before the model replied (often a timeout). Try again or a faster model.'
          : raw;
      setError(msg);
      setMessages(m => [...m, { id: uid(), role: 'assistant', content: `⚠ ${msg}` }]);
      return [];
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, messages, repoRoot, tree, contextFiles, autoRun, onRunCode, onFileChanges]);

  // Expose imperative handle to parent (used by the verify loop)
  useImperativeHandle(ref, () => ({
    programmaticSend: (text, role = 'retry-inject') => sendText(text, role),
  }), [sendText]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    if (onBeforeSend) await onBeforeSend(text);
    await sendText(text, 'user');
  }, [input, loading, sendText, onBeforeSend]);


  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
      background: '#0a0a0a', fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>

      {/* header */}
      <div style={{ padding: '7px 12px', borderBottom: '1px solid #1e1e1e',
        background: '#0f0f0f', flexShrink: 0, display: 'flex',
        alignItems: 'center', gap: 10 }}>
        <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.1em',
          textTransform: 'uppercase' }}>// agent</span>
        {contextFiles.size > 0 && (
          <span style={{ fontSize: 10, color: '#555' }}>
            {contextFiles.size} file{contextFiles.size !== 1 ? 's' : ''} in context
          </span>
        )}
        {error && <span style={{ fontSize: 10, color: '#ff6a6a', marginLeft: 'auto' }}>
          ✗ {error}
        </span>}
      </div>

      {/* auto-context banner — shown when auto-context picked files */}
      {autoSelectedFiles.length > 0 && (
        <div style={{ padding: '5px 12px', background: 'rgba(212,255,63,.05)',
          borderBottom: '1px solid rgba(212,255,63,.15)', flexShrink: 0,
          fontSize: 10, color: '#8fa62b', lineHeight: 1.6 }}>
          <span style={{ fontWeight: 700 }}>⚡ Auto-context:</span>{' '}
          {autoSelectedFiles.join(', ')}
        </div>
      )}

      {/* messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.map(msg => (
          <div key={msg.id} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: msg.role === 'user' ? '75%' : '100%',
            width: msg.role === 'assistant' ? '100%' : undefined,
          }}>
            {msg.role === 'user' && msg.kind === 'retry-inject' ? (
              /* Retry-inject messages: muted note, not a user bubble */
              <div style={{ padding: '5px 10px', background: '#111a0a',
                border: '1px dashed #2a4020', borderRadius: 6,
                fontSize: 11, color: '#6a8a5a', whiteSpace: 'pre-wrap',
                maxHeight: 120, overflowY: 'auto' }}>
                <span style={{ fontWeight: 700, display: 'block', marginBottom: 3 }}>
                  ⟳ Auto-retry — test failure injected
                </span>
                {msg.content.slice(0, 500)}{msg.content.length > 500 ? '…' : ''}
              </div>
            ) : msg.role === 'user' ? (
              <div style={{ background: '#1f1f1f', border: '1px solid #2a2a2a',
                borderRadius: 8, padding: '7px 12px', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                {msg.content}
              </div>
            ) : (msg.segments ?? []).map((seg, i) => {
              if (seg.type === 'text') return (
                <p key={i} style={{ margin: '4px 0', fontSize: 13, lineHeight: 1.6,
                  color: '#ccc', whiteSpace: 'pre-wrap' }}>{seg.content.trim()}</p>
              );
              if (seg.type === 'file-change') return (
                <FileChangeBlock key={i} path={seg.path} lang={seg.lang}
                  content={seg.content}
                  isApplied={appliedPaths.has(seg.path)}
                  onRun={() => onRunCode(seg.content, seg.lang)} />
              );
              return (
                <CodeBlock key={i} lang={seg.lang} content={seg.content}
                  onRun={() => onRunCode(seg.content, seg.lang)} />
              );
            })}
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: 'flex-start', fontSize: 12, color: '#555' }}>
            thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <form onSubmit={e => { e.preventDefault(); send(); }}
        style={{ borderTop: '1px solid #1e1e1e', padding: '10px 12px',
          display: 'flex', gap: 8, flexShrink: 0, alignItems: 'flex-end',
          background: '#0a0a0a' }}>
        <textarea
          id="chat-input"
          value={input}
          rows={2}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          placeholder="Describe what to fix or build… (Enter to send, Shift+Enter for newline)"
          disabled={loading}
          style={{ flex: 1, background: '#111', color: '#e8e8e8',
            border: '1px solid #2a2a2a', borderRadius: 4,
            padding: '7px 10px', fontFamily: 'inherit', fontSize: 16,
            outline: 'none', resize: 'vertical', minHeight: 48, maxHeight: 120,
            opacity: loading ? .6 : 1 }} />
        <button type="submit" disabled={!input.trim() || loading}
          style={{ background: input.trim() && !loading ? '#d4ff3f' : '#1a1a1a',
            color: input.trim() && !loading ? '#0a0a0a' : '#444',
            border: 'none', borderRadius: 4, padding: '8px 16px',
            cursor: input.trim() && !loading ? 'pointer' : 'default',
            fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
            alignSelf: 'flex-end' }}>Send</button>
      </form>
    </div>
  );
});
ChatPane.displayName = 'ChatPane';
