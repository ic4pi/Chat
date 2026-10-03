// Admin-only: manage standing tasks (the "operate without me" objectives)
// and manually trigger one immediately, independent of the cron schedule.
//
//   GET    /api/admin-standing-tasks                 → list all tasks
//   PUT    /api/admin-standing-tasks                  → replace the full list
//   POST   /api/admin-standing-tasks?action=run&id=x  → run one task right now
import { requireAdminAuth } from '../lib/auth.js';
import { listStandingTasks, saveStandingTasks } from '../lib/standing-tasks.js';
import { runStandingTask } from '../lib/run-standing-task.js';

export default async function handler(req, res) {
  if (!requireAdminAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).json({ tasks: await listStandingTasks() });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    const tasks = await saveStandingTasks(body.tasks);
    return res.status(200).json({ ok: true, tasks });
  }

  if (req.method === 'POST' && req.query.action === 'run') {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const tasks = await listStandingTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) return res.status(404).json({ error: `No standing task with id ${id}` });
    try {
      const result = await runStandingTask(task, req);
      task.lastRunAt = new Date().toISOString();
      await saveStandingTasks(tasks);
      return res.status(200).json({ ok: true, result });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Task run failed' });
    }
  }

  res.setHeader('Allow', 'GET, PUT, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
