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
 *   This is parsed by extractFileChanges() and auto-applied (default on).
 *   If the model only plans in prose, we send one corrective nudge turn.
 *
 * The model can also produce normal code blocks (no File: header) which
 * are rendered as runnable snippets with "▶ Run in Sandbox".
 */

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PendingChange } from './useRepoContext.js';
import type { FileNode } from './types.js';
import {
  extractFileChanges,
  looksLikeApplyRequest,
  looksLikeSuggestRequest,
  looksLikeLegacyWelcome,
  needsCodeContext,
  NUDGE_PROMPT,
} from './agentParse.js';
import {
  MAX_TREE_PATHS,
  packContextFiles,
  formatSearchHits,
  trimMessageHistory,
  type SearchHit,
} from './contextBudget.js';

export {
  extractFileChanges,
  looksLikeApplyRequest,
  looksLikeSuggestRequest,
  needsCodeContext,
} from './agentParse.js';
export type { SearchHit } from './contextBudget.js';

// Imperative handle exposed to parent (used by auto-verify loop)
export interface ChatHandle {
  /** Send a message programmatically (e.g. from the verify loop injecting test
   *  failure output). Returns the file changes the model proposed, if any. */
  programmaticSend: (text: string, role?: 'retry-inject' | 'user') => Promise<PendingChange[]>;
}

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

// Auto-context must NEVER block the user bubble from appearing.
const BEFORE_SEND_TIMEOUT_MS = 8_000;
const CHAT_TIMEOUT_MS = 115_000;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  repoRoot: string,
  tree: FileNode[],
  contextFiles: Map<string, string>,
  searchHits: SearchHit[],
  opts?: { light?: boolean },
): string {
  const parts: string[] = [];
  const light = !!opts?.light;

  parts.push(
    'You help non-coders understand and improve their project.',
    'The whole project is available in a cloud sandbox. Each message only includes files needed for that ask.',
    '',
    'DEFAULT MODE = SUGGEST (most asks):',
    '  • Answer in plain English with concrete suggestions grounded in the provided files.',
    '  • Cite real file paths from Open files / search hits / the file tree.',
    '  • Do NOT invent files or tasks that are not in the provided context.',
    '  • Do NOT output File: blocks. Do NOT claim you already fixed or saved anything.',
    '  • Do NOT push to GitHub. Do NOT say the phone was updated.',
    '',
    'APPLY MODE — only when the user clearly says to apply / implement / write / do it now:',
    '  • Output each changed file as a COMPLETE file using this format:',
    '       File: <path relative to repo root>',
    '       ```typescript',
    '       // full file content',
    '       ```',
    '  • Keep prose to 1–2 short sentences. Changes go to the sandbox only until the user applies them.',
    '',
    'Never invent placeholder tasks. Only discuss the user\'s actual request and real repo files.',
  );

  if (repoRoot) {
    parts.push('', `Project is open at: ${repoRoot}`);
    if (light) {
      parts.push(
        'This turn is a light/chat question — no source files were loaded on purpose.',
        'Answer briefly. If they want a fix or audit, ask them to say what\'s broken (you will then open the right files).',
      );
      return parts.join('\n');
    }
  }

  if (tree.length > 0) {
    // Tiny map only — never dump the whole repo into the prompt.
    const flatPaths = flattenTree(tree).filter(p =>
      !p.includes('node_modules') &&
      !p.includes('/dist/') &&
      !p.startsWith('dist/') &&
      !p.includes('public/agent/assets'),
    );
    const shown = flatPaths.slice(0, Math.min(MAX_TREE_PATHS, 80));
    parts.push('', 'File tree (paths only, truncated):', shown.join('\n'));
    if (flatPaths.length > shown.length) {
      parts.push(`… (${flatPaths.length - shown.length} more paths omitted)`);
    }
  }

  const hitBlock = formatSearchHits(searchHits);
  if (hitBlock) parts.push('', hitBlock);

  const packed = packContextFiles(contextFiles);
  if (packed.size > 0) {
    parts.push('', '── Open files (full) ──');
    if (packed.size < contextFiles.size) {
      parts.push(`(Using ${packed.size}/${contextFiles.size} files to stay under the model limit.)`);
    }
    for (const [relPath, content] of packed) {
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
  const re =
    /(?:^|\r?\n)([*_]*File:\s*(.+?)[*_]*\s*\r?\n(?:\r?\n)?)?```([a-zA-Z0-9_+\-.]*)\s*\r?\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const leadNl = m[0].startsWith('\n') || m[0].startsWith('\r') ? (m[0].startsWith('\r\n') ? 2 : 1) : 0;
    const before = text.slice(last, m.index + leadNl);
    if (before.trim()) out.push({ type: 'text', content: before });
    if (m[2]) {
      const path = m[2].trim().replace(/^[`'"]+|[`'"]+$/g, '');
      out.push({ type: 'file-change', path, lang: m[3] ?? '', content: m[4] ?? '' });
    } else {
      out.push({ type: 'code', lang: m[3] ?? '', content: m[4] ?? '' });
    }
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()) out.push({ type: 'text', content: tail });
  return out;
}

function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === 'load failed' || lower === 'failed to fetch' || lower.includes('networkerror')) {
    return 'Connection dropped before the model replied (often a timeout). Try again or a faster model.';
  }
  if (lower.includes('abort')) {
    return 'Request timed out waiting for the model. Try a faster model or a shorter prompt.';
  }
  return raw || 'Request failed';
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function FileChangeBlock({ path, lang, content, isApplied }: {
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

function AssistantBody({ msg, appliedPaths, onRunCode }: {
  msg: Message;
  appliedPaths: Set<string>;
  onRunCode: (code: string, lang: string) => void;
}) {
  const segs = msg.segments;
  if (segs && segs.length > 0) {
    return (
      <>
        {segs.map((seg, i) => {
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
      </>
    );
  }
  // Welcome text, errors, and any reply that didn't parse into segments
  // MUST still render — previously these were invisible.
  return (
    <p data-testid="assistant-text" style={{ margin: '4px 0', fontSize: 13, lineHeight: 1.6,
      color: '#ccc', whiteSpace: 'pre-wrap' }}>{msg.content}</p>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id:          string;
  role:        'user' | 'assistant';
  content:     string;
  /** welcome = UI-only, never sent to the model; retry-inject = verify/nudge loop */
  kind?:       'user' | 'retry-inject' | 'welcome';
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
  searchHits:        SearchHit[];
  onRunCode:         (code: string, lang: string)    => void;
  /** May apply writes; awaited so auto-apply finishes before send returns. */
  onFileChanges:     (changes: PendingChange[])      => void | Promise<void>;
  /** Returns fresh search hits + ephemeral full files for THIS send (avoids stale React state). */
  onBeforeSend?:     (query: string) => Promise<{
    hits: SearchHit[];
    files: Map<string, string>;
  } | void>;
}

export const ChatPane = forwardRef<ChatHandle, Props>(function ChatPane({
  repoRoot, sandboxId, provider, model, tree, contextFiles, autoRun, appliedPaths,
  autoSelectedFiles, searchHits, onRunCode, onFileChanges, onBeforeSend,
}, ref) {
  const [messages,  setMessages]  = useState<Message[]>([
    { id: uid(), role: 'assistant', kind: 'welcome', content:
      "Paste your GitHub link on the left → Open.\n\n" +
      "Then ask in plain English, for example:\n" +
      "• “Suggest additions and fixes” → I’ll only recommend (nothing is saved)\n" +
      "• “Apply that fix” → I’ll write changes into the cloud sandbox (not GitHub, not your phone)\n\n" +
      "You don’t need to pick files. Auto-save is off unless you turn it on." }
  ]);
  const [input,    setInput]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

  // Keep latest props in a ref so a send started before auto-context finishes
  // still sees the updated file context afterward.
  const latestRef = useRef({
    repoRoot, sandboxId, provider, model, tree, contextFiles, searchHits,
    autoRun, onRunCode, onFileChanges, onBeforeSend, messages,
  });
  latestRef.current = {
    repoRoot, sandboxId, provider, model, tree, contextFiles, searchHits,
    autoRun, onRunCode, onFileChanges, onBeforeSend, messages,
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // ── shared send implementation ─────────────────────────────────────────────
  const sendText = useCallback(async (
    text: string,
    kind: 'user' | 'retry-inject' = 'user',
  ): Promise<PendingChange[]> => {
    if (!text || sendingRef.current) return [];
    sendingRef.current = true;

    // 1) Show the bubble IMMEDIATELY — never wait on auto-context / network first.
    const userMsg: Message = { id: uid(), role: 'user', content: text, kind };
    setMessages(m => [...m, userMsg]);
    setLoading(true);
    setError(null);

    const callAgent = async (
      history: Array<{ role: string; content: string }>,
      systemPrompt: string,
      sid: string | null,
      prov: string,
      mod: string,
    ): Promise<string> => {
      const chatEndpoint = `${API_URL}/agent-chat`;
      const chatHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sid) chatHeaders['X-Sandbox-Session'] = sid;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
      try {
        const res = await fetch(chatEndpoint, {
          method: 'POST',
          headers: chatHeaders,
          body: JSON.stringify({ messages: history, systemPrompt, provider: prov, model: mod }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
          throw new Error(d.error ?? `HTTP ${res.status}`);
        }
        const data = await res.json() as { reply?: string };
        return data.reply ?? '(empty response)';
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      // 2) Optional auto-context, hard-capped so a hung /search can't eat the send.
      // Use the RETURNED hits/files — React setState is not flushed yet.
      let freshHits: SearchHit[] | null = null;
      let freshFiles: Map<string, string> | null = null;
      const before = latestRef.current.onBeforeSend;
      if (before && kind === 'user') {
        const result = await withTimeout(before(text), BEFORE_SEND_TIMEOUT_MS);
        if (result) {
          freshHits = result.hits;
          freshFiles = result.files;
        }
      }

      const {
        repoRoot: root, sandboxId: sid, provider: prov, model: mod,
        tree: tr, contextFiles: pinned, searchHits: propHits,
        autoRun: ar, onRunCode: run, onFileChanges: onFc,
        messages: prev,
      } = latestRef.current;

      const hits = freshHits ?? propHits;
      const ctx = new Map(pinned);
      if (freshFiles) {
        for (const [p, c] of freshFiles) {
          if (!ctx.has(p)) ctx.set(p, c);
        }
      }

      // After await, React may already have flushed userMsg into state — don't duplicate.
      // Never send welcome / legacy example blurb to the model.
      const withUser = prev.some(m => m.id === userMsg.id) ? prev : [...prev, userMsg];
      const history = trimMessageHistory(
        withUser
          .filter(m =>
            (m.role === 'user' || m.role === 'assistant')
            && m.kind !== 'welcome'
            && !looksLikeLegacyWelcome(m.content),
          )
          .map(m => ({ role: m.role, content: m.content })),
      );

      const suggestTurn = kind === 'user' && looksLikeSuggestRequest(text);
      const applyTurn = kind === 'user' && looksLikeApplyRequest(text);

      // Light chat ("hey", "thanks"): don't paste tree/files into the model.
      const lightTurn = !needsCodeContext(text);
      let systemPrompt = buildSystemPrompt(
        root,
        lightTurn ? [] : tr,
        ctx,
        lightTurn ? [] : hits,
        { light: lightTurn && !!root && ctx.size === 0 },
      );
      if (suggestTurn) {
        systemPrompt +=
          '\n\nTHIS TURN IS SUGGEST-ONLY. The user wants recommendations, not code writes. ' +
          'Plain prose only. No File: blocks. No claiming anything was fixed or saved. ' +
          'Ground every point in real paths from the provided context.';
      } else if (applyTurn) {
        systemPrompt +=
          '\n\nTHIS TURN IS APPLY MODE. The user asked you to write changes. ' +
          'Output File: blocks for the sandbox. Do not push to GitHub.';
      }

      // Always hit agent-chat — it accepts systemPrompt. /api/chat ignores it
      // and is the main-chat persona endpoint, not the agent.
      let reply = await callAgent(history, systemPrompt, sid, prov, mod);
      let segs  = parseSegments(reply);
      let fc    = extractFileChanges(reply);

      // Suggest-only: ignore any File: blocks the model wrongly emitted.
      if (suggestTurn) {
        fc = [];
        segs = segs.map(s =>
          s.type === 'file-change'
            ? { type: 'text' as const, content: `(Suggestion for ${s.path} — not saved. Say “apply this” if you want it written.)` }
            : s,
        );
      }

      setMessages(m => [...m, {
        id: uid(), role: 'assistant', content: reply, segments: segs, fileChanges: fc,
      }]);

      // Only nudge for explicit APPLY asks — never for suggestions/reviews.
      const shouldNudge = fc.length === 0
        && kind === 'user'
        && applyTurn
        && !suggestTurn
        && (!!root || ctx.size > 0);

      if (shouldNudge) {
        const nudgeMsg: Message = {
          id: uid(), role: 'user', content: NUDGE_PROMPT, kind: 'retry-inject',
        };
        setMessages(m => [...m, nudgeMsg]);

        const nudgedHistory = [
          ...history,
          { role: 'assistant', content: reply },
          { role: 'user', content: NUDGE_PROMPT },
        ];
        reply = await callAgent(nudgedHistory, systemPrompt, sid, prov, mod);
        segs  = parseSegments(reply);
        fc    = extractFileChanges(reply);

        setMessages(m => [...m, {
          id: uid(), role: 'assistant', content: reply, segments: segs, fileChanges: fc,
        }]);
      }

      // Never write files on a suggest turn.
      if (fc.length > 0 && !suggestTurn) await onFc(fc);

      if (ar && !suggestTurn) {
        for (const seg of segs) {
          if (seg.type === 'code' && seg.content.trim()) run(seg.content, seg.lang);
        }
      }

      return fc;
    } catch (e: unknown) {
      const msg = friendlyError(e instanceof Error ? e.message : String(e));
      setError(msg);
      setMessages(m => [...m, { id: uid(), role: 'assistant', content: `⚠ ${msg}` }]);
      return [];
    } finally {
      setLoading(false);
      sendingRef.current = false;
    }
  }, []);

  // Expose imperative handle to parent (used by the verify loop)
  useImperativeHandle(ref, () => ({
    programmaticSend: (text, role = 'retry-inject') => sendText(text, role),
  }), [sendText]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sendingRef.current) return;
    setInput('');
    await sendText(text, 'user');
  }, [input, sendText]);

  return (
    <div data-testid="chat-pane" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
      background: '#0a0a0a', fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>

      {/* header */}
      <div style={{ padding: '7px 12px', borderBottom: '1px solid #1e1e1e',
        background: '#0f0f0f', flexShrink: 0, display: 'flex',
        alignItems: 'center', gap: 10 }}>
        <span style={{ color: '#d4ff3f', fontSize: 10, letterSpacing: '0.1em',
          textTransform: 'uppercase' }}>// agent</span>
        {(autoSelectedFiles.length > 0 || contextFiles.size > 0) && (
          <span style={{ fontSize: 10, color: '#555' }}>
            reading {Math.max(autoSelectedFiles.length, contextFiles.size)} file
            {Math.max(autoSelectedFiles.length, contextFiles.size) !== 1 ? 's' : ''} for you
          </span>
        )}
        {error && <span style={{ fontSize: 10, color: '#ff6a6a', marginLeft: 'auto' }}>
          ✗ {error}
        </span>}
      </div>

      {/* Friendly status — no jargon about snippets/tokens/bundles */}
      {autoSelectedFiles.length > 0 && (
        <div style={{ padding: '5px 12px', background: 'rgba(212,255,63,.05)',
          borderBottom: '1px solid rgba(212,255,63,.15)', flexShrink: 0,
          fontSize: 10, color: '#8fa62b', lineHeight: 1.6 }}>
          <span style={{ fontWeight: 700 }}>Looking at:</span>{' '}
          {autoSelectedFiles.map(p => p.split('/').pop() || p).join(', ')}
        </div>
      )}

      {/* messages */}
      <div data-testid="chat-messages" style={{ flex: 1, overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        {messages.map(msg => (
          <div key={msg.id} data-testid={msg.role === 'user' ? 'user-msg' : 'assistant-msg'} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: msg.role === 'user' ? '75%' : '100%',
            width: msg.role === 'assistant' ? '100%' : undefined,
          }}>
            {msg.role === 'user' && msg.kind === 'retry-inject' ? (
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
            ) : (
              <AssistantBody msg={msg} appliedPaths={appliedPaths} onRunCode={onRunCode} />
            )}
          </div>
        ))}
        {loading && (
          <div data-testid="thinking" style={{ alignSelf: 'flex-start', fontSize: 12, color: '#555' }}>
            thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <form data-testid="chat-form" onSubmit={e => { e.preventDefault(); void send(); }}
        style={{ borderTop: '1px solid #1e1e1e', padding: '10px 12px',
          display: 'flex', gap: 8, flexShrink: 0, alignItems: 'flex-end',
          background: '#0a0a0a' }}>
        <textarea
          id="chat-input"
          data-testid="chat-input"
          value={input}
          rows={2}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          placeholder="Suggest fixes, or say “apply this” to save (Enter to send)"
          disabled={loading}
          style={{ flex: 1, background: '#111', color: '#e8e8e8',
            border: '1px solid #2a2a2a', borderRadius: 4,
            padding: '7px 10px', fontFamily: 'inherit', fontSize: 16,
            outline: 'none', resize: 'vertical', minHeight: 48, maxHeight: 120,
            opacity: loading ? .6 : 1 }} />
        <button type="submit" data-testid="chat-send" disabled={!input.trim() || loading}
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
