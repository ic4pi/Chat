/**
 * Runs one standing task through the existing /api/group-chat engine
 * (server calling its own public endpoint, same as a browser would) and
 * saves the result as a `documents` row so it's there to review later —
 * nobody is watching a cron job run live.
 *
 * Deliberately reuses /api/group-chat over HTTP instead of importing its
 * handler directly: that logic is tested and live already (Orchestrated
 * mode, forcedLeadId, handoffs) — calling it as a normal request means
 * zero risk of this new code accidentally changing how a real user's
 * group chat behaves.
 */

import { db, HUB_ENABLED } from './hub.js';
import { gatherJobContext, executeFollowThrough } from './job-tools.js';

function baseUrlFromReq(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = req?.headers?.host || process.env.VERCEL_URL;
  if (!host) throw new Error('Cannot determine site URL to call /api/group-chat (set SITE_URL env var).');
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${host}`;
}

/** Parse an SSE response body into the event list group-chat emits. */
function parseSSE(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* skip malformed */ }
  }
  return events;
}

export const TASK_TIMEOUT_MS = 240_000;

/**
 * The brief the team actually receives. On top of the raw objective it adds:
 *  - per-persona assignments, when the owner gave specific people specific parts;
 *  - the house rule on tools: do the real work, and when a step needs a tool the
 *    agency does not have, say MISSING TOOL instead of writing fiction about it.
 */
export function buildBrief(task) {
  const lines = [task.objective.trim()];
  const assignments = Object.entries(task.assignments || {});
  if (assignments.length) {
    lines.push('', 'Assignments from the owner — each person named owns their line:');
    for (const [pid, note] of assignments) lines.push(`- ${pid}: ${note}`);
  }
  lines.push(
    '',
    'House rules:',
    '- Do the work itself (plans, copy, audits, code, research) — not a description of work that could be done.',
    '- Live web research is available to you; use it for anything current.',
    '- Email and social posting exist, but only as drafts the owner approves. Never claim something was sent or posted.',
    '- If a step needs a tool you do not have, write "MISSING TOOL: <what is needed>" for that step, then keep going with the rest.'
  );
  return lines.join('\n');
}

export async function runStandingTask(task, req, { timeoutMs = TASK_TIMEOUT_MS } = {}) {
  if (!task.objective?.trim()) throw new Error('Task has no objective to work on.');

  // Pull live tool context (repo code, deploys, sales, rankings) before the
  // team starts — they answer from real data, and know which tools exist.
  const tools = await gatherJobContext(task).catch(() => ({ repo: null, roster: '', contextBlock: '', missing: [] }));
  const brief = [buildBrief(task), tools.roster, tools.contextBlock].filter(Boolean).join('\n\n');

  const base = baseUrlFromReq(req);
  const signal = AbortSignal.timeout(timeoutMs);
  const upstream = await fetch(`${base}/api/group-chat`, {
    signal,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Paid-Password': process.env.ADMIN_PASSWORD || process.env.PAID_MODELS_PASSWORD || '',
    },
    body: JSON.stringify({
      topic: task.name,
      mode: 'orchestrated',
      model: 'venice-uncensored',
      provider: 'venice',
      personaIds: task.personaIds?.length ? task.personaIds : undefined,
      forcedLeadId: task.leadPersonaId || undefined,
      messages: [{ role: 'user', content: brief }],
    }),
  });

  if (!upstream.ok) {
    throw new Error(`group-chat call failed: HTTP ${upstream.status}`);
  }
  let text;
  try { text = await upstream.text(); }
  catch (e) { throw new Error(signal.aborted ? `Task timed out after ${Math.round(timeoutMs / 1000)}s` : e.message); }
  const events = parseSSE(text);

  const turns = events.filter((e) => e.type === 'turn');
  const errorEvents = events.filter((e) => e.type === 'error');
  const doneEvent = events.find((e) => e.type === 'done');

  // group-chat narrates research in status events ("<name>: searching the web for …").
  const researchers = [
    ...new Set(
      events
        .filter((e) => e.type === 'status' && /searching the web|web search/i.test(String(e.message || '')))
        .map((e) => String(e.message).split(':')[0].trim())
        .filter(Boolean)
    ),
  ];
  const skippedResearch = events.some((e) => e.type === 'status' && /web search skipped/i.test(String(e.message || '')));
  const toolsUsed = [
    researchers.length ? `Live web research — used by ${researchers.join(', ')}` : 'Live web research — available, not needed this run',
    skippedResearch ? 'Note: web search failed once and was skipped' : null,
    'Email & social posting — draft-and-approve only (nothing is sent or posted by a job)',
  ].filter(Boolean);

  if (!turns.length) {
    const reason = errorEvents.map((e) => e.error).join('; ') || 'no personas replied';
    throw new Error(`Standing task produced nothing: ${reason}`);
  }

  // Follow-through: if the team proposed code changes (FILE: blocks) and a
  // repo was named, open the pull request for real. Owner merges = approval.
  const follow = await executeFollowThrough(
    { id: task.id, name: task.name, turnTexts: turns.map((t) => String(t.content || '')) },
    tools.repo
  );
  toolsUsed.push(...follow.notes);

  const sections = [
    ...turns.map((t) => ({ heading: t.personaName, body: t.content })),
    { heading: 'Tools used (and limits)', body: toolsUsed.join('\n') },
  ];
  const title = `${task.name} — ${new Date().toISOString().slice(0, 10)}`;

  let documentId = null;
  if (HUB_ENABLED) {
    try {
      // documents.owner_id is NOT NULL and there's no live request/cookie in
      // a cron context to resolve one from — fall back to the single owner
      // row this personal app actually has, oldest first.
      let ownerId = task.ownerId || null;
      if (!ownerId) {
        const { data: owner } = await db
          .from('owners')
          .select('id')
          .order('created_at', { ascending: true })
          .limit(1)
          .single();
        ownerId = owner?.id || null;
      }
      if (!ownerId) throw new Error('No owner row exists yet to attach this document to.');

      const { data, error } = await db
        .from('documents')
        .insert({
          owner_id: ownerId,
          type: 'business_doc',
          title,
          sections,
          status: 'done',
          built_from_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (!error) documentId = data?.id || null;
    } catch (err) {
      console.error('saving standing-task document failed:', err);
    }
  }

  return {
    title,
    turnTexts: turns.map((t) => String(t.content || '')),
    turns: turns.length,
    summary: doneEvent?.summary || '',
    documentId,
    toolsUsed,
    prUrl: follow.prUrl,
    errors: errorEvents.map((e) => e.error),
  };
}
