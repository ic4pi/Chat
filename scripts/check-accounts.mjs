// Accounts: sign up / sign in / sessions / password reset / owner claim, and who may see which personas.
// Runs the real handler on an in-memory fake database.
import assert from 'node:assert/strict';
import { makeFakeDb } from './lib/fake-db.mjs';
import { makeAccounts, hashPassword, verifyPassword, SESSION_DAYS } from '../lib/accounts.js';
import { makeAccountRoute } from '../lib/account-route.js';
import { makeRequestContext, visiblePersonas, BUILTIN_PERSONA_IDS } from '../lib/access.js';
import { resetThrottle, MAX_FAILURES } from '../lib/throttle.js';

process.env.ADMIN_USERNAME = 'owner';
process.env.ADMIN_PASSWORD = 'adminpw';
process.env.PAID_MODELS_PASSWORD = 'paidpw';

// --- password hashing
const h = hashPassword('correct horse battery');
assert.ok(h.startsWith('scrypt$'));
assert.ok(!h.includes('correct horse'));
assert.equal(verifyPassword('correct horse battery', h), true);
assert.equal(verifyPassword('wrong', h), false);
assert.equal(verifyPassword('x', 'garbage'), false);
assert.notEqual(hashPassword('same'), hashPassword('same'), 'every hash has its own salt');

// --- the route on a fake database
let clock = Date.parse('2026-12-01T00:00:00Z');
const fake = makeFakeDb(() => clock);
const accountsApi = makeAccounts({ db: fake, now: () => clock });
const sent = [];
const route = makeAccountRoute({
  accountsApi,
  resolveOwner: async () => 'owner-row',
  emailAccount: async () => ({ resendApiKey: 'k', fromEmail: 'hello@example.com' }),
  sendEmail: async (m) => { sent.push(m); return { id: 'x' }; },
});
const requestContext = makeRequestContext(accountsApi);

const mkRes = () => { const r = { h: {}, code: 200, body: null };
  r.setHeader = (k, v) => { r.h[k] = v; }; r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; }; return r; };
const call = async (op, { method = 'POST', body = {}, cookie = '', ip = '1.1.1.1', headers = {} } = {}) => {
  const res = mkRes();
  await route({ method, query: { op }, body, headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...headers }, socket: {} }, res);
  return res;
};
const cookieOf = (res) => String(res.h['Set-Cookie'] || '').split(';')[0];

resetThrottle();
const EMAIL = 'Fan@Example.com';
const PW = 'a long enough password';

// sign up: validation first
assert.equal((await call('signup', { body: { email: 'nope', password: PW } })).code, 400);
assert.equal((await call('signup', { body: { email: EMAIL, password: 'short' } })).code, 400);

let r = await call('signup', { body: { email: EMAIL, password: PW } });
assert.equal(r.code, 200);
assert.equal(r.body.account.email, EMAIL);
assert.equal(r.body.account.isOwner, false);
assert.equal(r.body.account.plan, 'free');
assert.match(r.h['Set-Cookie'], /HttpOnly/); assert.match(r.h['Set-Cookie'], /Secure/); assert.match(r.h['Set-Cookie'], /SameSite=Lax/);
const row = fake.tables.accounts[0];
assert.ok(row.password_hash.startsWith('scrypt$') && !row.password_hash.includes(PW), 'the password is stored only as a hash');
assert.ok(fake.tables.account_sessions.every((s) => s.token_hash.length === 64), 'the session secret is stored only as a hash');
const session1 = cookieOf(r);

assert.equal((await call('signup', { body: { email: 'fan@example.COM', password: PW } })).code, 409, 'the same email in any case is the same account');

// who am I
assert.equal((await call('me', { method: 'GET', cookie: session1 })).body.account.email, EMAIL);
assert.equal((await call('me', { method: 'GET' })).body.account, null);
assert.equal((await call('me', { method: 'GET', cookie: 'jive_session=forged' })).body.account, null);

// sign in: a wrong password and an unknown email look exactly the same
const wrongPw = await call('login', { body: { email: EMAIL, password: 'not the password' } });
const noUser = await call('login', { body: { email: 'nobody@example.com', password: PW } });
assert.equal(wrongPw.code, 401); assert.equal(noUser.code, 401);
assert.equal(wrongPw.body.error, noUser.body.error);
r = await call('login', { body: { email: 'FAN@example.com', password: PW } });
assert.equal(r.code, 200);
const session2 = cookieOf(r);

// guess limit: per address, right passwords never counted
resetThrottle();
for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await call('login', { ip: '9.9.9.9', body: { email: EMAIL, password: `bad${i}` } })).code, 401);
assert.equal((await call('login', { ip: '9.9.9.9', body: { email: EMAIL, password: PW } })).code, 429, 'locked out after too many wrong passwords');
assert.equal((await call('login', { ip: '8.8.8.8', body: { email: EMAIL, password: PW } })).code, 200, 'another address is unaffected');
resetThrottle();

// sign out
r = await call('logout', { cookie: session2 });
assert.match(r.h['Set-Cookie'], /Max-Age=0/);
assert.equal((await call('me', { method: 'GET', cookie: session2 })).body.account, null, 'a signed-out session is dead');
assert.equal((await call('me', { method: 'GET', cookie: session1 })).body.account.email, EMAIL, 'other devices stay signed in');

// sessions expire
clock += (SESSION_DAYS + 1) * 86400_000;
assert.equal((await call('me', { method: 'GET', cookie: session1 })).body.account, null, 'a 31-day-old session has expired');

// password reset
resetThrottle();
assert.equal((await call('reset-request', { body: { email: 'nobody@example.com' } })).code, 200);
assert.equal(sent.length, 0, 'no email for an unknown address, and the answer is the same');
assert.equal((await call('reset-request', { body: { email: EMAIL } })).code, 200);
assert.equal(sent.length, 1);
assert.equal(sent[0].to, EMAIL);
const token = decodeURIComponent(sent[0].text.match(/\?reset=([^\s]+)/)[1]);
r = await call('login', { body: { email: EMAIL, password: PW } });
const sessionBeforeReset = cookieOf(r);
assert.equal((await call('reset', { body: { token, password: 'short' } })).code, 400);
assert.equal((await call('reset', { body: { token: 'wrong', password: 'a brand new password' } })).code, 400);
assert.equal((await call('reset', { body: { token, password: 'a brand new password' } })).code, 200);
assert.equal((await call('me', { method: 'GET', cookie: sessionBeforeReset })).body.account, null, 'a reset signs the account out everywhere');
assert.equal((await call('login', { body: { email: EMAIL, password: PW } })).code, 401, 'the old password stops working');
assert.equal((await call('login', { body: { email: EMAIL, password: 'a brand new password' } })).code, 200);
assert.equal((await call('reset', { body: { token, password: 'yet another password' } })).code, 400, 'a reset link works once');
resetThrottle();
await call('reset-request', { body: { email: EMAIL } });
const token2 = decodeURIComponent(sent[1].text.match(/\?reset=([^\s]+)/)[1]);
clock += 2 * 3600_000;
assert.equal((await call('reset', { body: { token: token2, password: 'a brand new password' } })).code, 400, 'a reset link expires after an hour');

// claim owner
resetThrottle();
r = await call('login', { body: { email: EMAIL, password: 'a brand new password' } });
const mine = cookieOf(r);
assert.equal((await call('claim-owner', { body: { adminUser: 'owner', adminPassword: 'adminpw' } })).code, 401, 'sign in first');
assert.equal((await call('claim-owner', { cookie: mine, body: { adminUser: 'owner', adminPassword: 'wrong' } })).code, 403);
assert.equal((await call('claim-owner', { cookie: mine, body: { adminUser: 'owner', adminPassword: 'paidpw' } })).code, 403, 'the paid-models password does not make anyone the owner');
r = await call('claim-owner', { cookie: mine, body: { adminUser: 'owner', adminPassword: 'adminpw' } });
assert.equal(r.code, 200); assert.equal(r.body.account.isOwner, true);

// --- who sees which personas
const config = { personas: ['nexus', 'plain', 'juno', 'agency-closer', 'agency-social', 'abc123secret'].map((id) => ({ id, name: id, systemPrompt: `prompt of ${id}` })) };
const ids = (ctx) => visiblePersonas(config, ctx).map((p) => p.id);
const other = await call('signup', { ip: '2.2.2.2', body: { email: 'friend@example.com', password: PW } });
const otherCookie = cookieOf(other);

assert.deepEqual(ids(await requestContext({ headers: {} })), BUILTIN_PERSONA_IDS, 'a stranger sees only the built-in personas');
assert.deepEqual(ids(await requestContext({ headers: { cookie: otherCookie } })), BUILTIN_PERSONA_IDS, 'a signed-in non-owner too');
assert.equal(ids(await requestContext({ headers: { cookie: mine } })).length, config.personas.length, 'the owner sees every persona');
assert.equal((await requestContext({ headers: { 'x-paid-password': 'adminpw' } })).isOwner, true, 'the app\'s own scheduled jobs (admin secret) see everything');
assert.equal((await requestContext({ headers: { 'x-paid-password': 'owner:adminpw' } })).isOwner, true);
assert.equal((await requestContext({ headers: { 'x-paid-password': 'paidpw' } })).isOwner, false, 'the paid-models password is not owner access');
assert.equal((await requestContext({ headers: { cookie: 'jive_session=forged' } })).isOwner, false);
// a hand-typed owner persona id does not open it: it is simply not in the list
assert.equal(visiblePersonas(config, { isOwner: false }).some((p) => p.id === 'agency-closer'), false);
// no database at all: the old open behaviour
assert.equal((await makeRequestContext(null)({ headers: {} })).isOwner, true);

console.log('accounts checks passed');
