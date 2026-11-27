// Agency controls: backoff, auto-pause, kill switch, daily caps — against an in-memory store.
import { createAgencyControl, isDueWithState, backoffMs, MAX_FAILS } from '../lib/agency-control.js';
import { buildBrandTask, isAutomationDue, AUTO_MAX_FAILS } from '../lib/brand-automation.js';

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

// ── brand automation ───────────────────────────────────────────────────
ok('off is never due', !isAutomationDue({ every: 'off' }) && !isAutomationDue({}) && !isAutomationDue({ every: 'nonsense' }));
ok('a brand that never ran is due on the next tick', isAutomationDue({ every: 'daily' }, t));
ok('daily waits a day, weekly waits a week',
  !isAutomationDue({ every: 'daily', lastRunAt: new Date(t).toISOString() }, t + HOUR)
  && isAutomationDue({ every: 'daily', lastRunAt: new Date(t).toISOString() }, t + DAY)
  && !isAutomationDue({ every: 'weekly', lastRunAt: new Date(t).toISOString() }, t + DAY)
  && isAutomationDue({ every: 'weekly', lastRunAt: new Date(t).toISOString() }, t + 7 * DAY));
const brandTask = buildBrandTask(
  { id: 'swearjar', name: 'Swear Jar' },
  { brandName: 'Swear Jar', kind: 'comedy', profile: 'A comedy production company.', offers: 'Fri 8pm — The Room — tickets: example.com' },
  'daily'
);
ok('the automated task carries the brand profile and shows into the brief', brandTask.objective.includes('A comedy production company.') && brandTask.objective.includes('Fri 8pm') && brandTask.id === 'auto-swearjar');
ok('automated runs stay draft-and-approve and out of the cron task list', /drafts only/.test(brandTask.objective) && brandTask.schedule === 'manual');
let auto = await a.setAutomation('swearjar', 'daily');
ok('a brand schedule is saved', auto.every === 'daily');
await a.noteAutomationResult('swearjar', { summary: 'did work', turns: 4, toolsUsed: ['web'], prUrl: 'https://x/pr/1' });
auto = (await a.getAutomation()).swearjar;
ok('a good run stores its write-up and resets failures', auto.lastResult?.prUrl === 'https://x/pr/1' && auto.failCount === 0 && auto.lastRunAt === new Date(t).toISOString());
let af = await a.recordAutomationFailure('swearjar', new Error('boom'), AUTO_MAX_FAILS);
ok('a failure is counted, schedule kept', af.failCount === 1 && af.every === 'daily' && !af.justTurnedOff);
for (let i = 1; i < AUTO_MAX_FAILS; i++) af = await a.recordAutomationFailure('swearjar', new Error('boom'), AUTO_MAX_FAILS);
ok(`${AUTO_MAX_FAILS} failures turn the brand off by itself`, af.every === 'off' && af.justTurnedOff === true);
ok('...and turning itself off sticks', (await a.getAutomation()).swearjar.every === 'off');
auto = await a.setAutomation('swearjar', 'weekly');
ok('re-enabling resets the fail counter but keeps the history', auto.every === 'weekly' && auto.failCount === 0 && auto.lastResult?.prUrl === 'https://x/pr/1');
ok('one brand’s automation leaves the others alone', ((await a.getAutomation()).capicapi || {}).every === undefined);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall agency checks passed');
