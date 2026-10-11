/**
 * Build plan — the checklist for a Workspace build, from first step to last.
 *
 * Plain markdown is the single source of truth, so the orchestrator can read
 * and rewrite it and you can read and tick it:
 *
 *   ## Milestone name
 *   - [x] done thing
 *   - [ ] thing still to do
 *
 * The orchestrator maintains it by ending a reply with a <<<PLAN … PLAN>>>
 * block holding the whole updated plan. Stored per workspace session.
 */

const KEY = 'workspace_build_plan_v1';

function load(): Record<string, string> {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}

export function loadPlan(sessionId: string): string {
  return load()[sessionId] || '';
}

export function savePlan(sessionId: string, md: string): void {
  try {
    const all = load();
    if (md.trim()) all[sessionId] = md; else delete all[sessionId];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* blocked storage */ }
}

export interface PlanItem { line: number; text: string; done: boolean }
export interface PlanGroup { name: string; items: PlanItem[] }
export interface ParsedPlan { groups: PlanGroup[]; done: number; total: number }

const ITEM_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const HEAD_RE = /^\s{0,3}#{1,4}\s+(.*?)\s*#*\s*$/;

export function parsePlan(md: string): ParsedPlan {
  const groups: PlanGroup[] = [];
  let cur: PlanGroup | null = null;
  let done = 0;
  let total = 0;
  md.split('\n').forEach((raw, line) => {
    const h = HEAD_RE.exec(raw);
    if (h) { cur = { name: h[1] || '', items: [] }; groups.push(cur); return; }
    const m = ITEM_RE.exec(raw);
    if (!m) return;
    if (!cur) { cur = { name: '', items: [] }; groups.push(cur); }
    const isDone = m[1] !== ' ';
    // Strip ~~strike~~ the model may have added; the UI strikes done items itself.
    const text = (m[2] || '').replace(/^~~(.*)~~$/, '$1').trim();
    cur.items.push({ line, text, done: isDone });
    total++;
    if (isDone) done++;
  });
  return { groups: groups.filter(g => g.items.length), done, total };
}

/** Flip one checkbox line, leaving the rest of the markdown untouched. */
export function togglePlanLine(md: string, line: number): string {
  const lines = md.split('\n');
  const l = lines[line];
  if (l === undefined || !ITEM_RE.test(l)) return md;
  lines[line] = /\[ \]/.test(l) ? l.replace('[ ]', '[x]') : l.replace(/\[[xX]\]/, '[ ]');
  return lines.join('\n');
}

const PLAN_RE = /<<<\s*PLAN\b[^\n]*\n?([\s\S]*?)(?:\n?\s*PLAN\s*>>>|$)/i;

/** The reply minus its plan block, and the new plan if there was one. */
export function extractPlanBlock(raw: string): { text: string; plan: string | null } {
  const m = PLAN_RE.exec(raw);
  if (!m) return { text: raw, plan: null };
  const plan = (m[1] || '').trim();
  const text = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim();
  return { text, plan: plan && parsePlan(plan).total ? plan : null };
}

/** What the orchestrator sees each turn. */
export function planForPersona(md: string): string {
  const p = parsePlan(md);
  if (!p.total) {
    return 'BUILD PLAN: none yet. For any build with more than a couple of steps, write one (see PLAN format).';
  }
  return `BUILD PLAN (${p.done}/${p.total} done — the user sees this in the Plan panel):\n${md.trim()}`;
}
