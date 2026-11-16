// Leads: validation, intake limits, dedupe, drafting, and the send-once guarantee — in memory, no network.
import { createLeads, validateLeadInput, parseDraft, buildDraftPrompt, draftReply, sendApproved, INTAKE_PER_HOUR } from '../lib/leads.js';
import { businessBlock } from '../lib/business-profile.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };

let blob = {}; const counters = new Map();
const store = {
  enabled: true,
  get: async () => JSON.parse(JSON.stringify(blob)),
  set: async (v) => { blob = JSON.parse(JSON.stringify(v)); },
  hit: async (k) => { const n = (counters.get(k) || 0) + 1; counters.set(k, n); return n; },
};
let t = Date.parse('2026-11-16T10:00:00Z'); let n = 0;
const L = createLeads(store, () => t, () => String(++n).padStart(4, '0'));

// ── validation ───────────────────────────────────────────────────────────
ok('a bot that fills the hidden field is dropped silently', validateLeadInput({ email: 'a@b.co', message: 'hello there', website: 'http://spam' }).silent === true);
ok('a bad email is refused with a human message', validateLeadInput({ email: 'nope', message: 'hello there' }).ok === false);
ok('a one-word message is refused', validateLeadInput({ email: 'a@b.co', message: 'hi' }).ok === false);
const good = validateLeadInput({ name: ' Ann ', email: ' ANN@Example.com ', message: 'I need a website for my bakery', company: 'Ann Bakes' });
ok('input is trimmed and the email lower-cased', good.ok && good.lead.email === 'ann@example.com' && good.lead.name === 'Ann');
ok('control characters are stripped', validateLeadInput({ email: 'a@b.co', message: 'hel\u0000lo there' }).lead.message === 'hello there');

// ── intake ───────────────────────────────────────────────────────────────
const a = await L.add(good.lead, '1.2.3.4');
ok('a lead is saved as new with an id', a.ok && a.lead.status === 'new' && a.lead.id.startsWith('l_'));
const dup = await L.add(good.lead, '1.2.3.4');
ok('the same inquiry sent twice is one lead', dup.duplicate === true && (await L.list()).length === 1);
let blocked = false;
for (let i = 0; i < INTAKE_PER_HOUR + 1; i++) { const r = await L.add({ ...good.lead, message: `different message ${i}` }, '9.9.9.9'); if (r.status === 429) blocked = true; }
ok(`more than ${INTAKE_PER_HOUR} an hour from one sender is refused`, blocked);
ok('another sender is not affected', (await L.add({ ...good.lead, message: 'another person asking' }, '5.5.5.5')).ok);

// ── drafting ─────────────────────────────────────────────────────────────
ok('parseDraft reads a SUBJECT line', parseDraft('SUBJECT: Your bakery site\n\nHi Ann,\nThanks.').subject === 'Your bakery site');
ok('parseDraft tolerates a missing label', parseDraft('Hi Ann, thanks.').body === 'Hi Ann, thanks.' && parseDraft('Hi Ann, thanks.').subject === '');
const biz = businessBlock({ profile: 'We build sites.', offers: 'Starter site — $900', notes: '' });
ok('the business block carries the offers as authoritative', biz.includes('Starter site — $900') && /never invent a price/i.test(biz));
ok('no profile means no block', businessBlock({ profile: '', offers: '', notes: '' }) === '');
ok('the draft prompt forbids inventing prices and placeholders', /never invent a number/i.test(buildDraftPrompt({ lead: a.lead }).system) && /no placeholders/i.test(buildDraftPrompt({ lead: a.lead }).system));
const drafted = await draftReply(L, a.lead.id, { complete: async () => 'SUBJECT: Re: your bakery\n\nHi Ann — the Starter site is $900.', businessText: biz, by: 'Marcus' });
ok('a draft is saved and the lead moves to drafted', drafted.status === 'drafted' && drafted.draft.subject === 'Re: your bakery' && drafted.draft.by === 'Marcus');
let emptyFailed = false; try { await draftReply(L, a.lead.id, { complete: async () => '   ' }); } catch { emptyFailed = true; }
ok('an empty model reply never overwrites a draft', emptyFailed && (await L.get(a.lead.id)).draft.body.includes('Starter site'));

// ── send once ────────────────────────────────────────────────────────────
const sentTo = [];
const send = async (m) => { sentTo.push(m); };
let noDraft = false; try { await sendApproved(L, dup.lead.id === a.lead.id ? (await L.list()).find((l) => !l.draft).id : '', { send }); } catch { noDraft = true; }
ok('a lead with no draft cannot be sent', noDraft && sentTo.length === 0);
const sent = await sendApproved(L, a.lead.id, { send });
ok('the approved draft goes to the lead\'s own address', sentTo.length === 1 && sentTo[0].to === 'ann@example.com' && sent.status === 'sent' && !!sent.sentAt);
let twice = false; try { await sendApproved(L, a.lead.id, { send }); } catch { twice = true; }
ok('it can never be sent twice', twice && sentTo.length === 1);

// a failed send releases the claim, records why, and can be retried
const b = (await L.add({ ...good.lead, email: 'bob@example.com', message: 'need a campaign please' }, '7.7.7.7')).lead;
await L.update(b.id, { draft: { subject: 's', body: 'hello bob' } });
let boom = false; try { await sendApproved(L, b.id, { send: async () => { throw new Error('Resend down'); } }); } catch { boom = true; }
const after = await L.get(b.id);
ok('a failed send records the error and stays unsent', boom && !after.sentAt && after.sendError === 'Resend down' && !after.sendingAt);
await sendApproved(L, b.id, { send });
ok('...and the retry goes through', (await L.get(b.id)).status === 'sent' && sentTo.length === 2);

// a crash mid-send (claim never released) blocks for 10 minutes, then the owner may retry
const c = (await L.add({ ...good.lead, email: 'cy@example.com', message: 'something else entirely' }, '8.8.8.8')).lead;
await L.update(c.id, { draft: { subject: 's', body: 'hello cy' } });
await L.claimSend(c.id);
ok('a fresh claim blocks a second send', (await L.claimSend(c.id)) === null);
t += 11 * 60_000;
ok('a stale claim (crashed sender) can be retaken', (await L.claimSend(c.id)) !== null);

// ── owner edits and the summary ──────────────────────────────────────────
await L.update(a.lead.id, { status: 'won', value: '1200' });
await L.update(b.id, { status: 'lost' });
ok('an unknown status is ignored', (await L.update(b.id, { status: 'banana' })).status === 'lost');
const sum = await L.summary();
ok('the summary counts wins and sums their value', sum.won === 1 && sum.wonValue === 1200 && sum.lost === 1);
ok('a negative or junk value is ignored', (await L.update(a.lead.id, { value: 'abc' })).value === 1200);

process.exit(failed ? 1 : 0);
