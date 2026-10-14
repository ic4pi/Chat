// Client workspaces: the wall must hold. No database needed — scopeToClient
// takes the db as an argument, so a small in-memory stand-in exercises it.
import assert from 'node:assert/strict';
import { ClientAccessError, clientIdFromHeaders, scopeToClient, cleanProfile, clientBrief } from '../lib/client-scope.js';

const A = '11111111-1111-4111-8111-111111111111';          // owner A
const B = '22222222-2222-4222-8222-222222222222';          // owner B
const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';         // client of A
const A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';         // archived client of A
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';         // client of B

const rows = [
  { id: A1, parent_owner_id: A, archived: false },
  { id: A2, parent_owner_id: A, archived: true },
  { id: B1, parent_owner_id: B, archived: false },
];
// Minimal stand-in for the supabase query builder used by scopeToClient.
function fakeDb(failWith) {
  return {
    from(table) {
      assert.equal(table, 'clients');
      const filters = [];
      const q = {
        select() { return q; },
        eq(col, val) { filters.push([col, val]); return q; },
        async maybeSingle() {
          if (failWith) return { data: null, error: { message: failWith } };
          const hit = rows.find((r) => filters.every(([c, v]) => r[c] === v));
          return { data: hit ? { id: hit.id } : null, error: null };
        },
      };
      return q;
    },
  };
}

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`check-clients: ok — ${name}`); }
  catch (err) { failed++; console.error(`check-clients: FAIL — ${name}\n  ${err.stack || err}`); }
}
const rejects = (p) => assert.rejects(p, (e) => e instanceof ClientAccessError && e.status === 403);

await check('no client header means the caller\'s own space', async () => {
  assert.equal(await scopeToClient(fakeDb(), A, null), A);
  assert.equal(await scopeToClient(fakeDb(), A, ''), A);
});
await check('own client resolves to the client\'s owner id', async () => {
  assert.equal(await scopeToClient(fakeDb(), A, A1), A1);
});
await check('another owner\'s client is refused, never answered from Personal', async () => {
  await rejects(scopeToClient(fakeDb(), A, B1));
  await rejects(scopeToClient(fakeDb(), B, A1));
});
await check('archived client is refused', async () => {
  await rejects(scopeToClient(fakeDb(), A, A2));
});
await check('malformed and unknown ids are refused', async () => {
  await rejects(scopeToClient(fakeDb(), A, 'not-a-uuid'));
  await rejects(scopeToClient(fakeDb(), A, `${A1}' or 1=1 --`));
  await rejects(scopeToClient(fakeDb(), A, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'));
});
await check('a database error fails closed', async () => {
  await rejects(scopeToClient(fakeDb('boom'), A, A1));
});
await check('x-client-id header is read (string or array), blank is Personal', () => {
  assert.equal(clientIdFromHeaders({ 'x-client-id': ` ${A1} ` }), A1);
  assert.equal(clientIdFromHeaders({ 'x-client-id': [A1] }), A1);
  assert.equal(clientIdFromHeaders({ 'x-client-id': '  ' }), null);
  assert.equal(clientIdFromHeaders({}), null);
});
await check('cleanProfile trims, caps and drops junk', () => {
  const p = cleanProfile({ voice: ' warm ', facts: ['a', '', 7, 'b'], dos: 'nope', links: new Array(50).fill('x') });
  assert.equal(p.voice, 'warm');
  assert.deepEqual(p.facts, ['a', '7', 'b']);
  assert.deepEqual(p.dos, []);
  assert.equal(p.links.length, 20);
  assert.deepEqual(cleanProfile(null).facts, []);
});
await check('clientBrief names the client, lists the profile, and fences other clients out', () => {
  const t = clientBrief('Acme Bakery', { voice: 'cheeky', facts: ['Open since 1999'], donts: ['no discounts'] });
  assert.match(t, /"Acme Bakery"/);
  assert.match(t, /Brand voice: cheeky/);
  assert.match(t, /- Open since 1999/);
  assert.match(t, /Never:\n- no discounts/);
  assert.match(t, /any other client/);
});

if (failed) { console.error(`check-clients: ${failed} failed`); process.exit(1); }
console.log('check-clients: all checks passed');
