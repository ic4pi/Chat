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
import { looksLikeLegacyWelcome } from './agentParse.js';

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
}

// ── brief parsing ────────────────────────────────────────────────────────

/** Closed block, or an unterminated one running to the end (cut-off reply). */
const BRIEF_RE = /<<<\s*BRIEF\b[^\n]*\n?([\s\S]*?)(?:\n?\s*BRIEF\s*>>>|$)/i;

export function splitPersonaReply(raw: string): { say: string; brief: string | null } {
  const m = BRIEF_RE.exec(raw);
  if (!m) return { say: raw.trim(), brief: null };
  const brief = (m[1] || '').trim();
  const say = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim();
  return { say, brief: brief || null };
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
        if (m.kind === 'brief' || m.kind === 'retry-inject') return true;
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

export function buildPersonaContext(opts: {
  repoRoot: string;
  repoUrl: string | null;
  tree: FileNode[];
  openFiles: string[];
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
    const shown = paths.slice(0, 120);
    parts.push('', 'File tree:', shown.join('\n'));
    if (paths.length > shown.length) parts.push(`… (${paths.length - shown.length} more)`);
  } else if (!opts.repoRoot) {
    parts.push('No repo is open. If the user wants something built, the coder can start it as a blank project.');
  }
  if (opts.openFiles.length) {
    parts.push('', `Files the coder will have open in full: ${opts.openFiles.join(', ')}`);
  }
  const hitBlock = formatSearchHits(opts.hits, 6_000);
  if (hitBlock) parts.push('', hitBlock);
  return parts.join('\n');
}
