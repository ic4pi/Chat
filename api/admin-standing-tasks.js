// Admin-only: manage standing tasks (the "operate without me" objectives)
// and manually trigger one immediately, independent of the cron schedule.
//
//   GET    /api/admin-standing-tasks                 → list all tasks
//   PUT    /api/admin-standing-tasks                  → replace the full list
//   POST   /api/admin-standing-tasks?action=run&id=x  → run one task right now
import { requireAdminAuth } from '../lib/auth.js';
import { listStandingTasks, saveStandingTasks } from '../lib/standing-tasks.js';
import { agency, limits } from '../lib/agency-control.js';
import { runStandingTask } from '../lib/run-standing-task.js';
import { getBusiness, saveProfile, runTeamDiscussion } from '../lib/business-profile.js';

export default async function handler(req, res) {
  if (!requireAdminAuth(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');

  // Business profile + the team's strategy notes:
  //   GET  ?what=profile                  -> { profile, notes, notesAt }
  //   PUT  ?what=profile  { profile }     -> save the profile
  //   POST ?what=profile&action=discuss   -> the team discusses it now and saves strategy notes
  if (req.query.what === 'profile') {
    try {
      if (req.method === 'GET') return res.status(200).json(await getBusiness());
      if (req.method === 'PUT') return res.status(200).json(await saveProfile((req.body || {}).profile));
      if (req.method === 'POST' && req.query.action === 'discuss') return res.status(200).json(await runTeamDiscussion(req));
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Business profile request failed' });
    }
    res.setHeader('Allow', 'GET, PUT, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Kill switch + today's usage:
  //   GET  ?what=control                          -> { paused, reason, usage, limits }
  //   PUT  ?what=control  { paused, reason? }     -> pause/resume everything the agency does on its own
  if (req.query.what === 'control') {
    try {
      if (req.method === 'PUT') {
        const b = req.body || {};
        await agency.setPaused(b.paused === true, b.reason);
      } else if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET, PUT');
        return res.status(405).json({ error: 'Method not allowed' });
      }
      return res.status(200).json({ ...(await agency.getControl()), usage: await agency.usage(), limits: limits() });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Control request failed' });
    }
  }

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
      await agency.recordTaskSuccess(task.id);   // a good manual run also lifts a pause
      return res.status(200).json({ ok: true, result });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Task run failed' });
    }
  }

  if (req.method === 'POST' && req.query.action === 'resume') {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    return res.status(200).json({ ok: true, state: await agency.resumeTask(id) });
  }

  res.setHeader('Allow', 'GET, PUT, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
