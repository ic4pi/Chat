/**
 * The submit/result endpoints exist only on Modal apps deployed from modal/.
 * Against the apps as currently deployed, submit 404s — and that must degrade
 * to the blocking route rather than surfacing as a broken generator. This
 * pins the 404 -> ASYNC_UNAVAILABLE mapping the client keys off.
 *
 *   node scripts/check-async-fallback.mjs
 */
import handler from '../api/media-generate.js';

const realFetch = globalThis.fetch;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`ok    ${name}`);
  else { failed++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

function fakeRes() {
  const r = { code: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const submitReq = (body) => ({
  method: 'POST',
  query: { op: 'submit' },
  headers: {},
  body: { model: 'ltx-video', prompt: 'a test clip', seconds: 5, ...body },
});

// Modal app without the job API — what is deployed today.
globalThis.fetch = async () => new Response('Not Found', { status: 404 });
{
  const res = fakeRes();
  await handler(submitReq(), res);
  check('404 from Modal maps to 501', res.code === 501, `got ${res.code}`);
  check('carries ASYNC_UNAVAILABLE for the client to key off',
        res.body?.code === 'ASYNC_UNAVAILABLE', JSON.stringify(res.body));
  check('the message says how to fix it',
        /deploy modal\//i.test(res.body?.error || ''), res.body?.error);
}

// A genuine upstream failure must NOT be mistaken for a missing endpoint —
// falling back on a real error would hide it behind a second slow attempt.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: 'GPU exploded' }), {
    status: 500, headers: { 'content-type': 'application/json' },
  });
{
  const res = fakeRes();
  await handler(submitReq(), res);
  check('500 is not treated as a missing endpoint', res.body?.code !== 'ASYNC_UNAVAILABLE');
  check('the real error survives', /GPU exploded/.test(res.body?.error || ''), res.body?.error);
}

// A working job API still returns a job id.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ job_id: 'fc-123', status: 'running' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
{
  const res = fakeRes();
  await handler(submitReq(), res);
  check('a deployed job API returns 202 + jobId',
        res.code === 202 && res.body?.jobId === 'fc-123', JSON.stringify(res.body));
}

// Missing prompt is rejected before anything is dispatched.
{
  const res = fakeRes();
  await handler(submitReq({ prompt: '' }), res);
  check('empty prompt is rejected', res.code === 400, `got ${res.code}`);
}

globalThis.fetch = realFetch;
console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
