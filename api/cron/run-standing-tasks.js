// Called by Vercel Cron (see vercel.json). Runs every standing task that's
// due, saves each result as a document, and moves on — this is what lets
// the agency keep working with nobody watching.
import { checkAdminAuth } from '../../lib/auth.js';
import { listStandingTasks, saveStandingTasks, isTaskDue } from '../../lib/standing-tasks.js';
import { runStandingTask } from '../../lib/run-standing-task.js';
import { runAutopost } from '../../lib/autopost.js';

function siteBase(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
  return host ? `${String(host).startsWith('localhost') ? 'http' : 'https'}://${host}` : '';
}

export default async function handler(req, res) {
  // Vercel signs real cron invocations with this header; an admin-authed
  // call is allowed too (for testing this without waiting on the schedule).
  // Anything else is rejected — this can't become an unauthenticated way
  // for a stranger to burn API credits on demand.
  const isVercelCron = req.headers['x-vercel-cron'] !== undefined;
  const isAdmin = checkAdminAuth(req).ok;
  if (!isVercelCron && !isAdmin) {
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

  const tasks = await listStandingTasks();
  const due = tasks.filter((t) => isTaskDue(t));
  const results = [];

  for (const task of due) {
    try {
      const result = await runStandingTask(task, req);
      task.lastRunAt = new Date().toISOString();
      results.push({ id: task.id, name: task.name, ok: true, ...result });
    } catch (err) {
      results.push({ id: task.id, name: task.name, ok: false, error: err.message || String(err) });
    }
  }

  if (due.length) await saveStandingTasks(tasks);

  let autopost = [];
  try { autopost = await runAutopost({ baseUrl: siteBase(req) }); } catch (err) { autopost = [{ ok: false, error: err.message || String(err) }]; }

  return res.status(200).json({ checked: tasks.length, ran: due.length, results, autopost });
}
