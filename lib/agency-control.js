/**
 * Agency controls: what keeps the unattended parts (standing tasks, autopost)
 * from running away.
 *
 *   • per-task run state (failures, backoff, auto-pause) in its own KV key, so the
 *     cron never rewrites the task list an admin may be editing at the same time;
 *   • one kill switch that stops everything the cron does on its own;
 *   • daily caps on task runs and post attempts.
 *
 * `createAgencyControl(store, clock)` is pure over a tiny store so it can be tested
 * without KV; the default export functions use the real KV.
 */

import { kvGet, kvSet, kvIncr, kvExpire, KV_ENABLED } from './kv.js';

export const MAX_FAILS = 5;                   // consecutive failures before a task pauses itself
const HOUR = 3_600_000;
export const backoffMs = (fails) => Math.min(24 * HOUR, HOUR * 2 ** Math.max(0, fails - 1));

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };
export const limits = () => ({
  taskRunsPerDay: num(process.env.AGENCY_MAX_TASK_RUNS_PER_DAY, 24),
  postsPerDay: num(process.env.AGENCY_MAX_POSTS_PER_DAY, 12),
});

const parse = (raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw : {}); } catch { return {}; } };
const P = 'uncensored-chat:agency:';

export const kvStore = {
  enabled: KV_ENABLED,
  get: async (k) => parse(await kvGet(k)),
  set: (k, v) => kvSet(k, v),
  count: async (k) => Number(await kvGet(k)) || 0,
  incr: async (k, ttl) => { const n = await kvIncr(k); if (n === 1 && ttl) await kvExpire(k, ttl); return n; },
};

export function createAgencyControl(store = kvStore, clock = () => Date.now()) {
  const day = () => new Date(clock()).toISOString().slice(0, 10);

  // ── kill switch ──────────────────────────────────────────────────────
  async function getControl() {
    if (!store.enabled) return { paused: false, reason: '', at: null };
    const c = await store.get(`${P}control`);
    return { paused: c.paused === true, reason: String(c.reason || '').slice(0, 200), at: c.at || null };
  }
  async function setPaused(paused, reason = '') {
    const c = { paused: !!paused, reason: paused ? String(reason || '').slice(0, 200) : '', at: new Date(clock()).toISOString() };
    await store.set(`${P}control`, c);
    return c;
  }

  // ── per-task state ───────────────────────────────────────────────────
  const taskKey = (id) => `${P}task:${id}`;
  async function getTaskState(id) {
    if (!store.enabled || !id) return {};
    return store.get(taskKey(id));
  }
  async function recordTaskSuccess(id) {
    const s = { lastRunAt: new Date(clock()).toISOString(), failCount: 0, lastError: null, nextRunAt: null, pausedReason: null };
    if (store.enabled) await store.set(taskKey(id), s);
    return s;
  }
  /** Back off after a failure; after MAX_FAILS in a row the task pauses itself until resumed. */
  async function recordTaskFailure(id, err) {
    const prev = await getTaskState(id);
    const failCount = (prev.failCount || 0) + 1;
    const paused = failCount >= MAX_FAILS;
    const s = {
      ...prev,
      failCount,
      lastError: String(err?.message || err || 'failed').slice(0, 300),
      nextRunAt: new Date(clock() + backoffMs(failCount)).toISOString(),
      pausedReason: paused ? `Paused after ${failCount} failures in a row. Last error: ${String(err?.message || err).slice(0, 200)}` : null,
    };
    if (store.enabled) await store.set(taskKey(id), s);
    return { ...s, justPaused: paused && !prev.pausedReason };
  }
  async function resumeTask(id) {
    const prev = await getTaskState(id);
    const s = { ...prev, failCount: 0, lastError: null, nextRunAt: null, pausedReason: null };
    if (store.enabled) await store.set(taskKey(id), s);
    return s;
  }

  // ── daily caps ───────────────────────────────────────────────────────
  /** Count one use; false (and not counted as allowed) once today's cap is reached. */
  async function consume(kind, cap) {
    if (!store.enabled) return true;
    const n = await store.incr(`${P}usage:${day()}:${kind}`, 2 * 86_400);
    return n === null || n <= cap;
  }
  async function usage() {
    if (!store.enabled) return { day: day(), taskRuns: 0, posts: 0 };
    const [taskRuns, posts] = await Promise.all([store.count(`${P}usage:${day()}:taskRuns`), store.count(`${P}usage:${day()}:posts`)]);
    return { day: day(), taskRuns, posts };
  }

  return { getControl, setPaused, getTaskState, recordTaskSuccess, recordTaskFailure, resumeTask, consume, usage };
}

/** A task is due when its schedule says so, it is enabled, not paused, and not in a backoff. */
export function isDueWithState(task, state, scheduleMs, now = Date.now()) {
  if (!task.enabled || state?.pausedReason) return false;
  if (state?.nextRunAt && Date.parse(state.nextRunAt) > now) return false;
  const lastRunAt = state?.lastRunAt || task.lastRunAt;
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  return Number.isNaN(last) || now - last >= scheduleMs;
}

export const agency = createAgencyControl();
