#!/usr/bin/env node
/**
 * Campaign engine checks — no network, no keys. A scripted fake model plays
 * brief-reader, strategist, editor and adapters; the last section drives the
 * real /api/campaign handler with fetch stubbed to a fake provider.
 *
 * Run: npm run check:campaign
 */

import assert from 'node:assert/strict';
import {
  runCampaign, unsupportedFigures, findFluff, platformsFromText, finalScore, HallucinationError,
} from '../lib/campaign-engine.js';

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`check-campaign: ok — ${name}`);
  } catch (err) {
    failed++;
    console.error(`check-campaign: FAIL — ${name}\n  ${err.stack || err.message}`);
  }
}

const CONVO = [
  { role: 'user', content: 'I sell LedgerLite, a bookkeeping app for solo contractors. Users close their month in 20 minutes. 14-day free trial.' },
  { role: 'assistant', content: 'Nice. Who is it for exactly?' },
  { role: 'user', content: 'write a campaign for it, twitter and email' },
];
const BRIEF = { product: 'LedgerLite bookkeeping app', audience: 'solo contractors', audience_assumed: false, offer: '14-day free trial', facts: ['Users close their month in 20 minutes'], tone: 'blunt', question: '' };
const STRATEGY = {
  positioning: 'Bookkeeping for people who would rather be working.', pain_point: 'Month-end eats a weekend.',
  core_message: 'Close your month in 20 minutes.', hook_ids_used: [], angles: ['time back'],
  master_copy: 'Your books take a weekend. They should take 20 minutes. LedgerLite sorts it; you click approve.',
  cta: 'Start the 14-day free trial.',
};
const verdict = (s, extra = {}) => ({ ruthlessness_score: s, directness: s, fluff_free: s, fluff_found: [], unsupported_claims: [], fixes: ['Cut the second sentence.'], ...extra });

/** Fake model: per-role queues; adapters answer per platform. Records every call. */
function fakeModel({ brief = [BRIEF], strategist = [STRATEGY], editor = [verdict(9)], adapt = {}, delayMs = 0 } = {}) {
  const calls = [];
  const q = { brief: [...brief], strategist: [...strategist], editor: [...editor] };
  const take = (role) => (q[role].length > 1 ? q[role].shift() : q[role][0]);
  const complete = async (messages) => {
    const sys = messages[0].content;
    const role = sys.startsWith('You turn a conversation') ? 'brief'
      : sys.startsWith('You are the strategist') ? 'strategist'
        : sys.startsWith('You are the editor') ? 'editor' : 'adapter';
    calls.push({ role, messages });
    if (role !== 'adapter') {
      const item = take(role);
      return typeof item === 'string' ? item : JSON.stringify(item);
    }
    await new Promise((r) => setTimeout(r, delayMs));
    const label = messages[1].content.match(/PLATFORM: (\w+)/)[1];
    const custom = adapt[label];
    const item = custom ? (custom.length > 1 ? custom.shift() : custom[0])
      : { text: `${label}: Your books, 20 minutes. Start the 14-day free trial.`, hashtags: [] };
    return JSON.stringify(item);
  };
  return { complete, calls, of: (role) => calls.filter((c) => c.role === role) };
}

// ── grounding helpers ──

await check('invented figures flagged, the user\'s own allowed', () => {
  const facts = ['Users close their month in 20 minutes', '4.8 stars from 2,000 reviews'];
  assert.deepEqual(unsupportedFigures('Close in 20 minutes. 4.8 stars, 2000 reviews.', facts), []);
  assert.deepEqual(unsupportedFigures('Save 300% and $5,000 a year', facts), ['$5,000', '300%']);
  assert.deepEqual(unsupportedFigures('3 steps, launched in 2026', facts), []);
});

await check('fluff detection', () => {
  assert.deepEqual(findFluff('Unlock a seamless, game-changer journey'), ['game-changer', 'journey', 'seamless', 'unlock']);
  assert.deepEqual(findFluff('Your books take a weekend.'), []);
});

await check('platforms from plain words', () => {
  assert.deepEqual(platformsFromText('write a campaign for twitter, IG and email'), ['x', 'instagram', 'email']);
  assert.deepEqual(platformsFromText('make me a campaign'), []);
  assert.deepEqual(platformsFromText('a linkedin post and a tiktok'), ['linkedin', 'tiktok']);
});

await check('lenient editor held to sub-scores and fluff', () => {
  const v = { ruthlessness: 10, directness: 6, fluffFree: 6, fluffFound: [], unsupportedClaims: [], fixes: [] };
  assert.equal(finalScore(v, { coreMessage: '', masterCopy: 'plain', cta: '' }).score, 6);
  const v2 = { ...v, directness: 9, fluffFree: 9, ruthlessness: 9 };
  assert.equal(finalScore(v2, { coreMessage: '', masterCopy: 'Unlock seamless books', cta: '' }).score, 7);
});

// ── pipeline ──

await check('approved campaign: brief from earlier turns, platforms adapted', async () => {
  const m = fakeModel();
  const r = await runCampaign({ complete: m.complete, conversation: CONVO, platforms: ['x', 'email'] });
  assert.equal(r.status, 'approved');
  assert.equal(r.best.score, 9);
  assert.deepEqual(r.adaptations.map((a) => a.platform), ['x', 'email']);
  assert.match(m.of('brief')[0].messages[1].content, /LedgerLite, a bookkeeping app/); // earlier turn included
  const edited = m.of('editor')[0].messages[1].content;
  assert.match(edited, /COPY:\nHeadline: Close your month in 20 minutes\./);
  assert.doesNotMatch(edited, /time back|positioning/); // working notes never reach the editor
});

await check('editor sends a weak draft back with its fixes', async () => {
  const m = fakeModel({ editor: [verdict(6, { fixes: ['Lead with the weekend.'] }), verdict(9)] });
  const r = await runCampaign({ complete: m.complete, conversation: CONVO });
  assert.equal(r.best.attempts, 2);
  const revision = m.of('strategist')[1].messages[1].content;
  assert.match(revision, /YOUR LAST DRAFT scored 6\/10, needs 8/);
  assert.match(revision, /Lead with the weekend\./);
});

await check('nothing passes → rejected with the best draft, no platform calls', async () => {
  const m = fakeModel({ editor: [verdict(5), verdict(7), verdict(6), verdict(6)] });
  const r = await runCampaign({ complete: m.complete, conversation: CONVO, maxRevisions: 3 });
  assert.equal(r.status, 'rejected');
  assert.equal(r.best.score, 7);
  assert.equal(m.of('adapter').length, 0);
});

await check('fluffy copy cannot pass a 9/10 editor', async () => {
  const fluffy = { ...STRATEGY, master_copy: 'Unlock seamless bookkeeping. Close your month in 20 minutes and get weekends back.' };
  const m = fakeModel({ strategist: [fluffy, STRATEGY], editor: [verdict(9), verdict(9)] });
  const r = await runCampaign({ complete: m.complete, conversation: CONVO });
  assert.equal(r.best.attempts, 2);
  assert.match(m.of('strategist')[1].messages[1].content, /Cut these phrases entirely: seamless, unlock/);
});

await check('editor-flagged unbacked claim blocks approval', async () => {
  const m = fakeModel({ editor: [verdict(9, { unsupported_claims: ['trusted by accountants'] }), verdict(9)] });
  assert.equal((await runCampaign({ complete: m.complete, conversation: CONVO })).best.attempts, 2);
});

await check('invented statistic rejected before the editor sees it', async () => {
  const lying = { ...STRATEGY, master_copy: 'Contractors save 300% more time and $5,000 a year. Close your month in 20 minutes.' };
  const m = fakeModel({ strategist: [lying, STRATEGY] });
  const r = await runCampaign({ complete: m.complete, conversation: CONVO });
  assert.equal(r.best.strategy.masterCopy, STRATEGY.master_copy);
  const repair = m.of('strategist')[1].messages.at(-1).content;
  assert.match(repair, /\$5,000/);
  assert.match(repair, /300%/);
  assert.equal(m.of('editor').length, 1);
});

await check('brief reader cannot invent facts the user never said', async () => {
  const m = fakeModel({ brief: [{ ...BRIEF, facts: ['Saves 40 hours a month'] }, BRIEF] });
  await runCampaign({ complete: m.complete, conversation: CONVO });
  assert.match(m.of('brief')[1].messages.at(-1).content, /figures the user never stated: 40/);
});

await check('unclear product → one question back, no drafting', async () => {
  const m = fakeModel({ brief: [{ product: '', question: 'What are you selling, and to whom?' }] });
  const r = await runCampaign({ complete: m.complete, conversation: [{ role: 'user', content: 'write a campaign' }] });
  assert.deepEqual(r, { status: 'question', question: 'What are you selling, and to whom?' });
  assert.equal(m.of('strategist').length, 0);
});

await check('malformed JSON repaired with the reason', async () => {
  const m = fakeModel({ editor: ['Sure! I would rate this a 9.', verdict(9)] });
  const r = await runCampaign({ complete: m.complete, conversation: CONVO });
  assert.equal(r.status, 'approved');
  assert.match(m.of('editor')[1].messages.at(-1).content, /^Rejected: no JSON object/);
});

await check('persistent garbage → HallucinationError, not a fake result', async () => {
  const m = fakeModel({ editor: ['no json here'] });
  await assert.rejects(runCampaign({ complete: m.complete, conversation: CONVO }), HallucinationError);
});

await check('hooks from memory reach the strategist; invented hook ids rejected', async () => {
  const hooks = [{ id: 'uuid-1', text: 'Stop losing weekends to bookkeeping', platform: 'any', performance: 4.2 }];
  const m = fakeModel({ strategist: [{ ...STRATEGY, hook_ids_used: ['h9'] }, { ...STRATEGY, hook_ids_used: ['h1'] }] });
  const r = await runCampaign({ complete: m.complete, conversation: CONVO, retrieveHooks: async () => hooks });
  assert.match(m.of('strategist')[0].messages[1].content, /h1 \| 4\.2 \| Stop losing weekends/);
  assert.match(m.of('strategist')[1].messages.at(-1).content, /not provided: h9/);
  assert.deepEqual(r.hooksUsed.map((h) => h.id), ['uuid-1']);
});

await check('memory outage degrades instead of failing', async () => {
  const events = [];
  const m = fakeModel();
  const r = await runCampaign({
    complete: m.complete, conversation: CONVO, onEvent: (e) => events.push(e.message),
    retrieveHooks: async () => { throw new Error('embed 401'); },
  });
  assert.equal(r.status, 'approved');
  assert.ok(events.some((e) => /Hook memory unavailable \(embed 401\)/.test(e)));
});

await check('platforms run concurrently; one failing never blocks the rest', async () => {
  const m = fakeModel({ delayMs: 300, adapt: { X: [{ text: 'x'.repeat(400), hashtags: [] }] } });
  const t = Date.now();
  const r = await runCampaign({ complete: m.complete, conversation: CONVO, platforms: ['x', 'linkedin', 'email', 'instagram'] });
  const elapsed = Date.now() - t;
  assert.deepEqual(r.adaptations.map((a) => a.platform), ['linkedin', 'email', 'instagram']); // the order you asked for
  assert.equal(r.failures[0].platform, 'x');
  assert.match(r.failures[0].error, /limit is 280/);
  assert.ok(elapsed < 1400, `took ${elapsed}ms — platforms ran one after another`);
});

// ── the real handler against a fake provider ──

await check('handler: retries a 429 as told, streams progress, finishes', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY; // no hub: engine runs without hook memory
  process.env.OPENROUTER_API_KEY = 'test';
  const { default: handler } = await import('../api/campaign.js');
  const m = fakeModel();
  let first = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (first) {
      first = false;
      return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } });
    }
    const body = JSON.parse(opts.body);
    const content = await m.complete(body.messages);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
  };
  try {
    const out = await invoke(handler, { messages: CONVO, provider: 'openrouter', model: 'openrouter/free' });
    const events = parseSSE(out.body);
    assert.ok(events.some((e) => /rate limit — waiting 0s/.test(e.message || '')), 'no rate-limit notice');
    const done = events.find((e) => e.type === 'done');
    assert.equal(done?.result?.status, 'approved');
    assert.deepEqual(done.result.adaptations.map((a) => a.platform), ['x', 'email']); // "twitter and email"
    assert.equal(done.hookMemory, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('handler: bad key fails at once with the provider\'s reason', async () => {
  const { default: handler } = await import('../api/campaign.js');
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return new Response('{"error":{"message":"invalid api key"}}', { status: 401 }); };
  try {
    const out = await invoke(handler, { messages: CONVO, provider: 'openrouter', model: 'openrouter/free' });
    const err = parseSSE(out.body).find((e) => e.type === 'error');
    assert.match(err?.error || '', /invalid api key/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

function invoke(handler, body) {
  return new Promise((resolve) => {
    let buf = '';
    const listeners = {};
    const res = {
      statusCode: 200, headers: {}, writableEnded: false, destroyed: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      flushHeaders() {},
      status(c) { this.statusCode = c; return this; },
      json(d) { buf = JSON.stringify(d); this.writableEnded = true; resolve({ status: this.statusCode, body: buf }); return this; },
      write(chunk) { buf += chunk; return true; },
      end() { this.writableEnded = true; resolve({ status: this.statusCode, body: buf }); },
      on(ev, fn) { listeners[ev] = fn; }, off() {},
    };
    handler({ method: 'POST', headers: {}, query: {}, body, socket: {} }, res);
  });
}

function parseSSE(text) {
  return text.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('data:'))
    .map((b) => JSON.parse(b.slice(5)));
}

if (failed) {
  console.error(`check-campaign: ${failed} failed`);
  process.exit(1);
}
console.log('check-campaign: all checks passed');
