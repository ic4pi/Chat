// Server half of the Claw helper, driven end to end against an in-memory database.
import { makeFakeDb } from './lib/fake-db.mjs';
import { makeClawRoute, ONLINE_MS, STALE_APPROVED_MS, cleanResults } from '../lib/claw-api.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };

let clock = Date.parse('2026-10-17T12:00:00Z');
const db = makeFakeDb(() => clock);
const fail = (res, status, error) => { res.statusCode = status; res.body = { error }; return res; };
const route = makeClawRoute({
  db, fail, now: () => clock,
  requireHub: () => true,
  rateLimit: async () => true,
  resolveOwner: async (req) => req.headers['x-owner'] || 'ownerA',
});

// Calls the route like a request would: returns { status, body }.
async function call(action, { method = 'POST', body = {}, query = {}, owner, token } = {}) {
  const req = { method, query: { action, ...query }, body, headers: {} };
  if (owner) req.headers['x-owner'] = owner;
  if (token) req.headers.authorization = `Bearer ${token}`;
  const res = { statusCode: 200, body: null, json(b) { this.body = b; return this; } };
  await route(req, res);
  return { status: res.statusCode, body: res.body };
}

async function pair(owner = 'ownerA', label = 'Test Mac') {
  const { body: { code } } = await call('pair-start', { owner });
  const r = await call('pair-claim', { body: { code, label, workdir: '/Users/x/Jive-Workspace' } });
  return { code, ...r };
}

// ── pairing ──────────────────────────────────────────────────────────────
const p = await pair();
ok('pairing code has the XXXX-XXXX shape', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(p.code));
ok('claiming the code returns a device token', p.status === 200 && /^jc_\S{30,}/.test(p.body.token));
ok('the token is stored hashed, never in the clear', !JSON.stringify(db.tables).includes(p.body.token));
const tokenA = p.body.token;
ok('a code works once', (await call('pair-claim', { body: { code: p.code } })).status === 404);
ok('a wrong code is rejected', (await call('pair-claim', { body: { code: 'ZZZZ-ZZZZ' } })).status === 404);
ok('a short code is rejected', (await call('pair-claim', { body: { code: 'ABC' } })).status === 400);
{
  const { body: { code } } = await call('pair-start', { owner: 'ownerA' });
  clock += 11 * 60_000;
  ok('an expired code is rejected', (await call('pair-claim', { body: { code } })).status === 404);
  clock -= 11 * 60_000;
}
ok('a new code replaces the old one for that owner', await (async () => {
  const a = (await call('pair-start', { owner: 'ownerA' })).body.code;
  const b = (await call('pair-start', { owner: 'ownerA' })).body.code;
  return (await call('pair-claim', { body: { code: a } })).status === 404 && (await call('pair-claim', { body: { code: b } })).status === 200;
})());
// that last claim made a second device for ownerA; remove extras so later checks are simple
{
  const st = (await call('status', { method: 'GET' })).body;
  for (const d of st.devices) if (d.id !== p.body.deviceId) await call('device-remove', { body: { id: d.id } });
}

// ── online / offline ─────────────────────────────────────────────────────
let st = (await call('status', { method: 'GET' })).body;
ok('a freshly paired helper that has not polled is offline', st.devices.length === 1 && st.online === false);
ok('unknown token cannot poll', (await call('poll', { token: 'jc_' + 'x'.repeat(40) })).status === 401);
ok('no token cannot poll', (await call('poll')).status === 401);
ok('malformed token cannot poll', (await call('poll', { token: 'short' })).status === 401);
await call('poll', { token: tokenA, body: { workdir: '/Users/x/Jive-Workspace' } });
st = (await call('status', { method: 'GET' })).body;
ok('after polling the helper is online and shows its folder', st.online === true && st.devices[0].workdir === '/Users/x/Jive-Workspace');
clock += ONLINE_MS + 1000;
ok('and offline again after it stops polling', (await call('status', { method: 'GET' })).body.online === false);
await call('poll', { token: tokenA });

// ── creating a job (the Run tap) ─────────────────────────────────────────
const good = [{ do: 'list', path: '.' }, { do: 'run', cmd: 'git status' }];
ok('a blocked command is refused at the server', (await call('job-create', { body: { actions: [{ do: 'run', cmd: 'sudo ls' }] } })).status === 400);
ok('a malformed batch is refused', (await call('job-create', { body: { actions: 'rm -rf /' } })).status === 400);
{
  clock += ONLINE_MS + 1000;
  const r = await call('job-create', { body: { actions: good } });
  ok('no online helper: refused with a plain message', r.status === 409 && /not running/.test(r.body.error));
  await call('poll', { token: tokenA });
}
const created = await call('job-create', { body: { actions: good } });
ok('with the helper online a job is created', created.status === 200 && !!created.body.id);
const jobId = created.body.id;
ok('only one run at a time', (await call('job-create', { body: { actions: good } })).status === 409);
ok('the app can read its job', (await call('job', { method: 'GET', query: { id: jobId } })).body.job.status === 'approved');
ok("another owner cannot read that job", (await call('job', { method: 'GET', query: { id: jobId }, owner: 'ownerB' })).status === 404);

// ── the helper picks it up ───────────────────────────────────────────────
const other = await pair('ownerB', 'Other');
const tokenB = other.body.token;
ok("another owner's helper cannot see this job", (await call('poll', { token: tokenB })).body.job === null);
const polled = await call('poll', { token: tokenA });
ok('the helper receives the approved job', polled.body.job?.id === jobId && polled.body.job.actions.length === 2);
ok('the job is now running', (await call('job', { method: 'GET', query: { id: jobId } })).body.job.status === 'running');
ok('a second poll gets nothing (no double run)', (await call('poll', { token: tokenA })).body.job === null);
ok("another owner's helper cannot report on it", (await call('report', { token: tokenB, body: { id: jobId, status: 'done', results: [] } })).status === 404);
ok('an unknown job id is rejected', (await call('report', { token: tokenA, body: { id: 'nope', status: 'done', results: [] } })).status === 404);

const messy = [
  { i: 0, do: 'list', ok: true, output: 'a\nb', error: '', ms: 12.7, evil: '<script>' },
  { i: 1, do: 'run', ok: false, output: 'x'.repeat(50_000), error: 'y'.repeat(9000), ms: 'NaN' },
];
ok('results are cleaned: sizes capped, unknown fields dropped', (() => {
  const c = cleanResults(messy);
  return c[0].ms === 13 && !('evil' in c[0]) && c[1].output.length === 20_000 && c[1].error.length === 2000 && c[1].ms === 0;
})());
ok('results over the action limit are trimmed', cleanResults(Array.from({ length: 99 }, () => ({}))).length === 20);
ok('non-array results become empty', cleanResults('x').length === 0);
const rep = await call('report', { token: tokenA, body: { id: jobId, status: 'done', results: messy } });
ok('the helper can report results', rep.status === 200);
const fin = (await call('job', { method: 'GET', query: { id: jobId } })).body.job;
ok('the job is done and holds the cleaned results', fin.status === 'done' && fin.results.length === 2 && fin.results[1].output.length === 20_000);
ok('a finished job cannot be reported on again', (await call('report', { token: tokenA, body: { id: jobId, status: 'done', results: [] } })).status === 409);

// ── stopping ─────────────────────────────────────────────────────────────
const j2 = (await call('job-create', { body: { actions: good } })).body.id;
await call('poll', { token: tokenA });
ok('not stopped yet', (await call('check', { token: tokenA, body: { id: j2 } })).body.cancelled === false);
ok('Stop cancels a running job', (await call('job-stop', { body: { id: j2 } })).body.stopped === true);
ok('the helper sees the stop', (await call('check', { token: tokenA, body: { id: j2 } })).body.cancelled === true);
await call('report', { token: tokenA, body: { id: j2, status: 'done', results: [{ ok: true }] } });
ok('a late report cannot un-cancel it', (await call('job', { method: 'GET', query: { id: j2 } })).body.job.status === 'cancelled');
ok("another owner cannot stop someone else's job", await (async () => {
  const j = (await call('job-create', { body: { actions: good } })).body.id;
  const r = await call('job-stop', { body: { id: j }, owner: 'ownerB' });
  const still = (await call('job', { method: 'GET', query: { id: j } })).body.job.status;
  await call('job-stop', { body: { id: j } });
  return r.body.stopped === false && still === 'approved';
})());

// ── staleness ────────────────────────────────────────────────────────────
{
  await call('poll', { token: tokenA });
  const j = (await call('job-create', { body: { actions: good } })).body.id;
  clock += STALE_APPROVED_MS + 5000;
  const r = await call('poll', { token: tokenA });
  ok('a job nobody picked up in 2 minutes is not run later', r.body.job === null);
  const job = (await call('job', { method: 'GET', query: { id: j } })).body.job;
  ok('it is cancelled with a plain reason', job.status === 'cancelled' && /Expired/.test(job.results[0].error));
}

// ── a poisoned job in the database is not handed out ─────────────────────
{
  await call('poll', { token: tokenA });
  db.tables.claw_jobs.push({ id: 'poison', owner_id: 'ownerA', status: 'approved', actions: [{ do: 'run', cmd: 'sudo rm -rf /' }], results: null, created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString(), device_id: null });
  const r = await call('poll', { token: tokenA });
  ok('even a job that bypassed validation is re-checked and not handed out', r.body.job === null && db.tables.claw_jobs.find((j) => j.id === 'poison').status === 'failed');
}

// ── removing a helper ────────────────────────────────────────────────────
ok("another owner cannot remove my helper", await (async () => {
  await call('device-remove', { body: { id: p.body.deviceId }, owner: 'ownerB' });
  return (await call('status', { method: 'GET' })).body.devices.length === 1;
})());
await call('device-remove', { body: { id: p.body.deviceId } });
ok('removing the helper revokes its token at once', (await call('poll', { token: tokenA })).status === 401);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall claw-api checks passed');
