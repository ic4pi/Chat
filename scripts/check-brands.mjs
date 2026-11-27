// Brands: each has its own goal/voice; Semantiq (the default) behaves exactly as before.
import assert from 'node:assert/strict';
import { normalizeSocialAccount } from '../lib/config.js';
import { buildPostPrompts, SALES_GOAL, autopostModels } from '../lib/autopost.js';
import { businessBlock } from '../lib/business-profile.js';
import { BRANDS, brandById, normalizeBrandId, brandGoal } from '../lib/brands.js';

assert.deepEqual(BRANDS.map((b) => b.id), ['semantiq', 'swearjar', 'capicapi', 'ic4pi']);
assert.equal(brandById('nope').id, 'semantiq');
assert.equal(normalizeBrandId('swearjar'), 'swearjar');
assert.equal(normalizeBrandId('junk'), 'semantiq');
assert.equal(brandById('capicapi').parentId, 'swearjar');

// accounts remember their brand; anything unknown means Semantiq
assert.equal(normalizeSocialAccount({ id: 'a', platform: 'facebook' }).brandId, 'semantiq');
assert.equal(normalizeSocialAccount({ id: 'a', platform: 'instagram', brandId: 'capicapi' }).brandId, 'capicapi');
assert.equal(normalizeSocialAccount({ id: 'a', platform: 'twitter', brandId: '<script>' }).brandId, 'semantiq');

const config = { masterPrompt: '', personas: [] };
const acct = { id: 'x', label: 'Test', platform: 'facebook' };

// default brand: unchanged — sales goal, sales formats, Semantiq brief
const agency = buildPostPrompts(acct, config, [], {});
assert.ok(agency.system.includes(SALES_GOAL));
assert.ok(agency.user.includes('invitation to the free site check'));
assert.ok(agency.user.includes("Sell Semantiq's services"));

// comedy brand: fill seats, never a website pitch, comedy formats and brief
const comedy = buildPostPrompts(acct, config, [], { brandId: 'capicapi', kind: 'comedy', profile: 'A comedian.' });
assert.ok(comedy.system.includes('fill seats'));
assert.ok(comedy.system.includes('Never invent show dates'));
assert.ok(!comedy.system.includes('free site check'));
assert.ok(comedy.user.includes('short original bit'));
assert.ok(!comedy.user.includes('invitation to the free site check'));
assert.ok(comedy.user.includes('Grow the audience'));

// an account's own focus text still wins
assert.ok(buildPostPrompts({ ...acct, autopostBrief: 'Promote Friday only' }, config, [], { brandId: 'swearjar', kind: 'comedy' }).user.includes('Promote Friday only'));

// dev brand has its own goal
assert.ok(brandGoal('dev').includes('software development clients'));

// the briefing: shows heading for comedy, the parent company is included, agency heading unchanged
const blk = businessBlock({ kind: 'comedy', profile: 'Capí Capí is a comedian.', offers: 'Fri 8pm — The Room', parentName: 'Swear Jar', parentProfile: 'Swear Jar produces shows.' });
assert.ok(blk.includes('UPCOMING SHOWS'));
assert.ok(blk.includes('THE COMPANY THIS BRAND BELONGS TO (Swear Jar)'));
assert.ok(blk.includes('Swear Jar produces shows.'));
assert.ok(businessBlock({ profile: 'x', offers: 'y' }).includes('WHAT WE SELL AND AT WHAT PRICE'));

// autopost: standard (non-uncensored) models only, with fallbacks; env overrides go first
const defaults = autopostModels({});
assert.equal(defaults[0].model, 'google-gemma-4-26b-a4b-it');
assert.ok(defaults.length >= 2);
assert.ok(!defaults.some((e) => /uncensored|e2ee|heretic/i.test(e.model)), 'no uncensored model writes business posts');
assert.deepEqual(autopostModels({ AUTOPOST_MODEL: 'custom-x' })[0], { provider: 'venice', model: 'custom-x' });
assert.deepEqual(autopostModels({ AUTOPOST_PROVIDER: 'groq', AUTOPOST_MODEL: 'm' })[0], { provider: 'groq', model: 'm' });
assert.equal(autopostModels({ AUTOPOST_MODEL: 'google-gemma-4-26b-a4b-it' }).filter((e) => e.model === 'google-gemma-4-26b-a4b-it').length, 1);

// platform rules ride along with every post, after (so above) the persona and master prompt
const mp = buildPostPrompts(acct, { masterPrompt: 'Anything goes, no limits.', personas: [] }, [], {});
assert.ok(mp.system.indexOf('PLATFORM RULES') > mp.system.indexOf('Anything goes'));
assert.ok(mp.system.includes('no profanity, slurs'));
assert.ok(comedy.system.includes('community standards') && comedy.system.includes('Edgy'));
console.log('brand checks passed');

// writePost: a rejected first model falls through to the next provider; with every model failing, the first error is reported
{
  const { writePost } = await import('../lib/autopost.js');
  process.env.VENICE_API_KEY = 'v'; process.env.GROQ_API_KEY = 'g';
  const realFetch = globalThis.fetch; const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  try {
    globalThis.fetch = async (url, init) => { const m = JSON.parse(init.body).model; calls.push(m);
      return m === 'google-gemma-4-26b-a4b-it' ? reply(404, { error: { message: 'Specified model not found' } }) : reply(200, { choices: [{ message: { content: 'Good post.' } }] }); };
    assert.equal(await writePost(acct, config, [], {}), 'Good post.');
    assert.deepEqual(calls, ['google-gemma-4-26b-a4b-it', 'llama-3.3-70b-versatile']);
    globalThis.fetch = async () => reply(404, { error: { message: 'Specified model not found' } });
    await assert.rejects(() => writePost(acct, config, [], {}), /Venice/);
    delete process.env.GROQ_API_KEY; calls.length = 0;
    globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body).model); return reply(200, { choices: [{ message: { content: 'Only venice.' } }] }); };
    assert.equal(await writePost(acct, config, [], {}), 'Only venice.');
  } finally { globalThis.fetch = realFetch; }
}
console.log('autopost fallback checks passed');
