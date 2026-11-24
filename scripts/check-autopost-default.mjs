// A feed account nobody has set a schedule for posts daily at the recommended pace; "off" sticks only when chosen.
import assert from 'node:assert/strict';
import { normalizeSocialAccount as n } from '../lib/config.js';

const fb = n({ id: 'a', platform: 'facebook' });
assert.equal(fb.autopostEvery, 'daily'); assert.equal(fb.autopostPerDay, 1);
assert.equal(n({ id: 'b', platform: 'twitter' }).autopostPerDay, 3);
assert.equal(n({ id: 'c', platform: 'instagram', autopostEvery: 'off' }).autopostEvery, 'daily');          // old default "off", never chosen
assert.equal(n({ id: 'd', platform: 'facebook', autopostEvery: 'off', autopostChosen: true }).autopostEvery, 'off');
assert.equal(n({ id: 'e', platform: 'facebook', autopostEvery: 'weekly' }).autopostEvery, 'weekly');
assert.equal(n({ id: 'f', platform: 'twitter', autopostEvery: 'daily', autopostPerDay: 2 }).autopostPerDay, 2);
assert.equal(n({ id: 'g', platform: 'email' }).autopostEvery, 'off');
console.log('autopost default checks passed');
