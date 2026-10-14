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
import { planForPersona } from './buildPlan.js';

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
  askName?: string;
  runStatus?: string;
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

// ── team line (ASK) ──────────────────────────────────────────────────────

export const MAX_ASKS = 6;
export interface Ask { id: string; question: string }

const ASK_RE = /<<<\s*ASK[ \t]+([\w-]+)[^\n]*\n([\s\S]*?)(?:\n?\s*ASK\s*>>>|$)/gi;

/** Questions the orchestrator wants put to other personas, and its reply without them. */
export function extractAskBlocks(raw: string): { text: string; asks: Ask[] } {
  const asks: Ask[] = [];
  const text = String(raw || '').replace(ASK_RE, (_all, id: string, q: string) => {
    const question = (q || '').trim();
    if (question && asks.length < MAX_ASKS) asks.push({ id: id.toLowerCase(), question });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text, asks };
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
      if (m.kind === 'runplan') {
        if (m.runStatus === 'declined') {
          turns.push({ role: 'user', content: '[NOTE] The user chose not to run your questions to the team. Carry on without them.' });
        }
        continue;
      }
      if (m.kind === 'askreply') {
        turns.push({ role: 'user', content: `[REPLY from ${m.askName || 'persona'}] ${clip(m.content, 2500)}` });
        continue;
      }
      if (m.kind === 'note') {
        turns.push({ role: 'user', content: `[NOTE] ${m.content}` });
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
      if (m.role === 'user') {
        if (m.kind === 'brief') return !m.pending; // never built — not the coder's business
        if (m.kind === 'runplan' || m.kind === 'askreply') return false;
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

/**
 * Files the persona asked to read itself, from a `READ: a.js, src/b.ts` line.
 * Lets it pull any file on its own instead of telling the user to paste one.
 */
export function parseReadRequests(reply: string): string[] {
  const out: string[] = [];
  const re = /^[\s>*\-]*READ(?:\s+FILES?)?\s*:\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(reply || '')))) {
    for (let p of m[1].split(/[,;]+/)) {
      p = p.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/^\.\//, '').trim();
      if (p && /[./]/.test(p) && !p.includes('..') && p.length < 200) out.push(p);
    }
  }
  return [...new Set(out)].slice(0, 8);
}

/** Hide the READ: lines from what the user sees — they're a machine request. */
export function stripReadRequests(text: string): string {
  return String(text || '')
    .replace(/^[\s>*\-]*READ(?:\s+FILES?)?\s*:.*(?:\r?\n)?/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildPersonaContext(opts: {
  repoRoot: string;
  repoUrl: string | null;
  tree: FileNode[];
  openFiles: string[];
  /** Full contents of the files currently in context — the persona reads these in full. */
  files?: Map<string, string>;
  hits: SearchHit[];
  coderLabel: string;
  role?: string;
  /** Build plan markdown (may be empty). */
  plan?: string;
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
    const shown = paths.slice(0, 120);
    parts.push('', 'File tree:', shown.join('\n'));
    if (paths.length > shown.length) parts.push(`… (${paths.length - shown.length} more)`);
  } else if (!opts.repoRoot) {
    parts.push('No repo is open. If the user wants something built, the coder can start it as a blank project.');
  }
  if (opts.openFiles.length) {
    parts.push('', `Files the coder will have open in full: ${opts.openFiles.join(', ')}`);
  }
  parts.push('', planForPersona(opts.plan || ''));
  // Full contents of what's in context, so the persona reads files itself.
  if (opts.files && opts.files.size) {
    let budget = 16_000;
    const blocks: string[] = [];
    for (const [path, content] of opts.files) {
      if (budget <= 0) break;
      const slice = content.length > 8_000 ? content.slice(0, 8_000) + '\n… (truncated)' : content;
      budget -= slice.length;
      blocks.push(`--- ${path} ---\n${slice}`);
    }
    if (blocks.length) parts.push('', 'File contents (read these directly — do not ask the user for them):', ...blocks);
  }
  const hitBlock = formatSearchHits(opts.hits, 6_000);
  if (hitBlock) parts.push('', hitBlock);
  parts.push(
    '',
    'READING FILES: you can open any file in the project yourself. Put a line exactly like',
    '`READ: path/one.js, path/two.css` (paths from the file tree above) anywhere in your reply and the app',
    'fetches those files and lets you continue with their contents. NEVER tell the user to click, open, copy,',
    'paste, cat, or relay a file — read it yourself with READ:.',
  );
  return parts.join('\n');
}
