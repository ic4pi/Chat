/**
 * Standing tasks: objectives the agency works on without a live user
 * present — "run this every day", "check on X weekly". Stored in the same
 * Vercel KV blob pattern as admin-config.js (small, infrequent writes, no
 * need for a Postgres table). The cron runner (api/cron/run-standing-tasks.js)
 * and the manual trigger (api/admin-standing-tasks.js, action=run) both read
 * from here.
 */

import { kvGet, kvSet, KV_ENABLED } from './kv.js';

const TASKS_KEY = 'uncensored-chat:standing-tasks:v1';

function normalizeTask(t) {
  return {
    id: String(t.id || '').trim(),
    name: String(t.name || 'Untitled task').slice(0, 120),
    objective: String(t.objective || ''),
    leadPersonaId: String(t.leadPersonaId || '').trim(),
    personaIds: Array.isArray(t.personaIds) ? t.personaIds.filter((x) => typeof x === 'string') : [],
    schedule: t.schedule === 'hourly' || t.schedule === 'weekly' ? t.schedule : 'daily',
    enabled: t.enabled !== false,
    lastRunAt: typeof t.lastRunAt === 'string' ? t.lastRunAt : null,
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
  };
}

export async function listStandingTasks() {
  if (!KV_ENABLED) return [];
  try {
    const raw = await kvGet(TASKS_KEY);
    const stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(stored?.tasks) ? stored.tasks.map(normalizeTask) : [];
  } catch {
    return [];
  }
}

export async function saveStandingTasks(tasks) {
  if (!KV_ENABLED) throw new Error('KV is not configured');
  const list = Array.isArray(tasks) ? tasks.map(normalizeTask).filter((t) => t.id) : [];
  await kvSet(TASKS_KEY, { tasks: list });
  return list;
}

const SCHEDULE_MS = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** Due = enabled, and never run or last run longer ago than its schedule interval. */
export function isTaskDue(task, now = Date.now()) {
  if (!task.enabled) return false;
  if (!task.lastRunAt) return true;
  const last = Date.parse(task.lastRunAt);
  if (Number.isNaN(last)) return true;
  return now - last >= (SCHEDULE_MS[task.schedule] || SCHEDULE_MS.daily);
}
