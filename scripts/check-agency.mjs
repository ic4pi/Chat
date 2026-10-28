// Agency controls: backoff, auto-pause, kill switch, daily caps — against an in-memory store.
import { createAgencyControl, isDueWithState, backoffMs, MAX_FAILS } from '../lib/agency-control.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };

const mem = new Map();
const store = {
  enabled: true,
  get: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : {}),
  set: async (k, v) => { mem.set(k, JSON.stringify(v)); },
  count: async (k) => Number(mem.get(k)) || 0,
  incr: async (k) => { const n = (Number(mem.get(k)) || 0) + 1; mem.set(k, String(n)); return n; },
};
let t = Date.parse('2026-10-28T10:00:00Z');
const a = createAgencyControl(store, () => t);
const HOUR = 3_600_000, DAY = 24 * HOUR;
const task = { id: 'x', enabled: true, schedule: 'hourly' };

// ── backoff and auto-pause ───────────────────────────────────────────────
ok('backoff doubles from one hour and caps at a day', backoffMs(1) === HOUR && backoffMs(2) === 2 * HOUR && backoffMs(3) === 4 * HOUR && backoffMs(20) === DAY);
ok('a never-run task is due', isDueWithState(task, {}, HOUR, t));
let st = await a.recordTaskFailure('x', new Error('boom'));
ok('one failure is recorded with its error', st.failCount === 1 && st.lastError === 'boom' && !st.pausedReason);
ok('...and the task waits out its backoff instead of retrying every tick', !isDueWithState(task, st, HOUR, t + HOUR / 2) && isDueWithState(task, st, HOUR, t + HOUR + 1));
st = await a.recordTaskFailure('x', new Error('boom'));
ok('the second failure waits twice as long', Date.parse(st.nextRunAt) - t === 2 * HOUR);
for (let i = 2; i < MAX_FAILS; i++) st = await a.recordTaskFailure('x', new Error('boom'));
ok(`${MAX_FAILS} failures in a row pause the task`, !!st.pausedReason && st.justPaused === true);
ok('a paused task is never due', !isDueWithState(task, st, HOUR, t + 100 * DAY));
st = await a.recordTaskFailure('x', new Error('boom'));
ok('only the first pause is announced', st.justPaused === false);
st = await a.resumeTask('x');
ok('resuming clears the pause and the failure count', !st.pausedReason && st.failCount === 0 && isDueWithState(task, st, HOUR, t));
await a.recordTaskFailure('x', new Error('boom'));
st = await a.recordTaskSuccess('x');
ok('a success resets everything and sets lastRunAt', st.failCount === 0 && !st.nextRunAt && st.lastRunAt === new Date(t).toISOString());
ok('after a success the schedule applies again', !isDueWithState(task, st, HOUR, t + HOUR / 2) && isDueWithState(task, st, HOUR, t + HOUR));
ok('a disabled task is not due', !isDueWithState({ ...task, enabled: false }, {}, HOUR, t));
ok('one task failing leaves others alone', (await a.getTaskState('other')).failCount === undefined);

// ── kill switch ──────────────────────────────────────────────────────────
ok('not paused by default', (await a.getControl()).paused === false);
await a.setPaused(true, 'testing');
let c = await a.getControl();
ok('pausing is stored with its reason', c.paused === true && c.reason === 'testing');
await a.setPaused(false);
ok('resuming clears it', (await a.getControl()).paused === false);

// ── daily caps ───────────────────────────────────────────────────────────
const results = [];
for (let i = 0; i < 5; i++) results.push(await a.consume('posts', 3));
ok('uses up to the cap are allowed, the rest refused', results.join() === 'true,true,true,false,false');
ok('usage reports what was counted', (await a.usage()).posts === 5);
t += DAY;
ok('the cap resets the next day', (await a.consume('posts', 3)) === true && (await a.usage()).posts === 1);
ok('a store without KV never blocks', (await createAgencyControl({ enabled: false }).consume('posts', 0)) === true);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall agency checks passed');
