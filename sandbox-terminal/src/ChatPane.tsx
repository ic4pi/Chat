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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { PendingChange } from './useRepoContext.js';
import type { FileNode } from './types.js';
import {
  extractFileChangeReport,
  formatRejectedSandboxWarning,
  looksLikeApplyRequest,
  looksLikeSuggestRequest,
  looksLikeLegacyWelcome,
  needsCodeContext,
  nudgeAfterRejects,
  NUDGE_PROMPT,
} from './agentParse.js';
import {
  MAX_TREE_PATHS,
  packContextFiles,
  formatSearchHits,
  trimMessageHistory,
  type SearchHit,
} from './contextBudget.js';
import { copyText, downloadTextFile } from './downloadFile.js';
import { loadPaidPassword } from './providerPrefs.js';
import {
  cleanForSpeech,
  getSpeechRecognition,
  loadSpeakPref,
  saveSpeakPref,
  speakReply,
  stopSpeech,
} from './workspaceVoice.js';

export {
  extractFileChangeReport,
  extractFileChanges,
  formatRejectedSandboxWarning,
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
/** Above Pro agent-chat abort (~280s) so the API's clear error wins. */
const CHAT_TIMEOUT_MS = 300_000;
/** Outer ceiling a reasoning model can earn by staying visibly active
 *  (see extendDeadlineOnThinking) — a firm stop against a truly runaway
 *  stream, not a target every request is expected to use. */
const MAX_CHAT_TIMEOUT_MS = 900_000;
/** Skip corrective nudge only when the whole Pro window is nearly spent. */
const NUDGE_BUDGET_MS = 240_000;
/** Retry caps for callAgentWithContinue — higher for a reasoning model that
 *  burned its whole window thinking with no answer yet (give it more shots
 *  at actually answering); the lower cap is enough for finishing an
 *  already-mostly-written reply that just got cut off mid-output. */
const EMPTY_THINK_MAX_CONTINUES = 5;
const MID_OUTPUT_MAX_CONTINUES = 2;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  repoRoot: string,
  tree: FileNode[],
  contextFiles: Map<string, string>,
  searchHits: SearchHit[],
  opts?: {
    light?: boolean;
    repoUrl?: string | null;
    pythonReady?: boolean | null;
    pythonDetail?: string | null;
    rustReady?: boolean | null;
    rustDetail?: string | null;
    goReady?: boolean | null;
    goDetail?: string | null;
  },
): string {
  const parts: string[] = [];
  const light = !!opts?.light;
  const repoUrl = opts?.repoUrl || '';
  const pythonReady = opts?.pythonReady;
  const pythonDetail = opts?.pythonDetail || '';
  const rustReady = opts?.rustReady;
  const rustDetail = opts?.rustDetail || '';
  const goReady = opts?.goReady;
  const goDetail = opts?.goDetail || '';

  parts.push(
    'You are a coding agent for the user\'s opened GitHub repo in a cloud sandbox.',
    'Act like a senior engineer: correct, complete code — not sketches.',
    'Be direct. No tutorials. No fake example tasks. No <placeholders>, TODOs, or "your-token-here".',
    'Every code file you output must be COMPLETE and ready to save.',
    '',
    'HOW THIS WORKSPACE WORKS (read carefully):',
    '- You do NOT have interactive shell/tool calls in this chat.',
    '- Two ways to change the repo — pick the smaller one that does the job:',
    '',
    '  1) EDIT an existing file (PREFERRED for existing files — smaller, safer, cannot truncate mid-file):',
    '     Edit: <relative-path>',
    '     <<<<<<< SEARCH',
    '     <text copied EXACTLY from the current file — every space, every line>',
    '     =======',
    '     <the replacement text>',
    '     >>>>>>> REPLACE',
    '     - SEARCH must be copied verbatim from the file as it exists in context. If it does not match',
    '       character-for-character, the edit is rejected and nothing is written.',
    '     - Keep SEARCH as SHORT as possible while still being unique in the file — a few lines around',
    '       the change, not the whole function, unless the whole function is what is changing.',
    '     - Multiple Edit: blocks for the same file are applied in the order you write them, each',
    '       against the result of the one before it — so you can make several small changes to one file.',
    '',
    '  2) WRITE a brand-new file, or fully replace one on explicit request (FULL contents only):',
    '     File: <relative-path>',
    '     ```lang',
    '     <complete file content — every line, no omissions>',
    '     ```',
    '',
    '- The host writes accepted blocks to the sandbox. After accepted writes, the HOST runs Auto-test /',
    '  static smoke and may inject failures back to you.',
    '- Untitled ``` code blocks can be run via ▶ Run in Sandbox — they do not write files.',
    '- Do not claim you already ran tests or saved files unless you emitted accepted blocks.',
    '',
    'HARD RULE — NEVER DEGRADE THIS SANDBOX:',
    '- Incomplete File:/Edit: blocks are REJECTED before write. Nothing partial is saved.',
    '- Inside a File: block specifically, forbidden: stubs, "// ... existing imports ...",',
    '  "// ... existing code ...", "Then in handler:", "rest of file unchanged" — if you are rewriting a',
    '  whole file, write the WHOLE file. (That is exactly what Edit: blocks exist to avoid needing.)',
    '- If a File: block is long, still output the ENTIRE file — or better, use Edit: blocks instead so',
    '  there is nothing large enough to truncate.',
    '- Truncating api/*.js or lib/sandbox-api/* has taken production to HTTP 500. Prefer Edit: blocks',
    '  for changes to these files so a token-limit cutoff can never corrupt them mid-file.',
    '- Never claim a fix was applied unless you emitted complete accepted blocks.',
    '',
    'SANDBOX FACTS (do not invent limitations):',
    '- This is a Vercel Sandbox microVM (Amazon Linux 2023), NOT a local laptop.',
    '- Package manager is dnf (or yum), NEVER apt-get.',
    '- Python: Terminal PATH prefers /vercel/sandbox/venv/bin — use pip/python there.',
    '- Prefer: /vercel/sandbox/venv/bin/pip install <pkg> && /vercel/sandbox/venv/bin/python script.py',
    '- Rust: rustc + cargo are provisioned (dnf or rustup into /vercel/sandbox/cargo). Use cargo test / rustc.',
    '- Go: `go` is provisioned via dnf golang. Use go test ./... / go run / go build.',
    '- NEVER say you cannot run Python/Rust/Go because apt-get/Docker/slim images are missing.',
    '- NEVER tell the user to run install commands on their laptop for basic toolchains.',
    '- If a package is missing, say which install command the Terminal should run (pip/cargo/go/dnf).',
    '',
    'If the user wants changes written: output File: blocks with FULL file contents.',
    'If they only want advice: plain English, cite real paths from context. Do not dump untitled example code.',
    'Never invent paths. Use only paths from the tree / open files / search hits.',
    '',
    'QUALITY BAR (websites / apps):',
    '- Ship something that looks finished: real <title>, working CSS, readable layout, no broken local asset links.',
    '- After writing files, the host runs Auto-test / static smoke in this sandbox. Fix failures until green.',
    '- NEVER tell the user to Push, or claim the work is done, until sandbox tests/smoke have passed.',
    '- If smoke fails on title/layout/assets, fix the HTML/CSS completely in File: blocks and let Auto-test re-run.',
  );

  if (pythonReady === true) {
    parts.push(
      '',
      'PYTHON STATUS: READY in this sandbox.',
      pythonDetail ? `Detail: ${pythonDetail}` : '',
      'Python is ready — prefer File: scripts + host Auto-test / ▶ Run. Do not ask the user to install Python locally.',
    );
  } else if (pythonReady === false) {
    parts.push(
      '',
      'PYTHON STATUS: NOT READY yet.',
      pythonDetail ? `Detail: ${pythonDetail}` : '',
      'Tell the user to re-open the repo (left panel → Open) so Python provisions, then retry.',
      'Do not invent apt-get/Docker workarounds.',
    );
  } else {
    parts.push(
      '',
      'PYTHON STATUS: unknown until a repo is opened. After Open, python/pip live in /vercel/sandbox/venv.',
    );
  }

  if (rustReady === true) {
    parts.push(
      '',
      'RUST STATUS: READY (rustc + cargo) in this sandbox.',
      rustDetail ? `Detail: ${rustDetail}` : '',
      'Rust is ready — prefer cargo/rustc via Terminal or host Auto-test. Do not ask the user to install Rust locally.',
    );
  } else if (rustReady === false) {
    parts.push(
      '',
      'RUST STATUS: NOT READY yet.',
      rustDetail ? `Detail: ${rustDetail}` : '',
      'Tell the user to re-open the repo so Rust provisions, then retry. Do not invent apt-get workarounds.',
    );
  } else {
    parts.push(
      '',
      'RUST STATUS: unknown until a repo is opened. After Open, rustc/cargo should be on PATH.',
    );
  }

  if (goReady === true) {
    parts.push(
      '',
      'GO STATUS: READY in this sandbox.',
      goDetail ? `Detail: ${goDetail}` : '',
      'Go is ready — prefer go test/run via Terminal or host Auto-test. Do not ask the user to install Go locally.',
    );
  } else if (goReady === false) {
    parts.push(
      '',
      'GO STATUS: NOT READY yet.',
      goDetail ? `Detail: ${goDetail}` : '',
      'Tell the user to re-open the repo so Go provisions, then retry. Do not invent apt-get workarounds.',
    );
  } else {
    parts.push(
      '',
      'GO STATUS: unknown until a repo is opened. After Open, `go` should be on PATH.',
    );
  }

  if (repoUrl) {
    parts.push('', `GitHub repo URL: ${repoUrl}`);
  }
  if (repoRoot) {
    parts.push(`Sandbox path: ${repoRoot}`);
    if (light) {
      parts.push('Light turn — answer briefly; no file dump this message.');
      return parts.join('\n');
    }
  }

  if (tree.length > 0) {
    const flatPaths = flattenTree(tree).filter(p =>
      !p.includes('node_modules') &&
      !p.includes('/dist/') &&
      !p.startsWith('dist/') &&
      !p.includes('public/agent/assets'),
    );
    const shown = flatPaths.slice(0, Math.min(MAX_TREE_PATHS, 80));
    parts.push('', 'File tree:', shown.join('\n'));
    if (flatPaths.length > shown.length) {
      parts.push(`… (${flatPaths.length - shown.length} more omitted)`);
    }
  }

  const hitBlock = formatSearchHits(searchHits);
  if (hitBlock) parts.push('', hitBlock);

  const packed = packContextFiles(contextFiles);
  if (packed.size > 0) {
    parts.push('', '── Open files (full) ──');
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
  if (lower.includes('http 504') || lower.includes('504') || lower.includes('gateway timeout')) {
    return 'Workspace hit the server time limit before the model finished. Try a faster model, or ask to fix one file at a time.';
  }
  return raw || 'Request failed';
}

type AgentReply = { reply: string; incomplete?: boolean; timedOut?: boolean; reasoning?: string };

/** True when the model was cut off mid File:/fence — worth one continuation turn. */
function looksTruncatedReply(text: string): boolean {
  if (!text || text === '(empty response)') return false;
  const fences = (text.match(/```/g) || []).length;
  if (fences % 2 === 1) return true;
  if (/\bFile:\s+\S+\s*$/m.test(text) && !/```[\s\S]*```\s*$/.test(text)) return true;
  // Ends mid-statement without a closing fence after a File: header
  if (/\bFile:\s+\S+/i.test(text) && !/```\s*$/.test(text.trim()) && text.length > 2_000) {
    const lastFence = text.lastIndexOf('```');
    if (lastFence >= 0) {
      const after = text.slice(lastFence + 3);
      // opened a fence and never closed it
      if (!after.includes('```') && after.length > 200) return true;
    }
  }
  return false;
}

function mergeContinuation(prev: string, next: string): string {
  const a = prev.replace(/\s+$/, '');
  const b = next.replace(/^\s+/, '');
  // Model often restarts the open fence — strip a duplicated opener.
  if (a.endsWith('```') || /```[a-zA-Z0-9_+\-.]*$/.test(a)) {
    return `${a}\n${b}`;
  }
  if (b.startsWith('```') && (a.match(/```/g) || []).length % 2 === 1) {
    // Continuation reopened the fence — keep body only
    const nl = b.indexOf('\n');
    return nl >= 0 ? `${a}\n${b.slice(nl + 1)}` : a + b;
  }
  return `${a}\n${b}`;
}

/** Read SSE from /api/agent-chat (stream:true). Falls back if the body is plain JSON.
 *  onEvent receives status/token/thinking/done/error for live UI updates.
 */
async function readAgentReply(
  res: Response,
  onEvent?: (ev: { type?: string; text?: string; message?: string }) => void,
): Promise<AgentReply> {
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/event-stream') || !res.body) {
    const data = await res.json() as { reply?: string; error?: string; incomplete?: boolean };
    if (data.error && !data.reply) throw new Error(data.error);
    return { reply: data.reply ?? '(empty response)', incomplete: !!data.incomplete };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let reasoning = '';
  let incomplete = false;
  let timedOut = false;
  let streamError: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev: {
          type?: string;
          text?: string;
          message?: string;
          reply?: string;
          error?: string;
          partialReply?: string;
          reasoning?: string;
          incomplete?: boolean;
          timedOut?: boolean;
        };
        try { ev = JSON.parse(payload); } catch { continue; }
        onEvent?.(ev);
        if (ev.type === 'token' && typeof ev.text === 'string') {
          reply += ev.text;
        } else if (ev.type === 'thinking' && typeof ev.text === 'string') {
          reasoning += ev.text;
        } else if (ev.type === 'done' && typeof ev.reply === 'string') {
          reply = ev.reply;
          incomplete = !!ev.incomplete;
          timedOut = !!ev.timedOut;
          if (typeof ev.reasoning === 'string' && ev.reasoning) reasoning = ev.reasoning;
        } else if (ev.type === 'error') {
          streamError = ev.error || 'Stream error';
          if (typeof ev.partialReply === 'string' && ev.partialReply.trim()) {
            reply = ev.partialReply;
            incomplete = true;
          }
          if (typeof ev.reasoning === 'string' && ev.reasoning.trim()) {
            reasoning = ev.reasoning;
          }
        }
      }
    }
  }

  // Reasoning-only timeout: treat as incomplete so Workspace can continue.
  if (timedOut && !reply.trim() && reasoning.trim()) {
    return { reply: '', incomplete: true, timedOut: true, reasoning };
  }
  if (streamError && !reply.trim()) throw new Error(streamError);
  return { reply: reply || '(empty response)', incomplete, timedOut, reasoning: reasoning || undefined };
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

function FileChangeBlock({ path, content, isApplied }: {
  path: string; lang: string; content: string;
  isApplied: boolean; onRun: () => void;
}) {
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = content.split('\n').length;
  return (
    <div style={{ margin: '8px 0', border: '1px solid rgba(52,211,153,.16)',
      borderRadius: 6, background: 'rgba(52,211,153,.16)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '5px 10px', borderBottom: '1px solid rgba(52,211,153,.16)', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: '#34D399', fontWeight: 700 }}>FILE</span>
          <span style={{ fontSize: 11, color: '#ECEEF3', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
          <span style={{ fontSize: 10, color: '#656C7E' }}>{lines} lines</span>
          {isApplied && <span style={{ fontSize: 10, color: '#FF3D8E' }}>✓ saved</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button"
            onClick={() => downloadTextFile(path, content)}
            style={{ background: '#FF3D8E', color: '#0B0D12', border: 'none',
              borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
            Download
          </button>
          <button type="button"
            onClick={async () => {
              const ok = await copyText(content);
              if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
            }}
            style={{ background: 'transparent', color: copied ? '#FF3D8E' : '#34D399',
              border: '1px solid rgba(52,211,153,.16)', borderRadius: 4, padding: '3px 8px',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={() => setShowCode(s => !s)}
            style={{ background: 'transparent', color: '#656C7E', border: 'none',
              fontSize: 11, cursor: 'pointer', padding: 0 }}>
            {showCode ? 'hide' : 'show'}
          </button>
        </div>
      </div>
      {showCode && (
        <pre style={{ margin: 0, padding: '8px 12px', overflowX: 'auto',
          fontSize: 11.5, lineHeight: 1.5, color: '#ECEEF3', maxHeight: 400 }}>
          {content}
        </pre>
      )}
    </div>
  );
}

function CodeBlock({ lang, content, onRun }: {
  lang: string; content: string; onRun: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ margin: '8px 0', background: '#0B0D12',
      border: '1px solid #232838', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 10px', borderBottom: '1px solid #191D27', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#656C7E', textTransform: 'uppercase',
          letterSpacing: '0.1em' }}>{lang || 'code'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" data-testid="copy-code-btn"
            onClick={async () => {
              const ok = await copyText(content);
              if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
            }}
            style={{ background: 'transparent', color: copied ? '#FF3D8E' : '#34D399',
              border: '1px solid rgba(52,211,153,.16)', borderRadius: 4, padding: '2px 10px',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 11 }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={onRun} data-testid="run-code-btn"
            style={{ background: 'rgba(52,211,153,.16)', color: '#34D399', border: '1px solid rgba(52,211,153,.16)',
              borderRadius: 4, padding: '2px 10px', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
            ▶ Run in Sandbox
          </button>
        </div>
      </div>
      <pre style={{ margin: 0, padding: '8px 12px', overflowX: 'auto',
        fontSize: 12, lineHeight: 1.5, color: '#ECEEF3',
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
              color: '#ECEEF3', whiteSpace: 'pre-wrap' }}>{seg.content.trim()}</p>
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
      color: '#ECEEF3', whiteSpace: 'pre-wrap' }}>{msg.content}</p>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  id:          string;
  role:        'user' | 'assistant';
  content:     string;
  /** welcome = UI-only, never sent to the model; retry-inject = verify/nudge loop */
  kind?:       'user' | 'retry-inject' | 'welcome' | 'imported';
  segments?:   Segment[];
  fileChanges?: PendingChange[];
}

let _id = 0;
const uid = () => String(++_id);

// ---------------------------------------------------------------------------
// ChatPane
// ---------------------------------------------------------------------------

export interface PendingUpload {
  kind: 'text' | 'image';
  name: string;
  content: string;
}

interface Props {
  repoRoot:          string;
  repoUrl:           string | null;
  sandboxId:         string | null;
  provider:          string;
  model:             string;
  /** Active role — plan stays prose-first until user asks to apply. */
  role?:             string;
  /** BYOK key for the active provider (optional). */
  apiKey?:           string;
  tree:              FileNode[];
  contextFiles:      Map<string, string>;
  autoRun:           boolean;
  appliedPaths:      Set<string>;
  autoSelectedFiles: string[];
  searchHits:        SearchHit[];
  /** Restored chat from localStorage (no welcome fluff). */
  initialMessages?:  Message[];
  onMessagesChange?: (messages: Message[]) => void;
  onRunCode:         (code: string, lang: string)    => void;
  /** May apply writes; awaited so auto-apply finishes before send returns. */
  onFileChanges:     (changes: PendingChange[])      => void | Promise<void>;
  /** Inject uploaded text files into context. */
  onUploadText?:     (name: string, content: string) => void;
  /** Returns fresh search hits + ephemeral full files for THIS send (avoids stale React state). */
  onBeforeSend?:     (query: string) => Promise<{
    hits: SearchHit[];
    files: Map<string, string>;
  } | void>;
  /** From /api/init-repo — whether the sandbox toolchains are actually usable. */
  pythonReady?:      boolean | null;
  pythonDetail?:     string | null;
  rustReady?:        boolean | null;
  rustDetail?:       string | null;
  goReady?:          boolean | null;
  goDetail?:         string | null;
}

export const ChatPane = forwardRef<ChatHandle, Props>(function ChatPane({
  repoRoot, repoUrl, sandboxId, provider, model, role, apiKey, tree, contextFiles, autoRun, appliedPaths,
  autoSelectedFiles, searchHits, initialMessages, onMessagesChange,
  onRunCode, onFileChanges, onUploadText, onBeforeSend,
  pythonReady = null, pythonDetail = null,
  rustReady = null, rustDetail = null,
  goReady = null, goDetail = null,
}, ref) {
  const [messages,  setMessages]  = useState<Message[]>(() => initialMessages ?? []);
  const [input,    setInput]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const [liveThoughts, setLiveThoughts] = useState('');
  const [error,    setError]    = useState<string | null>(null);
  const [uploads,  setUploads]  = useState<PendingUpload[]>([]);
  const [speakOn,  setSpeakOn]  = useState(() => loadSpeakPref());
  const [listening, setListening] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const recognitionRef = useRef<ReturnType<typeof getSpeechRecognition>>(null);
  const speakOnRef = useRef(speakOn);
  speakOnRef.current = speakOn;

  // Keep latest props in a ref so a send started before auto-context finishes
  // still sees the updated file context afterward.
  const latestRef = useRef({
    repoRoot, repoUrl, sandboxId, provider, model, role, apiKey, tree, contextFiles, searchHits,
    autoRun, onRunCode, onFileChanges, onBeforeSend, messages, pythonReady, pythonDetail,
    rustReady, rustDetail, goReady, goDetail,
  });
  latestRef.current = {
    repoRoot, repoUrl, sandboxId, provider, model, role, apiKey, tree, contextFiles, searchHits,
    autoRun, onRunCode, onFileChanges, onBeforeSend, messages, pythonReady, pythonDetail,
    rustReady, rustDetail, goReady, goDetail,
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, liveThoughts]);

  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages, onMessagesChange]);

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
    setLiveThoughts('');
    setError(null);

    const callAgent = async (
      history: Array<{ role: string; content: string | unknown }>,
      systemPrompt: string,
      sid: string | null,
      prov: string,
      mod: string,
      key?: string,
    ): Promise<AgentReply> => {
      const chatEndpoint = `${API_URL}/agent-chat`;
      const chatHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sid) chatHeaders['X-Sandbox-Session'] = sid;
      if (key) chatHeaders['X-Provider-Key'] = key;
      const paidPw = loadPaidPassword();
      if (paidPw) chatHeaders['X-Paid-Password'] = paidPw;

      const controller = new AbortController();
      // Only a model that's actually still working earns more time — the
      // deadline starts at the normal CHAT_TIMEOUT_MS and only gets pushed
      // out, up to MAX_CHAT_TIMEOUT_MS total, each time real data actually
      // arrives: either reasoning ('thinking') deltas OR ordinary output
      // tokens. A long file takes a long time to stream out even with no
      // reasoning phase at all — that's still visible, active progress, not
      // a stuck request, and deserves the same credit. A model that goes
      // truly silent (stuck, or a dead connection) still gets cut at the
      // original 300s; nothing changes for that case.
      const requestStartedAt = Date.now();
      let timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
      const extendDeadlineOnActivity = () => {
        if (Date.now() - requestStartedAt >= MAX_CHAT_TIMEOUT_MS) return;
        clearTimeout(timer);
        const remaining = MAX_CHAT_TIMEOUT_MS - (Date.now() - requestStartedAt);
        timer = setTimeout(() => controller.abort(), Math.min(CHAT_TIMEOUT_MS, remaining));
      };
      try {
        const res = await fetch(chatEndpoint, {
          method: 'POST',
          headers: chatHeaders,
          body: JSON.stringify({
            messages: history,
            systemPrompt,
            provider: prov,
            model: mod,
            apiKey: key || undefined,
            paidPassword: paidPw || undefined,
            stream: true,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const ctype = (res.headers.get('content-type') || '').toLowerCase();
          if (ctype.includes('application/json')) {
            const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
            throw new Error(d.error ?? `HTTP ${res.status}`);
          }
          throw new Error(`HTTP ${res.status}`);
        }
        return await readAgentReply(res, (ev) => {
          if (ev.type === 'thinking' && typeof ev.text === 'string' && ev.text) {
            setLiveThoughts((prev) => prev + ev.text);
            extendDeadlineOnActivity();
          } else if (ev.type === 'token' && typeof ev.text === 'string' && ev.text) {
            extendDeadlineOnActivity();
          }
        });
      } finally {
        clearTimeout(timer);
      }
    };

    const sendStartedAt = Date.now();

    const callAgentWithContinue = async (
      history: Array<{ role: string; content: string | unknown }>,
      systemPrompt: string,
      sid: string | null,
      prov: string,
      mod: string,
      key?: string,
    ): Promise<string> => {
      let result = await callAgent(history, systemPrompt, sid, prov, mod, key);
      let reply = result.reply;
      let continues = 0;
      let emptyThink = result.timedOut && (!reply.trim() || reply === '(empty response)');
      // The higher retry budget is only for a *genuine* reasoning timeout —
      // gated on actually having seen reasoning content, not just "timed out
      // with nothing to show" (that can happen to any model for unrelated
      // reasons — a slow provider, a network hiccup — and giving those 5
      // retries instead of 2 just makes a stuck request take 4x longer to
      // give up, for a model that was never "thinking" at all).
      let hadReasoningEvidence = !!result.reasoning?.trim();
      // Continue when max_tokens / timeout cut mid File: block, or when the
      // model burned the window on thinking with no answer text yet. The cap
      // depends on which of those is currently happening — recomputed below
      // after every continuation, since a request can shift from one to the
      // other (e.g. finally producing text, then getting cut off mid-output).
      while (
        continues < (emptyThink && hadReasoningEvidence ? EMPTY_THINK_MAX_CONTINUES : MID_OUTPUT_MAX_CONTINUES)
        && (
          result.incomplete
          || looksTruncatedReply(reply)
          || emptyThink
        )
        && (Date.now() - sendStartedAt) < NUDGE_BUDGET_MS * 2
      ) {
        continues += 1;
        const contPrompt = emptyThink
          ? 'Previous attempt timed out during thinking before any answer text. '
            + 'Answer now with complete File: / fenced blocks. Spend less time thinking.'
          : 'Your previous reply was cut off mid-output. Continue EXACTLY from where you left off. '
            + 'Finish any open File: / fenced blocks with COMPLETE file contents. '
            + 'Do not restart files you already finished. Do not apologize.';
        const contHistory = emptyThink
          ? [...history, { role: 'user', content: contPrompt }]
          : [
              ...history,
              { role: 'assistant', content: reply },
              { role: 'user', content: contPrompt },
            ];
        setLiveThoughts('');
        result = await callAgent(contHistory, systemPrompt, sid, prov, mod, key);
        reply = emptyThink
          ? result.reply
          : mergeContinuation(reply, result.reply);
        emptyThink = result.timedOut && (!reply.trim() || reply === '(empty response)');
        hadReasoningEvidence = !!result.reasoning?.trim();
        if (!result.incomplete && !looksTruncatedReply(result.reply) && result.reply.trim() && result.reply !== '(empty response)') {
          break;
        }
      }
      return reply;
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
        repoRoot: root, repoUrl: rUrl, sandboxId: sid, provider: prov, model: mod,
        role: activeRole, apiKey: key, tree: tr, contextFiles: pinned, searchHits: propHits,
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
          .map(m => ({ role: m.role, content: m.content as string | unknown })),
      );

      // Attach pending images to the latest user turn (vision-capable models).
      const pendingImages = (latestRef.current as { _pendingImages?: Array<{ type: 'image_url'; image_url: { url: string } }> })._pendingImages;
      if (pendingImages?.length && history.length > 0) {
        const last = history[history.length - 1];
        if (last.role === 'user' && typeof last.content === 'string') {
          last.content = [
            { type: 'text', text: last.content },
            ...pendingImages,
          ];
        }
        (latestRef.current as { _pendingImages?: unknown })._pendingImages = undefined;
      }

      const suggestTurn = kind === 'user' && (
        looksLikeSuggestRequest(text) || activeRole === 'plan' || activeRole === 'review'
      );
      const applyTurn = kind === 'user' && looksLikeApplyRequest(text) && activeRole !== 'plan';

      // Light chat ("hey", "thanks"): don't paste tree/files into the model.
      const lightTurn = !needsCodeContext(text);
      let systemPrompt = buildSystemPrompt(
        root,
        lightTurn ? [] : tr,
        ctx,
        lightTurn ? [] : hits,
        {
          light: lightTurn && !!root && ctx.size === 0,
          repoUrl: rUrl,
          pythonReady: latestRef.current.pythonReady,
          pythonDetail: latestRef.current.pythonDetail,
          rustReady: latestRef.current.rustReady,
          rustDetail: latestRef.current.rustDetail,
          goReady: latestRef.current.goReady,
          goDetail: latestRef.current.goDetail,
        },
      );
      if (activeRole === 'plan') {
        systemPrompt +=
          '\n\nROLE=PLAN: architecture and steps only. No File: blocks, no fenced code, no scripts until the user says to apply/implement.';
      } else if (suggestTurn) {
        systemPrompt +=
          '\n\nSUGGEST-ONLY this turn: plain advice, real paths, no File: blocks, no placeholders.';
      } else if (applyTurn) {
        systemPrompt +=
          '\n\nAPPLY this turn: output complete File: blocks only (FULL files). Stubs are rejected and will not save.';
      }

      // Always hit agent-chat — it accepts systemPrompt. /api/chat ignores it
      // and is the main-chat persona endpoint, not the agent.
      let reply = await callAgentWithContinue(history, systemPrompt, sid, prov, mod, key);
      let segs  = parseSegments(reply);
      let report = extractFileChangeReport(reply);
      // Full-file writes (new files / explicit rewrites) + unresolved Edit:
      // blocks (resolved against on-disk content by the caller via onFc).
      let fc: PendingChange[] = [
        ...report.accepted.map(f => ({ path: f.path, content: f.content })),
        ...report.edits.map(e => ({ path: e.path, content: '', edit: e })),
      ];

      // Suggest-only: ignore any File:/Edit: blocks the model wrongly emitted.
      if (suggestTurn) {
        fc = [];
        report = { accepted: [], edits: [], rejected: [] };
        segs = segs.map(s =>
          s.type === 'file-change'
            ? { type: 'text' as const, content: `(Suggestion for ${s.path} — not saved. Say “apply this” if you want it written.)` }
            : s,
        );
      }

      setMessages(m => [...m, {
        id: uid(), role: 'assistant', content: reply, segments: segs, fileChanges: fc,
      }]);
      if (speakOnRef.current && kind === 'user' && cleanForSpeech(reply)) {
        void speakReply(reply);
      }

      // LOUD: stubs never silently disappear — tell the user the sandbox blocked them.
      if (!suggestTurn && report.rejected.length > 0) {
        const warn = formatRejectedSandboxWarning(report.rejected);
        setMessages(m => [...m, { id: uid(), role: 'assistant', content: warn }]);
      }

      // Only nudge for explicit APPLY asks — never for suggestions/reviews.
      // Also nudge when stubs were rejected (sandbox would otherwise stay broken-looking).
      // Skip if the first call already used most of the Pro time window (avoids a second timeout).
      const rejectedFirst = report.rejected;
      const shouldNudge = (fc.length === 0 || rejectedFirst.length > 0)
        && kind === 'user'
        && applyTurn
        && !suggestTurn
        && (!!root || ctx.size > 0)
        && (Date.now() - sendStartedAt) < NUDGE_BUDGET_MS;

      if (shouldNudge) {
        const nudgeText = rejectedFirst.length > 0
          ? nudgeAfterRejects(rejectedFirst)
          : NUDGE_PROMPT;
        const nudgeMsg: Message = {
          id: uid(), role: 'user', content: nudgeText, kind: 'retry-inject',
        };
        setMessages(m => [...m, nudgeMsg]);

        const nudgedHistory = [
          ...history,
          { role: 'assistant', content: reply },
          { role: 'user', content: nudgeText },
        ];
        reply = await callAgentWithContinue(nudgedHistory, systemPrompt, sid, prov, mod, key);
        segs  = parseSegments(reply);
        report = extractFileChangeReport(reply);
        fc = [
          ...report.accepted.map(f => ({ path: f.path, content: f.content })),
          ...report.edits.map(e => ({ path: e.path, content: '', edit: e })),
        ];

        setMessages(m => [...m, {
          id: uid(), role: 'assistant', content: reply, segments: segs, fileChanges: fc,
        }]);
        if (speakOnRef.current && cleanForSpeech(reply)) {
          void speakReply(reply);
        }
        if (report.rejected.length > 0) {
          const warn = formatRejectedSandboxWarning(report.rejected);
          setMessages(m => [...m, { id: uid(), role: 'assistant', content: warn }]);
        }
      }

      // Never write files on a suggest turn. Never write rejected stubs.
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
      setLiveThoughts('');
      sendingRef.current = false;
    }
  }, []);

  // Expose imperative handle to parent (used by the verify loop)
  useImperativeHandle(ref, () => ({
    programmaticSend: (text, role = 'retry-inject') => sendText(text, role),
  }), [sendText]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && uploads.length === 0) || sendingRef.current) return;

    // Text uploads go into context; images ride along on this turn.
    const pending = uploads;
    setUploads([]);
    setInput('');

    let sendBody = text;
    const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    for (const u of pending) {
      if (u.kind === 'text') {
        onUploadText?.(u.name, u.content);
        sendBody += `\n\n[Uploaded file: ${u.name}]\n\`\`\`\n${u.content.slice(0, 80_000)}\n\`\`\``;
      } else {
        imageParts.push({ type: 'image_url', image_url: { url: u.content } });
        sendBody += `\n\n[Uploaded image: ${u.name}]`;
      }
    }
    if (!sendBody.trim() && imageParts.length === 0) return;

    // If images are present, stash them so callAgent history can use multimodal.
    if (imageParts.length > 0) {
      (latestRef.current as { _pendingImages?: typeof imageParts })._pendingImages = imageParts;
    }
    await sendText(sendBody.trim() || '(see attached image)', 'user');
  }, [input, uploads, sendText, onUploadText]);

  const handleFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const next: PendingUpload[] = [];
    for (const file of Array.from(fileList)) {
      if (file.size > 8_000_000) {
        setError(`${file.name} is too large (max 8MB)`);
        continue;
      }
      const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
      const content = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        if (isImage) r.readAsDataURL(file);
        else r.readAsText(file);
      });
      next.push({ kind: isImage ? 'image' : 'text', name: file.name, content });
    }
    if (next.length) setUploads(u => [...u, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const stopMic = useCallback(() => {
    setListening(false);
    try { recognitionRef.current?.stop(); } catch { /* ignore */ }
    recognitionRef.current = null;
  }, []);

  const toggleSpeak = useCallback(() => {
    setSpeakOn(prev => {
      const next = !prev;
      saveSpeakPref(next);
      if (!next) stopSpeech();
      return next;
    });
  }, []);

  const toggleMic = useCallback(() => {
    if (listening) {
      stopMic();
      return;
    }
    stopSpeech();
    const rec = getSpeechRecognition();
    if (!rec) {
      setError('Voice input needs Chrome or Safari with Speech Recognition.');
      return;
    }
    recognitionRef.current = rec;
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    let finalText = '';
    rec.onstart = () => setListening(true);
    rec.onerror = () => stopMic();
    rec.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      const said = finalText.trim();
      if (!said) return;
      if (speakOnRef.current && !sendingRef.current) {
        setInput('');
        void sendText(said, 'user');
      } else {
        setInput(prev => (prev ? `${prev} ${said}` : said));
      }
    };
    rec.onresult = (event) => {
      finalText = '';
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        if (r?.isFinal) finalText += r[0]?.transcript || '';
      }
    };
    try {
      rec.start();
    } catch (err: unknown) {
      stopMic();
      setError(err instanceof Error ? err.message : 'Could not start mic');
    }
  }, [listening, stopMic, sendText]);

  useEffect(() => () => {
    stopMic();
    stopSpeech();
  }, [stopMic]);

  return (
    <div data-testid="chat-pane" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
      background: '#0B0D12', color: '#ECEEF3',
      fontFamily: '"JetBrains Mono",ui-monospace,monospace' }}>

      {/* header */}
      <div style={{ padding: '7px 12px', borderBottom: '1px solid #191D27',
        background: '#0B0D12', flexShrink: 0, display: 'flex',
        alignItems: 'center', gap: 10 }}>
        <span style={{ color: '#FF3D8E', fontSize: 10, letterSpacing: '0.1em',
          textTransform: 'uppercase' }}>// agent</span>
        {(autoSelectedFiles.length > 0 || contextFiles.size > 0) && (
          <span style={{ fontSize: 10, color: '#656C7E' }}>
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
          fontSize: 10, color: '#C81F6B', lineHeight: 1.6 }}>
          <span style={{ fontWeight: 700 }}>Looking at:</span>{' '}
          {autoSelectedFiles.map(p => p.split('/').pop() || p).join(', ')}
        </div>
      )}

      {/* messages */}
      <div data-testid="chat-messages" style={{ flex: 1, overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        {messages.length === 0 && !loading && (
          <div style={{ fontSize: 12, color: '#323A50', lineHeight: 1.5 }}>
            {repoRoot ? 'Ask for a change.' : 'Start a blank project or open a GitHub URL, then ask.'}
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} data-testid={msg.role === 'user' ? 'user-msg' : 'assistant-msg'} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: msg.role === 'user' ? '75%' : '100%',
            width: msg.role === 'assistant' ? '100%' : undefined,
          }}>
            {msg.role === 'user' && msg.kind === 'retry-inject' ? (
              <div style={{ padding: '5px 10px', background: 'rgba(52,211,153,.16)',
                border: '1px dashed rgba(52,211,153,.16)', borderRadius: 6,
                fontSize: 11, color: '#7FE0B8', whiteSpace: 'pre-wrap',
                maxHeight: 160, overflowY: 'auto' }}>
                <span style={{ fontWeight: 700, display: 'block', marginBottom: 3, color: '#FF3D8E' }}>
                  ⟳ Auto-retry — test failure injected
                </span>
                {msg.content.slice(0, 500)}{msg.content.length > 500 ? '…' : ''}
              </div>
            ) : msg.role === 'user' ? (
              <div style={{
                background: 'rgba(52,211,153,.16)',
                border: '1px solid #1FAE7E',
                borderRadius: 8,
                padding: '8px 12px',
                fontSize: 14,
                lineHeight: 1.45,
                color: '#FFD6E8',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                <div style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#FF3D8E',
                  marginBottom: 4,
                }}>
                  You asked
                </div>
                {msg.content}
              </div>
            ) : msg.content.includes('SANDBOX PROTECTED') ? (
              <div data-testid="sandbox-protect-warn" style={{
                background: '#3a1010',
                border: '2px solid #ff6a6a',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 13,
                lineHeight: 1.45,
                color: '#ffd0d0',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontWeight: 600,
              }}>
                {msg.content}
              </div>
            ) : (
              <div>
                <div style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: '#34D399',
                  marginBottom: 4,
                }}>
                  Agent
                </div>
                <AssistantBody msg={msg} appliedPaths={appliedPaths} onRunCode={onRunCode} />
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div data-testid="thinking" style={{ alignSelf: 'flex-start', maxWidth: '92%' }}>
            <div style={{ fontSize: 12, color: '#656C7E', marginBottom: liveThoughts ? 6 : 0 }}>
              thinking…
            </div>
            {liveThoughts ? (
              <pre data-testid="thinking-stream" style={{
                margin: 0,
                maxHeight: 160,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 11,
                lineHeight: 1.45,
                color: '#9198AA',
                background: '#0B0D12',
                border: '1px solid #191D27',
                borderRadius: 4,
                padding: '8px 10px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              }}>{liveThoughts}</pre>
            ) : null}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {uploads.length > 0 && (
        <div style={{ padding: '6px 12px', borderTop: '1px solid #191D27',
          display: 'flex', flexWrap: 'wrap', gap: 6, background: '#0B0D12' }}>
          {uploads.map((u, i) => (
            <span key={`${u.name}-${i}`} style={{
              fontSize: 10, color: '#9198AA', background: '#171B26', border: '1px solid #232838',
              borderRadius: 4, padding: '2px 8px', display: 'inline-flex', gap: 6, alignItems: 'center',
            }}>
              {u.kind === 'image' ? '🖼' : '📄'} {u.name}
              <button type="button" onClick={() => setUploads(list => list.filter((_, j) => j !== i))}
                style={{ background: 'transparent', border: 'none', color: '#656C7E', cursor: 'pointer', padding: 0 }}>×</button>
            </span>
          ))}
        </div>
      )}

      {/* input */}
      <form data-testid="chat-form" onSubmit={e => { e.preventDefault(); void send(); }}
        style={{ borderTop: '1px solid #191D27', padding: '10px 12px',
          display: 'flex', gap: 8, flexShrink: 0, alignItems: 'flex-end',
          background: '#0B0D12' }}>
        <input ref={fileInputRef} type="file" multiple accept="image/*,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.css,.html,.yml,.yaml,.toml,.env,.csv"
          style={{ display: 'none' }}
          onChange={e => { void handleFiles(e.target.files); }} />
        <button type="button" title="Upload photo or file"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          style={{ background: '#171B26', color: '#9198AA', border: '1px solid #232838',
            borderRadius: 4, padding: '8px 10px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 12, alignSelf: 'flex-end' }}>📎</button>
        <button type="button" data-testid="workspace-mic" title={listening ? 'Stop listening' : (speakOn ? 'Voice chat — tap to talk' : 'Dictate into the box')}
          onClick={toggleMic}
          disabled={loading}
          style={{ background: listening ? '#3a1a1a' : '#171B26',
            color: listening ? '#ff8a8a' : '#9198AA',
            border: `1px solid ${listening ? '#6a2a2a' : '#232838'}`,
            borderRadius: 4, padding: '8px 10px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 12, alignSelf: 'flex-end' }}>
          {listening ? '●' : '🎙'}
        </button>
        <button type="button" data-testid="workspace-speak" title={speakOn ? 'Voice replies on — tap to mute' : 'Voice replies off — tap to speak answers'}
          onClick={toggleSpeak}
          style={{ background: speakOn ? 'rgba(52,211,153,.16)' : '#171B26',
            color: speakOn ? '#FF3D8E' : '#9198AA',
            border: `1px solid ${speakOn ? 'rgba(52,211,153,.16)' : '#232838'}`,
            borderRadius: 4, padding: '8px 10px', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 12, alignSelf: 'flex-end' }}>
          {speakOn ? '🔊' : '🔇'}
        </button>
        <textarea
          id="chat-input"
          data-testid="chat-input"
          value={input}
          rows={2}
          onChange={e => setInput(e.target.value)}
          placeholder={loading ? 'Waiting for reply…'
            : listening ? (speakOn ? 'Listening — will send…' : 'Listening…')
            : 'What should change?'}
          disabled={loading}
          style={{ flex: 1, background: '#12151D', color: '#ECEEF3',
            border: '1px solid #232838', borderRadius: 4,
            padding: '7px 10px', fontFamily: 'inherit', fontSize: 16,
            outline: 'none', resize: 'vertical', minHeight: 48, maxHeight: 120,
            WebkitTextFillColor: '#ECEEF3',
            opacity: 1 }} />
        <button type="submit" data-testid="chat-send" disabled={(!input.trim() && uploads.length === 0) || loading}
          style={{ background: (input.trim() || uploads.length) && !loading ? '#FF3D8E' : '#191D27',
            color: (input.trim() || uploads.length) && !loading ? '#0B0D12' : '#9198AA',
            border: 'none', borderRadius: 4, padding: '8px 16px',
            cursor: (input.trim() || uploads.length) && !loading ? 'pointer' : 'default',
            fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
            alignSelf: 'flex-end' }}>{loading ? '…' : 'Send'}</button>
      </form>
    </div>
  );
});
ChatPane.displayName = 'ChatPane';
