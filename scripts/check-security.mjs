// Who can publish to the owner's pages / send email from their account, and the guess limit on every password.
import assert from 'node:assert/strict';
import { resetThrottle, MAX_FAILURES } from '../lib/throttle.js';
import { requireAdminAuth } from '../lib/auth.js';
import { handleUnlockPaid } from '../lib/unlock-paid-handler.js';
import socialPost from '../api/social-post.js';

process.env.ADMIN_USERNAME = 'owner';
process.env.ADMIN_PASSWORD = 'adminpw';
process.env.PAID_MODELS_PASSWORD = 'paidpw';

const mkRes = () => { const r = { h: {}, code: 200, body: null };
  r.setHeader = (k, v) => { r.h[k] = v; }; r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; }; r.end = () => r; return r; };
const req = (ip, headers = {}, body = {}, method = 'POST') => ({ method, headers: { 'x-forwarded-for': ip, ...headers }, body, query: {} });
const post = async (ip, pw, body = {}) => { const res = mkRes(); await socialPost(req(ip, pw ? { 'x-paid-password': pw } : {}, body), res); return res; };

// --- publishing needs the ADMIN password, never the paid-models one
resetThrottle();
let r = await post('1.1.1.1', 'paidpw');
assert.equal(r.code, 403); assert.match(r.body.error, /admin password/i);
assert.equal((await post('1.1.1.2', '')).code, 403);
assert.equal((await post('1.1.1.3', 'adminpw')).code, 400, 'the admin password gets past auth (then fails on the missing accountId)');
assert.equal((await post('1.1.1.4', 'owner:adminpw')).code, 400, 'username:password works too');
for (let i = 0; i < 20; i++) assert.equal((await post('1.1.1.5', 'adminpw')).code, 400, 'right passwords are never counted');

// --- wrong guesses are cut off per address, not globally
resetThrottle();
for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await post('2.2.2.2', `guess${i}`)).code, 403);
r = await post('2.2.2.2', 'adminpw');
assert.equal(r.code, 429, 'after too many wrong guesses even the right password is refused from that address');
assert.ok(r.h['Retry-After']);
assert.equal((await post('3.3.3.3', 'adminpw')).code, 400, 'another address is unaffected');

// --- publishing is locked outright when no admin password is configured, even with the paid password
{
  const saved = process.env.ADMIN_PASSWORD; delete process.env.ADMIN_PASSWORD;
  resetThrottle();
  r = await post('4.4.4.4', 'paidpw');
  assert.equal(r.code, 403); assert.match(r.body.error, /locked/i);
  process.env.ADMIN_PASSWORD = saved;
}

// --- admin login (Basic auth) has the same guess limit; no Authorization header is never counted
resetThrottle();
const basic = (u, p) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const gate = async (ip, headers) => { const res = mkRes(); const ok = await requireAdminAuth(req(ip, headers, {}, 'GET'), res); return { ok, res }; };
for (let i = 0; i < 50; i++) assert.equal((await gate('5.5.5.5', {})).res.code, 401);   // anonymous visits / the cron never lock anyone
assert.equal((await gate('5.5.5.5', basic('owner', 'adminpw'))).ok, true);
for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await gate('6.6.6.6', basic('owner', `bad${i}`))).res.code, 401);
const locked = await gate('6.6.6.6', basic('owner', 'adminpw'));
assert.equal(locked.ok, false); assert.equal(locked.res.code, 429);
assert.equal((await gate('7.7.7.7', basic('owner', 'adminpw'))).ok, true);

// --- the paid-models unlock has it too
resetThrottle();
const unlock = async (ip, password) => { const res = mkRes(); await handleUnlockPaid(req(ip, {}, { password }), res); return res; };
assert.equal((await unlock('8.8.8.8', 'paidpw')).code, 200);
for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await unlock('9.9.9.9', `x${i}`)).code, 401);
assert.equal((await unlock('9.9.9.9', 'paidpw')).code, 429);

console.log('security checks passed');
