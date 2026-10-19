// Called by Vercel Cron (see vercel.json). Runs every standing task that's
// due, saves each result as a document, and moves on — this is what lets
// the agency keep working with nobody watching.
import { checkAdminAuth } from '../../lib/auth.js';
import { listStandingTasks, saveStandingTasks, isTaskDue } from '../../lib/standing-tasks.js';
import { runStandingTask } from '../../lib/run-standing-task.js';
import { processSchedule } from '../../lib/tools/index.js';
import { processDueOutreach } from '../../lib/tools/ops.js';

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

  // Same hourly tick also drains /schedule jobs and auto-send outreach follow-ups.
  const scheduled = await processSchedule(req).catch((e) => [{ ok: false, error: e.message }]);
  const outreach = await processDueOutreach().catch((e) => [{ ok: false, error: e.message }]);

  return res.status(200).json({ checked: tasks.length, ran: due.length, results, scheduled, outreach });
}
