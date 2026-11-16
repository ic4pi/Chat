import { reconnectPage } from '../lib/meta-token.js';
let failed = 0; const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++; };
const calls = [];
const fake = (routes) => async (url) => { calls.push(url); const u = new URL(url); const r = routes[u.pathname.replace('/v21.0', '')]; const out = typeof r === 'function' ? r(u) : r; return { ok: !out?.error, status: out?.error ? 400 : 200, json: async () => out }; };
const good = {
  '/app': (u) => (u.searchParams.get('access_token') === 'short' ? { id: 'APP1' } : { error: { message: 'Invalid OAuth access token.' } }),
  '/oauth/access_token': (u) => (u.searchParams.get('client_id') === 'APP1' && u.searchParams.get('client_secret') === 'SECRET' && u.searchParams.get('fb_exchange_token') === 'short' ? { access_token: 'LONG' } : { error: { message: 'bad exchange' } }),
  '/me/accounts': (u) => (u.searchParams.get('access_token') === 'LONG' ? { data: [{ id: '111', name: 'Other', access_token: 'P-OTHER' }, { id: '222', name: 'Semantiq', access_token: 'P-SEMANTIQ' }] } : { error: { message: 'bad' } }),
};
const r = await reconnectPage({ token: ' short ', pageId: '222', appSecret: 'SECRET', fetchImpl: fake(good) });
ok('a short-lived token becomes our Page\'s own token', r.pageToken === 'P-SEMANTIQ' && r.pageName === 'Semantiq' && r.longLived);
ok('it picks OUR page, not another the user manages', r.pageId === '222');
ok('the secret is only sent to Meta in the exchange', calls.filter((u) => u.includes('client_secret')).length === 1);
const throws = async (f) => { try { await f(); return ''; } catch (e) { return e.message; } };
ok('a login that does not manage the page says which pages it does', /Other, Semantiq|manages Other/.test(await throws(() => reconnectPage({ token: 'short', pageId: '999', appSecret: 'SECRET', fetchImpl: fake(good) }))));
ok('Facebook\'s own error is shown for a bad token', (await throws(() => reconnectPage({ token: 'junk', pageId: '222', appSecret: 'SECRET', fetchImpl: fake(good) }))).includes('Invalid OAuth access token'));
ok('a missing app secret is explained', /META_APP_SECRET/.test(await throws(() => reconnectPage({ token: 'short', pageId: '222', appSecret: '', fetchImpl: fake(good) }))));
ok('an empty paste is refused', /Paste the token/.test(await throws(() => reconnectPage({ token: ' ', pageId: '222', appSecret: 'SECRET', fetchImpl: fake(good) }))));
const none = { ...good, '/me/accounts': { data: [] } };
ok('a login with no pages is explained', /does not manage any Facebook Pages/.test(await throws(() => reconnectPage({ token: 'short', pageId: '222', appSecret: 'SECRET', fetchImpl: fake(none) }))));
process.exit(failed ? 1 : 0);
