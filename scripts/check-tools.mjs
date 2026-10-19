#!/usr/bin/env node
// Offline checks for the / tool registry (no network, in-memory store, mocked LLM).
import assert from 'node:assert/strict';
process.env.OPENROUTER_API_KEY = 'test';

const llmReplies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('openrouter.ai')) {
    const content = llmReplies.shift() ?? 'LLM-OUTPUT';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }
  return realFetch(url, opts);
};

const { TOOLS, parseCommand, runTool, needsAuth, listTools } = await import('../lib/tools/index.js');
const { budgetPlan } = await import('../lib/tools/growth.js');
const { pageFacts } = await import('../lib/tools/util.js');
const { parseWhen } = await import('../lib/tools/core.js');
const run = (input, authed = false) => { const c = parseCommand(input); return runTool({ ...c, req: { headers: {} }, authed }); };

// registry
for (const n of ['email', 'post', 'search', 'image', 'voice', 'video', 'campaign', 'schedule', 'competitor', 'seo', 'trends', 'audit',
  'brand', 'variants', 'landing', 'crm', 'outreach', 'proposal', 'contract', 'ads', 'metrics', 'report', 'track']) {
  assert.ok(TOOLS.has(n), `missing /${n}`);
}
assert.equal(TOOLS.has('sms'), false);
assert.equal(listTools().length, TOOLS.size);

// parsing
assert.deepEqual(parseCommand('/crm list new'), { name: 'crm', args: 'list new', client: '' });
assert.deepEqual(parseCommand('/variants @Acme 3 | ad | go'), { name: 'variants', args: '3 | ad | go', client: 'acme' });
assert.equal(parseCommand('hello'), null);

// auth rules
assert.equal(needsAuth(TOOLS.get('email'), 'a|b|c'), true);
assert.equal(needsAuth(TOOLS.get('outreach'), 'list'), false);
assert.equal(needsAuth(TOOLS.get('outreach'), 'send o1'), true);
assert.equal(needsAuth(TOOLS.get('outreach'), 'auto o1 on'), true);
assert.equal(needsAuth(TOOLS.get('post'), ''), false);
assert.equal(needsAuth(TOOLS.get('post'), 'Page | hi'), true);
assert.equal(needsAuth(TOOLS.get('crm'), 'add x'), false);

// crm
await run('/crm add Dana Lee | dana@acme.com | Acme | met at expo');
let r = await run('/crm list');
assert.match(r.text, /Dana Lee/); assert.match(r.text, /new 1/);
await run('/crm status dana won');
assert.match((await run('/crm list won')).text, /Dana Lee/);
await run('/crm note dana | wants Q1 start');
assert.match((await run('/crm show dana')).text, /wants Q1 start/);
await assert.rejects(run('/crm status dana bogus'), /Usage/);

// brand + @client
await run('/brand set Acme Co | dry and direct | busy owners | navy/orange | no exclamation marks');
assert.match((await run('/brand show acme-co')).text, /dry and direct/);
llmReplies.push('ok');
let seenPrompt = '';
const f2 = globalThis.fetch;
globalThis.fetch = async (url, opts) => { if (String(url).includes('openrouter.ai')) seenPrompt = JSON.parse(opts.body).messages.at(-1).content; return f2(url, opts); };
await run('/variants @acme-co 3 | facebook ad | spring promo');
assert.match(seenPrompt, /BRAND KIT for Acme Co/); assert.match(seenPrompt, /no exclamation marks/);
globalThis.fetch = f2;

// outreach cadence: drafts only, nothing sent; replied stops it
llmReplies.push(JSON.stringify([1, 2, 3, 4].map((i) => ({ subject: `S${i}`, body: `B${i}` }))));
r = await run('/outreach new dana | book a strategy call');
assert.match(r.text, /nothing sent yet/);
const id = /`(o\w+)`/.exec(r.text)[1];
assert.match((await run(`/outreach show ${id}`)).text, /day \+14/);
await assert.rejects(run(`/outreach send ${id}`, true), /email account|No email account/i);
await run(`/outreach replied ${id}`);
assert.match((await run('/crm show dana')).text, /replied/);
assert.match((await run('/outreach list')).text, /replied/);

// schedule
assert.ok(parseWhen('in 2h') > Date.now() + 7000e3);
await assert.rejects(run('/schedule add in 1h | /email a@b.c | s | body'), /unlock/);
assert.match((await run('/schedule add in 1h | /crm list')).text, /Scheduled/);
assert.match((await run('/schedule list')).text, /\/crm list/);
const { processSchedule } = await import('../lib/tools/index.js');
assert.equal((await processSchedule({ headers: {} })).length, 0);

// track
r = await run('/track https://site.com/offer | Facebook | paid social | Spring Promo');
assert.match(r.text, /utm_source=facebook/); assert.match(r.text, /utm_medium=paid_social/);

// ads math
const m = budgetPlan('meta', 3000);
assert.equal(m.daily, 100); assert.equal(m.test, 600);
assert.ok(m.clicks[0] < m.clicks[1] && m.conv[0] <= m.conv[1]);
await assert.rejects(run('/ads myspace | $100 | x | y'), /Usage/);

// audit facts
const facts = pageFacts('<html><head><title>Hi</title><meta name="description" content="d"></head><body><h1>Head</h1><img src=a><img src=b alt="x"><a href="/x">x</a></body></html>', 'https://e.com/');
assert.equal(facts.title, 'Hi'); assert.equal(facts.imagesMissingAlt, 1); assert.equal(facts.h1[0], 'Head'); assert.equal(facts.viewportMeta, false);
await assert.rejects(run('/audit localhost:3000'), /not reachable/);

// metrics / report run without external accounts
assert.match((await run('/metrics')).text, /Pipeline/);


// ---- agencies / roles -------------------------------------------------------------------------
const { resolveAgency, listAgencyIds, loadRoles, findPersona, runSeat } = await import('../lib/agencies.js');
const { loadFilePersonas, DEFAULT_PERSONAS } = await import('../lib/config.js');
const { registry } = await import('../lib/tools/index.js');
// Personas as they exist live: repo files + built-ins + the ones saved in /admin (by name).
const live = ['Phoenix', 'Victoria', 'Gizzlaine', 'Joe King', 'Vera — Strategist', 'Dez — Copywriter', 'Cole — Booking & Outreach',
  'Nia — Social & Content', 'Priya — Growth & Analytics', 'Marcus — Client Relations & Closer', 'Ash — Recon & OSINT',
  'Rook — Web App Security', 'Voss — Network & Infra Security', 'Ilya — Malware & Reverse Engineering', 'Toma — Blue Team & Detection']
  .map((name, i) => ({ id: 'kv' + i, name, systemPrompt: `You are ${name}.` }));
const personas = [...DEFAULT_PERSONAS, ...(await loadFilePersonas()), ...live];
assert.equal(findPersona(personas, 'Phoenix').name, 'Phoenix');
assert.equal(findPersona(personas, 'vera').name, 'Vera — Strategist');
assert.equal(findPersona(personas, 'moises').id, 'moises');

const roles = await loadRoles();
assert.ok(roles.size >= 18);
for (const r of roles.values()) {
  assert.ok(r.name && r.persona && r.body, `role ${r.id} incomplete`);
  for (const t of r.tools) { assert.ok(TOOLS.has(t), `role ${r.id}: unknown tool /${t}`); assert.ok(!TOOLS.get(t).client, `role ${r.id}: /${t} is browser-only`); }
}
const agencyIds = (await listAgencyIds()).map((a) => a.id);
assert.ok(agencyIds.length >= 10 && !agencyIds.includes('base'));
for (const id of agencyIds) {
  const a = await resolveAgency(id, { personas });
  assert.ok(a.seats.length >= 3 && a.seats[0].id === 'strategist', `${id}: base strategist missing`);
  assert.match(a.playbook, /goal first/, `${id}: base playbook missing`);
  for (const seat of a.seats) {
    assert.ok(seat.persona, `${id}/${seat.id}: persona "${seat.personaRef}" not found`);
    for (const t of ['search', 'brand', 'crm', 'report']) assert.ok(seat.tools.includes(t), `${id}/${seat.id} missing base tool /${t}`);
  }
}
const mk = await resolveAgency('marketing', { personas });
assert.deepEqual(mk.seats.map((s) => s.id).slice(0, 4), ['strategist', 'copywriter', 'guerrilla', 'designer']);
assert.equal(mk.seats.find((s) => s.id === 'guerrilla').persona.name, 'Moises — Guerrilla Marketing');
assert.ok(mk.seats.find((s) => s.id === 'media-buyer'));
// tools belong to roles: no persona file mentions a tool list
for (const p of await loadFilePersonas()) assert.ok(!/\btools:/.test(p.systemPrompt), `persona ${p.id} carries tools`);
await assert.rejects(resolveAgency('nope', { personas }), /No agency/);

// running a seat: tool call → result fed back → final answer; sensitive + out-of-toolset tools refused
await run('/crm add Zed | zed@x.com | Zco');
const seen = [];
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('openrouter.ai')) return realFetch(url, opts);
  const msgs = JSON.parse(opts.body).messages;
  seen.push(msgs);
  const last = msgs.at(-1).content;
  const reply = msgs.length === 2 ? '<<tool>>/crm list<</tool>>\n<<tool>>/email a@b.c | s | b<</tool>>\n<<tool>>/ads meta | $100 | x | y<</tool>>'
    : 'FINAL: ' + (/Zed/.test(last) ? 'saw Zed' : 'no data');
  return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
};
const { llm } = await import('../lib/hub.js');
const out = await runSeat({ agencyId: 'marketing', roleId: 'closer', request: 'who do we have?', registry, clientContext: '', llm: (a) => llm(a), model: 'm', personas });
assert.match(out, /Marcus/); assert.match(out, /FINAL: saw Zed/);
const toolMsg = seen.at(-1).at(-1).content;
assert.match(toolMsg, /not run: this acts for real/);      // /email never auto-runs
assert.match(toolMsg, /\/ads[^\n]*\n→ not in your toolset/); // closer has no /ads
assert.match(seen[0][0].content, /goal first/);              // system prompt carries the playbook
assert.match(seen[0][0].content, /Marcus/);                  // ...and the persona
assert.match(seen[0][0].content, /YOUR ROLE:/);
assert.match(out, /Used: \/crm list/);
const viaTool = await run('/ask marketing/closer | who do we have?').catch((e) => e);
assert.ok(typeof viaTool.text === 'string' || /OPENROUTER|persona/.test(String(viaTool.message)));

console.log('check-tools: ok');
