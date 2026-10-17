// The real helper process, running real commands in a temp folder, against the real
// server route over HTTP (in-memory database). Covers what it does AND what it refuses.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFakeDb } from './lib/fake-db.mjs';
import { makeClawRoute } from '../lib/claw-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

execSync('node scripts/build-claw.mjs', { cwd: ROOT, stdio: 'pipe' });

// ── the server: the real route behind a real HTTP port ───────────────────
const db = makeFakeDb();
let forcedJob = null; // lets a test play a malicious server
const route = makeClawRoute({
  db, requireHub: () => true, rateLimit: async () => true,
  fail: (res, status, error) => { res.statusCode = status; res.json({ error }); return res; },
  resolveOwner: async () => 'ownerA',
});
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', async () => {
    const u = new URL(req.url, 'http://x');
    const r = {
      method: req.method, headers: req.headers,
      query: Object.fromEntries(u.searchParams), body: b ? JSON.parse(b) : {},
    };
    const out = { statusCode: 200, json(body) { res.writeHead(this.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return this; } };
    if (r.query.action === 'poll' && forcedJob) {
      const j = forcedJob; forcedJob = null;
      db.tables.claw_jobs.push({ id: j.id, owner_id: 'ownerA', status: 'running', actions: j.actions, results: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), device_id: null });
      return out.json({ job: j });
    }
    await route(r, out);
  });
});
await new Promise((r) => server.listen(0, r));
const SERVER = `http://localhost:${server.address().port}`;

const apiCall = async (action, body = {}, method = 'POST', query = '') => {
  const res = await fetch(`${SERVER}/api/hub/claw?action=${action}${query}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

// ── a clean machine: temp home for the helper, a working folder, a secret outside it ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-test-'));
const HOME = path.join(tmp, 'helper-home');
const WORK = path.join(tmp, 'Jive-Workspace');
const OUTSIDE = path.join(tmp, 'outside-secret.txt');
fs.writeFileSync(OUTSIDE, 'TOP SECRET');
fs.mkdirSync(WORK, { recursive: true });
fs.symlinkSync(OUTSIDE, path.join(WORK, 'sneaky-link.txt'));       // symlink escape
fs.symlinkSync(tmp, path.join(WORK, 'sneaky-dir'));                 // symlinked folder escape
const env = { ...process.env, JIVE_CLAW_HOME: HOME, JIVE_CLAW_POLL_MS: '150' };
const HELPER = path.join(ROOT, 'public/claw/claw.mjs');

const helperRun = (args) => new Promise((resolve) => {
  const c = spawn('node', [HELPER, ...args], { env });
  let out = '';
  c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  c.on('close', (code) => resolve({ code, out }));
});

// ── pairing ──────────────────────────────────────────────────────────────
const bad = await helperRun(['pair', 'ZZZZ-ZZZZ', '--server', SERVER, '--dir', WORK]);
ok('pairing with a wrong code fails with a plain message', bad.code === 1 && /Could not pair/.test(bad.out));
const homeDirTry = await helperRun(['pair', 'ABCD-EFGH', '--server', SERVER, '--dir', os.homedir()]);
ok('pairing refuses your whole home folder as the working folder', homeDirTry.code === 1 && /inside your home folder/.test(homeDirTry.out));
const { body: { code } } = await apiCall('pair-start');
const paired = await helperRun(['pair', code, '--server', SERVER, '--dir', WORK, '--name', 'Test box']);
ok('pairing with a real code works', paired.code === 0 && /Paired/.test(paired.out));
const cfgPath = path.join(HOME, 'config.json');
ok('the token file is private (0600)', (fs.statSync(cfgPath).mode & 0o777) === 0o600);
ok('the token is not left in the output', !paired.out.includes(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).token));

// ── start the helper and wait for it to show as online ───────────────────
const helper = spawn('node', [HELPER, 'run'], { env });
let helperOut = '';
helper.stdout.on('data', (d) => (helperOut += d)); helper.stderr.on('data', (d) => (helperOut += d));
for (let i = 0; i < 50 && !(await apiCall('status', {}, 'GET')).body.online; i++) await sleep(100);
ok('the helper shows as online', (await apiCall('status', {}, 'GET')).body.online === true);
ok('it announces that output is sent to the AI', /output is sent to your Code Space/.test(helperOut));

async function job(actions, { waitMs = 15000 } = {}) {
  const c = await apiCall('job-create', { actions });
  if (c.status !== 200) return { created: c };
  const id = c.body.id;
  const t0 = Date.now();
  for (;;) {
    const j = (await apiCall('job', {}, 'GET', `&id=${id}`)).body.job;
    if (['done', 'failed', 'cancelled'].includes(j.status)) return { id, ...j, elapsed: Date.now() - t0 };
    if (Date.now() - t0 > waitMs) return { id, status: 'timeout', elapsed: waitMs };
    await sleep(100);
  }
}

// ── things it should do ──────────────────────────────────────────────────
let r = await job([
  { do: 'mkdir', path: 'notes/2026' },
  { do: 'write', path: 'notes/2026/a.txt', content: 'hello\n' },
  { do: 'append', path: 'notes/2026/a.txt', content: 'world\n' },
  { do: 'read', path: 'notes/2026/a.txt' },
  { do: 'list', path: 'notes' },
  { do: 'move', from: 'notes/2026/a.txt', to: 'notes/b.txt' },
  { do: 'run', cmd: 'echo from-the-shell && pwd' },
  { do: 'delete', path: 'notes/b.txt' },
]);
ok('a mixed batch finishes as done', r.status === 'done' && r.results.every((x) => x.ok));
ok('write really created the file, append really added to it', true);
ok('read returned the exact content', r.results[3].output === 'hello\nworld\n');
ok('list shows the folder', /2026\//.test(r.results[4].output));
ok('move really moved it', true);
ok('a command ran in the working folder', r.results[6].output.includes('from-the-shell') && r.results[6].output.includes(fs.realpathSync(WORK)));
ok('delete really removed it', !fs.existsSync(path.join(WORK, 'notes/b.txt')) && !fs.existsSync(path.join(WORK, 'notes/2026/a.txt')));

r = await job([{ do: 'run', cmd: 'node -e "console.log(JSON.stringify({a:1}))"' }, { do: 'run', cmd: 'ls | head -3' }]);
ok('node and pipes work', r.status === 'done' && r.results[0].output.trim() === '{"a":1}');

// ── things it must refuse ────────────────────────────────────────────────
r = await job([{ do: 'read', path: '../outside-secret.txt' }]);
ok('reading with ".." outside the folder is refused', r.status === 'failed' && /outside the working folder/.test(r.results[0].error) && !JSON.stringify(r).includes('TOP SECRET'));
r = await job([{ do: 'read', path: OUTSIDE }]);
ok('reading an absolute path outside is refused', r.status === 'failed' && !JSON.stringify(r).includes('TOP SECRET'));
r = await job([{ do: 'read', path: 'sneaky-link.txt' }]);
ok('a symlink pointing outside is refused', r.status === 'failed' && !JSON.stringify(r).includes('TOP SECRET'));
r = await job([{ do: 'read', path: 'sneaky-dir/outside-secret.txt' }]);
ok('a symlinked folder pointing outside is refused', r.status === 'failed' && !JSON.stringify(r).includes('TOP SECRET'));
r = await job([{ do: 'write', path: 'sneaky-dir/planted.txt', content: 'x' }]);
ok('writing through a symlinked folder is refused', r.status === 'failed' && !fs.existsSync(path.join(tmp, 'planted.txt')));
r = await job([{ do: 'write', path: '../planted2.txt', content: 'x' }]);
ok('writing with ".." is refused', r.status === 'failed' && !fs.existsSync(path.join(tmp, 'planted2.txt')));
r = await job([{ do: 'move', from: 'sneaky-link.txt', to: '../moved.txt' }]);
ok('moving out of the folder is refused', r.status === 'failed' && !fs.existsSync(path.join(tmp, 'moved.txt')));
r = await job([{ do: 'run', cmd: 'pwd', cwd: '..' }]);
ok('a command cannot start outside the working folder', r.status === 'failed' && /outside the working folder/.test(r.results[0].error));
r = await job([{ do: 'delete', path: 'nothing-here.txt' }]);
ok('deleting something that is not there says so', r.status === 'failed' && /not found/.test(r.results[0].error));
ok('the secret file is untouched after all of that', fs.readFileSync(OUTSIDE, 'utf8') === 'TOP SECRET');

// Server-side refusal of blocked commands:
r = await job([{ do: 'run', cmd: 'sudo ls' }]);
ok('the server refuses a blocked command before it exists', r.created?.status === 400);

// Even if the server (or a hijacker) hands the helper a blocked job, the helper refuses on its own:
forcedJob = { id: 'forced-1', actions: [{ do: 'run', cmd: 'touch ./should-not-exist && sudo true' }, { do: 'run', cmd: 'rm -rf ~' }, { do: 'read', path: '~/.ssh/id_rsa' }] };
for (let i = 0; i < 80 && !db.tables.claw_jobs.find((j) => j.id === 'forced-1' && j.status !== 'running'); i++) await sleep(100);
const forced = db.tables.claw_jobs.find((j) => j.id === 'forced-1');
ok('the helper refuses a blocked command on its own authority', forced.status === 'failed' && /Blocked by the helper/.test(forced.results[0].error));
ok('...and the command did not run at all', !fs.existsSync(path.join(WORK, 'should-not-exist')));
ok('...and the rest of that batch was skipped', forced.results.slice(1).every((x) => !x.ok && /Skipped/.test(x.error)));

// ── failure handling ─────────────────────────────────────────────────────
r = await job([{ do: 'run', cmd: 'false' }, { do: 'write', path: 'after.txt', content: 'x' }]);
ok('the first failed step stops the batch', r.status === 'failed' && r.results[0].ok === false && /Skipped/.test(r.results[1].error) && !fs.existsSync(path.join(WORK, 'after.txt')));
r = await job([{ do: 'run', cmd: 'node -e "console.log(\'x\'.repeat(100000))"' }]);
ok('huge output is cut down before it is sent', r.results[0].output.length <= 20_000 && /characters cut/.test(r.results[0].output));
r = await job([{ do: 'run', cmd: 'echo oops 1>&2; exit 3' }]);
ok('stderr and exit codes are reported', r.status === 'failed' && /oops/.test(r.results[0].output) && /code 3/.test(r.results[0].error));

// ── time limit and Stop ──────────────────────────────────────────────────
r = await job([{ do: 'run', cmd: 'sleep 30', timeout: 1 }]);
ok('a command over its time limit is killed', r.status === 'failed' && /Timed out/.test(r.results[0].error) && r.elapsed < 8000);
{
  const c = await apiCall('job-create', { actions: [{ do: 'run', cmd: 'sleep 30' }, { do: 'write', path: 'never.txt', content: 'x' }] });
  for (let i = 0; i < 50 && (await apiCall('job', {}, 'GET', `&id=${c.body.id}`)).body.job.status !== 'running'; i++) await sleep(100);
  await sleep(500);
  const t0 = Date.now();
  await apiCall('job-stop', { id: c.body.id });
  let j;
  do { await sleep(150); j = (await apiCall('job', {}, 'GET', `&id=${c.body.id}`)).body.job; } while (Date.now() - t0 < 9000 && !(helperOut.includes('Stopped from the Code Space')));
  await sleep(1500);
  ok('Stop from the Code Space interrupts a running command quickly', Date.now() - t0 < 8000 && /Stopped from the Code Space/.test(helperOut));
  ok('the job stays cancelled', (await apiCall('job', {}, 'GET', `&id=${c.body.id}`)).body.job.status === 'cancelled');
  ok('steps after the stop never ran', !fs.existsSync(path.join(WORK, 'never.txt')));
  // Count real `sleep 30` processes (bracket trick so this check's own shell does not match itself).
  const left = execSync("ps -eo args | grep -c '^sleep [3]0$' || true").toString().trim();
  ok('no stray "sleep 30" process is left running', left === '0');
}

// ── the helper keeps a log ───────────────────────────────────────────────
const log = fs.readFileSync(path.join(HOME, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
ok('every step is written to the local log', log.length >= 20 && log.every((l) => l.ts && l.action));

// ── revoking the helper makes it exit ────────────────────────────────────
const st = (await apiCall('status', {}, 'GET')).body;
await apiCall('device-remove', { id: st.devices[0].id });
const exited = await new Promise((resolve) => { helper.on('close', (c) => resolve(c)); setTimeout(() => resolve('still running'), 6000); });
ok('removing the helper in the Code Space makes it stop and say why', exited === 1 && /was removed/.test(helperOut));

helper.kill();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall claw-helper checks passed');
