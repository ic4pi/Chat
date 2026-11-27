// Called by Vercel Cron (see vercel.json). Runs every standing task that's
// due, saves each result as a document, and moves on — this is what lets
// the agency keep working with nobody watching.
import { checkAdminAuthThrottled } from '../../lib/auth.js';
import { isVercelCron } from '../../lib/cron-auth.js';
import { listStandingTasks, scheduleMs } from '../../lib/standing-tasks.js';
import { agency, isDueWithState, limits } from '../../lib/agency-control.js';
import { logTeamAction } from '../../lib/team-log.js';
import { db, HUB_ENABLED } from '../../lib/hub.js';
import { runStandingTask } from '../../lib/run-standing-task.js';
import { runAutopost } from '../../lib/autopost.js';
import { discussIfStale } from '../../lib/business-profile.js';
import { draftNewLeads } from '../../lib/lead-ops.js';

function siteBase(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  return host ? `${String(host).startsWith('localhost') ? 'http' : 'https'}://${host}` : '';
}

export default async function handler(req, res) {
  // Vercel sends `Authorization: Bearer CRON_SECRET` on real cron invocations (lib/cron-auth.js); an admin-authed
  // call is allowed too (for testing this without waiting on the schedule). Anything else is rejected — this
  // can't become an unauthenticated way for a stranger to burn API credits on demand. (This used to look for an
  // `x-vercel-cron` header, which Vercel does not document and anyone could forge.)
  const fromCron = isVercelCron(req);
  const isAdmin = fromCron ? false : (await checkAdminAuthThrottled(req)).ok;
  if (!fromCron && !isAdmin) {
    return res.status(403).json({ error: 'This endpoint only runs via Vercel Cron or admin auth.' });
  }

  // Admin test: /api/cron/run-standing-tasks?autopost=<accountId> posts that account once, now.
  if (isAdmin && typeof req.query?.autopost === 'string' && req.query.autopost) {
    try {
      return res.status(200).json({ autopost: await runAutopost({ only: req.query.autopost, baseUrl: siteBase(req) }) });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Autopost failed' });
    }
  }

  // Kill switch: nothing the agency does on its own runs while it is paused.
  const control = await agency.getControl().catch(() => ({ paused: false }));
  if (control.paused) {
    return res.status(200).json({ paused: true, reason: control.reason || '', checked: 0, ran: 0, results: [], autopost: [] });
  }

  const started = Date.now();
  const caps = limits();

  // Autopost first: it is cheap and time-boxed by its schedule, so a slow task can never starve it.
  let autopost = [];
  try { autopost = await runAutopost({ baseUrl: siteBase(req) }); } catch (err) { autopost = [{ ok: false, error: err.message || String(err) }]; }

  // New website leads get a reply drafted for the owner to approve (nothing is sent from here).
  let leadDrafts = [];
  try { leadDrafts = await draftNewLeads(); } catch (err) { leadDrafts = [{ ok: false, error: err.message || String(err) }]; }

  const tasks = await listStandingTasks();
  const due = tasks.filter((t) => isDueWithState(t, t, scheduleMs(t)));
  const results = [];

  for (const task of due) {
    // Leave room in this invocation: don't start another task near the function limit.
    if (Date.now() - started > TASKS_DEADLINE_MS) { results.push({ id: task.id, name: task.name, ok: false, skipped: true, error: 'Skipped: out of time in this run; it goes next hour.' }); continue; }
    if (!(await agency.consume('taskRuns', caps.taskRunsPerDay))) {
      results.push({ id: task.id, name: task.name, ok: false, skipped: true, error: `Skipped: daily limit of ${caps.taskRunsPerDay} task runs reached.` });
      continue;
    }
    try {
      const result = await runStandingTask(task, req);
      await agency.recordTaskSuccess(task.id);
      results.push({ id: task.id, name: task.name, ok: true, ...result });
    } catch (err) {
      const st = await agency.recordTaskFailure(task.id, err).catch(() => ({}));
      results.push({ id: task.id, name: task.name, ok: false, error: err.message || String(err), failCount: st.failCount, paused: !!st.pausedReason });
      if (st.justPaused) await tellOwner(`Standing task "${task.name}" paused itself`, st.pausedReason);
    }
  }

  let discussion = null;
  try { discussion = await discussIfStale(req); } catch (err) { discussion = { error: err.message || String(err) }; }

  // Cron output is otherwise invisible: one line per run (and per failure) so the runtime logs show what happened.
  console.log('[agency-cron]', JSON.stringify({ autopost: autopost.map((a) => ({ id: a.id, ok: a.ok, error: a.error })), leadDrafts: leadDrafts.length, tasksRan: due.length }));
  for (const a of autopost) if (a.ok === false) console.error('[agency-cron] autopost failed:', a.label || a.id, a.error);
  return res.status(200).json({ checked: tasks.length, ran: due.length, results, discussion, autopost, leadDrafts });
}

const TASKS_DEADLINE_MS = 600_000;

/** Put an agency problem where the team and the owner will see it (the team log). */
async function tellOwner(verb, summary) {
  try {
    if (!HUB_ENABLED) return;
    const { data } = await db.from('owners').select('id').order('created_at', { ascending: true }).limit(1).single();
    if (data?.id) await logTeamAction(data.id, { personaName: 'Agency', verb, summary: String(summary).slice(0, 200) });
  } catch { /* alerting must never break the run */ }
}
