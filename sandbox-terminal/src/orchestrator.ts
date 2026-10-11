/**
 * Persona-as-orchestrator for the Workspace.
 *
 * The user talks to their chat persona, never to the coder directly. The
 * persona sees the whole conversation (including the main-chat history the
 * handoff brought in), the live workspace state, and a compact report of
 * everything the coder did — then writes a <<<BRIEF … BRIEF>>> block that
 * becomes the coder's entire instruction. The coder never sees the raw chat.
 *
 * Pure helpers only; ChatPane owns the network calls.
 */

import type { FileNode } from './types.js';
import { formatSearchHits, type SearchHit } from './contextBudget.js';
import { looksLikeApplyRequest, looksLikeLegacyWelcome } from './agentParse.js';
import { noteSettingsChanged } from './settingsSync.js';

export interface OrchestratorPersona {
  id: string;
  name: string;
  /** Model the persona thinks on — the main-chat model when handed off. */
  provider: string;
  model: string;
}

/** Minimal message shape — mirrors ChatPane's Message without importing it. */
export interface OrchMessage {
  role: 'user' | 'assistant';
  content: string;
  kind?: string;
  speaker?: 'persona' | 'coder';
  to?: 'persona';
  pending?: boolean;
}

type Turn = { role: 'user' | 'assistant'; content: string };

// ── prefs ────────────────────────────────────────────────────────────────

const PREFS_KEY = 'workspace_orchestrator_v1';

export interface OrchestratorPrefs {
  /** '' = off: messages go straight to the coder, as before. */
  personaId: string;
  /** Persona's own model; empty = use the coder's pick. */
  provider: string;
  model: string;
}

export function loadOrchestratorPrefs(): OrchestratorPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrchestratorPrefs>;
      return {
        personaId: typeof p.personaId === 'string' ? p.personaId : 'nexus',
        provider: typeof p.provider === 'string' ? p.provider : '',
        model: typeof p.model === 'string' ? p.model : '',
      };
    }
  } catch { /* ignore */ }
  // On by default — talking to the persona is the point.
  return { personaId: 'nexus', provider: '', model: '' };
}

export function saveOrchestratorPrefs(p: OrchestratorPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  noteSettingsChanged();
}

// ── brief parsing ────────────────────────────────────────────────────────

/** Closed block, or an unterminated one running to the end (cut-off reply). */
const BRIEF_RE = /<<<\s*BRIEF\b[^\n]*\n?([\s\S]*?)(?:\n?\s*BRIEF\s*>>>|$)/i;
/** ```brief … ``` — models that fence everything. */
const FENCED_BRIEF_RE = /```\s*brief[^\n]*\n([\s\S]*?)(?:```|$)/i;
/** A "Brief for the coder:" style heading followed by the spec. */
const HEADED_BRIEF_RE = /^[ \t]*(?:#{1,4}[ \t]*|\*\*)?[ \t]*(?:coder'?s?[ \t]+)?brief(?:[ \t]+(?:for|to)[ \t]+(?:the[ \t]+)?coder)?[ \t]*:?[ \t]*(?:\*\*)?[ \t]*$/im;
/** No markers at all, but a spec that starts "Goal:" and has requirements. */
const BARE_SPEC_RE = /^[ \t]*(?:\*\*)?Goal(?:\*\*)?[ \t]*:/im;

/**
 * The persona's words and its brief for the coder. Models follow the
 * <<<BRIEF … BRIEF>>> format unevenly, so the fenced, headed and bare-spec
 * shapes count too — a brief the persona clearly wrote is never dropped
 * because of how it was wrapped.
 */
export function splitPersonaReply(raw: string): { say: string; brief: string | null } {
  const text = String(raw || '');
  for (const re of [BRIEF_RE, FENCED_BRIEF_RE]) {
    const m = re.exec(text);
    if (m) {
      const brief = (m[1] || '').trim();
      const say = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
      if (brief) return { say, brief };
    }
  }
  const headed = HEADED_BRIEF_RE.exec(text);
  if (headed) {
    const brief = text.slice(headed.index + headed[0].length).trim();
    if (/\bGoal\b/i.test(brief)) return { say: text.slice(0, headed.index).trim(), brief };
  }
  const bare = BARE_SPEC_RE.exec(text);
  if (bare) {
    const brief = text.slice(bare.index).trim();
    if (/\b(?:Requirements|Files|Done when)\b/i.test(brief)) return { say: text.slice(0, bare.index).trim(), brief };
  }
  return { say: text.trim(), brief: null };
}

/**
 * The persona answered without a usable brief, but the turn was clearly
 * meant to get something built: either you asked for work, or the persona
 * talked about the coder or handed you a prompt to pass along. Worth a
 * second, structured attempt rather than leaving you to relay it.
 */
/**
 * "What did the coder build? List the files." — asking about work, not for
 * it. A question first, and no "fix it / build it / go ahead" after it.
 */
export function asksAboutWork(userText: string): boolean {
  const t = userText.trim().toLowerCase();
  const asks = /^(?:what|which|why|how|did|does|do|is|are|was|were|where|when|who|has|have)\b[^?]*\?/.test(t);
  const orders = /\b(?:fix (?:it|this|that|them)|build (?:it|this|that|me|a|an)|go ahead|do it|make (?:it|this|that|a|an)|change (?:it|this|that)|add (?:a|an|the|some)|implement|redo|rewrite|apply)\b/.test(t);
  return asks && !orders;
}

/** The persona saying it's handing work over — not merely mentioning the coder. */
const HANDOFF_RE = new RegExp([
  String.raw`\b(?:I(?:'ll| will|'m going to| am going to)|let me|going to|about to)\s+(?:\w+\s+){0,4}?(?:send|hand|pass|brief|get|have|ask|tell|build)\b`,
  String.raw`\b(?:copy|paste)\s+(?:this|it|the (?:prompt|brief|following))\b`,
  String.raw`\bhere(?:'s| is) (?:the|a|your) (?:prompt|brief)\b`,
  String.raw`\b(?:prompt|brief) (?:for|to) (?:the )?(?:coder|coding agent|developer)\b`,
  String.raw`\b(?:sending|handing|passing) (?:this|it|that)\b`,
  String.raw`\bbuilding (?:it|this|that) now\b`,
].join('|'), 'i');

export function personaMeantToBrief(userText: string, personaSay: string): boolean {
  if (asksAboutWork(userText)) return false;
  if (looksLikeApplyRequest(userText)) return true;
  return HANDOFF_RE.test(personaSay);
}

export const NO_BRIEF = 'NO_BRIEF';

/** Written by the coder model when the persona's own model fumbled the format. */
export const BRIEF_WRITER_SYSTEM = [
  'You write the brief a coding agent works from. The coder cannot see the conversation: the brief is its whole spec.',
  'Read the conversation and the lead\'s latest reply. If the latest request does not need any code written,',
  `changed or debugged, reply with exactly ${NO_BRIEF} and nothing else.`,
  'Otherwise reply with ONLY the brief, in this shape:',
  'Goal: what the finished result must do, in concrete observable terms.',
  'Context: every fact from the conversation the coder needs — decisions, preferences, constraints, earlier failures.',
  'Files: real paths from the file tree to change, and new paths to create.',
  'Requirements: a numbered list, specific and testable.',
  'Do not: what must stay untouched, approaches to avoid.',
  'Done when: how the result is checked.',
].join('\n');

/** Turns for the brief writer: the persona's view of the conversation plus its latest reply. */
export function buildBriefWriterTurns(personaTurns: Turn[], personaReply: string): Turn[] {
  const transcript = personaTurns
    .map((t) => `${t.role === 'user' ? 'USER' : 'LEAD'}: ${t.content}`)
    .join('\n\n');
  return [{
    role: 'user',
    content: `${transcript}\n\nLEAD (latest reply): ${personaReply || '(no reply)'}\n\nWrite the brief now, or ${NO_BRIEF}.`,
  }];
}

// ── workspace tools: the persona reads, searches and runs things itself ──

/**
 * The persona asks for these in its reply — <<<READ path>>>, <<<SEARCH q>>>,
 * <<<RUN cmd>>> — the app does them and hands the results back, so it never
 * has to ask you to paste a file, an error or terminal output.
 */
export type WorkspaceOp = 'READ' | 'SEARCH' | 'RUN';
export interface WorkspaceRequest { op: WorkspaceOp; arg: string }

export interface WorkspaceTools {
  read: (path: string) => Promise<string | null>;
  search: (query: string) => Promise<SearchHit[]>;
  /** Null when there's no sandbox to run in. */
  run: ((command: string) => Promise<{ exitCode: number; output: string }>) | null;
}

/** Rounds of reading per turn before the persona must answer with what it has. */
export const MAX_WORKSPACE_ROUNDS = 5;
const MAX_REQUESTS_PER_ROUND = 6;
const READ_CHARS = 24_000;
const RUN_CHARS = 8_000;

const REQUEST_RE = /<<<\s*(READ|SEARCH|RUN)\b[ \t:]*([^\n]*?)[ \t]*>>>/gi;

export function parseWorkspaceRequests(raw: string): WorkspaceRequest[] {
  const out: WorkspaceRequest[] = [];
  const seen = new Set<string>();
  for (const m of String(raw || '').matchAll(REQUEST_RE)) {
    const op = m[1].toUpperCase() as WorkspaceOp;
    const arg = (m[2] || '').trim().replace(/^[`'"]+|[`'"]+$/g, '').trim();
    const k = `${op} ${arg}`;
    if (!arg || seen.has(k)) continue;
    seen.add(k);
    out.push({ op, arg });
  }
  return out;
}

export function stripWorkspaceRequests(raw: string): string {
  return String(raw || '').replace(REQUEST_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** "Can you paste the file?", "I can't see your files" — it has access; it should use it. */
const ASKS_TO_PASTE_RE = new RegExp([
  String.raw`\b(?:paste|copy|share|send|upload|drop|show)\b[^.?!\n]{0,60}\b(?:file|code|contents?|output|error|log|logs|terminal|traceback|stack ?trace)\b`,
  String.raw`\b(?:run|type|enter)\b[^.?!\n]{0,40}\bin (?:the|your) terminal\b`,
  String.raw`\bI (?:can(?:'|no)t|cannot|don'?t have (?:access|the ability) to|am unable to)\s+(?:see|read|open|access|view|run)\b`,
].join('|'), 'i');

export function asksUserToPaste(say: string): boolean {
  return ASKS_TO_PASTE_RE.test(say);
}

export const USE_YOUR_ACCESS = '[WORKSPACE] You have direct access to this workspace — do not ask the user to '
  + 'paste, copy, upload or run anything. Get it yourself now with <<<READ path>>>, <<<SEARCH words>>> or '
  + '<<<RUN command>>>, then answer.';

/** Blocks the few things that would skip the push lock or wipe your work. */
const BLOCKED_RUN_RE = /\bgit\s+push\b|\brm\s+-[a-z]*[rf][a-z]*\s+(?:\/|~|\.{1,2}(?:\/)?(?:\s|$)|\*)/i;

async function doRequest(req: WorkspaceRequest, tools: WorkspaceTools): Promise<{ result: string; log: string }> {
  if (req.op === 'READ') {
    const content = await tools.read(req.arg).catch(() => null);
    if (content == null) return { result: `READ ${req.arg}: not found or not readable.`, log: `couldn't read ${req.arg}` };
    return { result: `READ ${req.arg}:\n\`\`\`\n${clip(content, READ_CHARS)}\n\`\`\``, log: `read ${req.arg}` };
  }
  if (req.op === 'SEARCH') {
    const hits = await tools.search(req.arg).catch(() => [] as SearchHit[]);
    const block = formatSearchHits(hits, 6_000);
    return {
      result: `SEARCH "${req.arg}":\n${block || 'no matches'}`,
      log: `searched "${clip(req.arg, 40)}" (${hits.length} hit${hits.length === 1 ? '' : 's'})`,
    };
  }
  if (!tools.run) return { result: `RUN ${req.arg}: no sandbox is running yet.`, log: `couldn't run \`${clip(req.arg, 60)}\`` };
  if (BLOCKED_RUN_RE.test(req.arg)) {
    return {
      result: `RUN ${req.arg}: blocked — pushing goes through the app's tested Push, and wiping the repo is off limits.`,
      log: `blocked \`${clip(req.arg, 60)}\``,
    };
  }
  const { exitCode, output } = await tools.run(req.arg)
    .catch((e) => ({ exitCode: -1, output: e instanceof Error ? e.message : String(e) }));
  const tail = output.length > RUN_CHARS ? `…${output.slice(-RUN_CHARS)}` : output;
  return {
    result: `RUN ${req.arg} → exit ${exitCode}:\n\`\`\`\n${tail.trim() || '(no output)'}\n\`\`\``,
    log: `ran \`${clip(req.arg, 60)}\` → exit ${exitCode}`,
  };
}

/** Does one round of requests; results go back to the persona, the log goes on screen. */
export async function runWorkspaceRequests(
  reqs: WorkspaceRequest[],
  tools: WorkspaceTools,
  onStep?: (req: WorkspaceRequest) => void,
): Promise<{ results: string; log: string[] }> {
  const results: string[] = [];
  const log: string[] = [];
  const todo = reqs.slice(0, MAX_REQUESTS_PER_ROUND);
  for (const r of todo) {
    onStep?.(r);
    const done = await doRequest(r, tools);
    results.push(done.result);
    log.push(done.log);
  }
  if (reqs.length > todo.length) results.push(`(${reqs.length - todo.length} more requests skipped — ask again next round.)`);
  return { results: `[WORKSPACE RESULTS]\n\n${results.join('\n\n')}`, log };
}

// ── history builders ─────────────────────────────────────────────────────

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

const FILE_HEADER_RE = /^[*_]*(?:File|Edit):\s*(.+?)[*_]*\s*$/gm;

/** What the coder did, minus the code itself — enough for the persona to judge it. */
export function coderResultNote(content: string): string {
  const paths = new Set<string>();
  for (const m of content.matchAll(FILE_HEADER_RE)) {
    const p = (m[1] || '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
    if (p) paths.add(p);
  }
  const prose = content
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/<<<<<<< SEARCH[\s\S]*?(?:>>>>>>> REPLACE|$)/g, '')
    .replace(FILE_HEADER_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const files = paths.size ? `Files in reply: ${[...paths].join(', ')}.` : 'No file blocks in reply.';
  return `[CODER RESULT] ${files}${prose ? `\n${clip(prose, 1200)}` : ''}`;
}

/** Strict chat templates reject two user turns in a row — fold them together. */
function mergeSameRole(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content = `${last.content}\n\n${t.content}`;
    else out.push({ ...t });
  }
  // Most providers want the first non-system turn to be the user's.
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

function skip(m: OrchMessage): boolean {
  return m.kind === 'welcome' || looksLikeLegacyWelcome(m.content);
}

/** The persona's view: the real conversation plus every coder/test outcome as a report. */
export function buildPersonaHistory(msgs: OrchMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of msgs) {
    if (skip(m)) continue;
    if (m.role === 'user') {
      if (m.kind === 'brief') continue; // already inside the persona's own reply
      if (m.kind === 'note') {
        turns.push({ role: 'user', content: `[NOTE] ${m.content}` });
        continue;
      }
      if (m.kind === 'workspace') {
        turns.push({ role: 'user', content: `[WORKSPACE] ${m.content}` });
        continue;
      }
      if (m.kind === 'retry-inject') {
        turns.push({ role: 'user', content: `[AUTO-TEST → coder] ${clip(m.content, 800)}` });
        continue;
      }
      turns.push({ role: 'user', content: m.content });
    } else if (m.speaker === 'persona' || m.kind === 'imported') {
      turns.push({ role: 'assistant', content: m.content });
    } else {
      turns.push({ role: 'user', content: coderResultNote(m.content) });
    }
  }
  return mergeSameRole(turns);
}

/** The coder's view: briefs, test failures, its own replies — never the raw chat. */
export function buildCoderHistory(msgs: OrchMessage[]): Turn[] {
  return msgs
    .filter((m) => {
      if (skip(m)) return false;
      if (m.kind === 'workspace') return false; // the persona's own reading, not the coder's
      if (m.role === 'user') {
        if (m.kind === 'brief') return !m.pending; // never built — not the coder's business
        if (m.kind === 'retry-inject' || m.kind === 'note') return true;
        // Direct-mode asks from earlier in this session still belong to the coder.
        return m.kind !== 'imported' && m.to !== 'persona';
      }
      return m.speaker !== 'persona' && m.kind !== 'imported';
    })
    .map((m) => ({ role: m.role, content: m.content }));
}

// ── workspace state for the persona ──────────────────────────────────────

function flatten(nodes: FileNode[], prefix = ''): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    if (n.type === 'file') out.push(p);
    else if (n.children) out.push(...flatten(n.children, p));
  }
  return out;
}

const OPEN_FILES_CHARS = 30_000;

export function buildPersonaContext(opts: {
  repoRoot: string;
  repoUrl: string | null;
  tree: FileNode[];
  openFiles: string[];
  /** Contents of the files already open this turn, so the persona reads them without asking. */
  files?: Map<string, string>;
  hits: SearchHit[];
  coderLabel: string;
  role?: string;
}): string {
  const parts: string[] = ['WORKSPACE STATE (live, right now):'];
  parts.push(`Repo: ${opts.repoUrl || (opts.repoRoot ? 'blank project' : 'nothing opened yet')}`);
  parts.push(`Coder model: ${opts.coderLabel}`);
  if (opts.role === 'plan') {
    parts.push('Mode: PLAN — the coder will only plan, not write files, until the user switches to Write.');
  } else if (opts.role === 'review') {
    parts.push('Mode: REVIEW — the coder will only review and suggest, not write files.');
  }
  const paths = flatten(opts.tree).filter((p) =>
    !p.includes('node_modules') && !p.includes('/dist/') && !p.startsWith('dist/')
    && !p.includes('public/agent/assets'),
  );
  if (paths.length) {
    const shown = paths.slice(0, 300);
    parts.push('', 'File tree:', shown.join('\n'));
    if (paths.length > shown.length) parts.push(`… (${paths.length - shown.length} more)`);
  } else if (!opts.repoRoot) {
    parts.push('No repo is open. If the user wants something built, the coder can start it as a blank project.');
  }
  if (opts.openFiles.length) {
    parts.push('', `Files the coder will have open in full: ${opts.openFiles.join(', ')}`);
  }
  if (opts.files?.size) {
    let budget = OPEN_FILES_CHARS;
    const shownFiles: string[] = [];
    for (const [p, c] of opts.files) {
      if (budget <= 0) break;
      const body = clip(c, Math.min(budget, 12_000));
      budget -= body.length;
      shownFiles.push(`--- ${p} ---\n${body}`);
    }
    if (shownFiles.length) parts.push('', 'Open files (already read for you — <<<READ>>> anything else):', shownFiles.join('\n\n'));
  }
  const hitBlock = formatSearchHits(opts.hits, 6_000);
  if (hitBlock) parts.push('', hitBlock);
  return parts.join('\n');
}
