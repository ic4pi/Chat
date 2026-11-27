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

// autopost never depends on one Venice model: a retired one falls through to the next
assert.equal(autopostModels('venice', {})[0], 'venice-uncensored-1-2');
assert.ok(!autopostModels('venice', {}).some((m) => m.startsWith('e2ee-')));
assert.deepEqual(autopostModels('venice', { AUTOPOST_MODEL: 'custom-x' }).slice(0, 2), ['custom-x', 'venice-uncensored-1-2']);
assert.equal(new Set(autopostModels('venice', { AUTOPOST_MODEL: 'venice-uncensored-1-2' })).size, autopostModels('venice', { AUTOPOST_MODEL: 'venice-uncensored-1-2' }).length);
assert.equal(autopostModels('groq', {}).length, 1);
console.log('brand checks passed');
