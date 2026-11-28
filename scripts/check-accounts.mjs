// Accounts: scrypt hashing, verification, email normalization.
import { hashPassword, verifyPassword, normalizeEmail } from '../lib/accounts.js';

let failed = 0;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };

// ── password hashing ─────────────────────────────────────────────────────
const hash = await hashPassword('correct horse battery staple');
ok('hash carries the scrypt parameters', hash.startsWith('scrypt$16384$8$1$'));
ok('a password verifies against its own hash', await verifyPassword('correct horse battery staple', hash));
ok('a wrong password is rejected', !(await verifyPassword('correct horse battery staple!', hash)));
ok('an empty password is rejected', !(await verifyPassword('', hash)));
ok('two hashes of one password differ (random salt)', (await hashPassword('same')) !== (await hashPassword('same')));
const mid = Math.floor(hash.length / 2);
const tampered = hash.slice(0, mid) + (hash[mid] === 'A' ? 'B' : 'A') + hash.slice(mid + 1);
ok('a tampered hash is rejected', !(await verifyPassword('correct horse battery staple', tampered)));
ok('garbage in place of a hash is rejected, not a crash', !(await verifyPassword('x', 'not-a-hash')));
ok('an empty stored hash is rejected', !(await verifyPassword('x', '')));

// ── email normalization ──────────────────────────────────────────────────
ok('emails are lowercased and trimmed', normalizeEmail('  Capi@Example.COM ') === 'capi@example.com');
ok('a plain address passes', normalizeEmail('a@b.co') === 'a@b.co');
ok('missing @ is rejected', normalizeEmail('nope.example.com') === null);
ok('missing domain dot is rejected', normalizeEmail('a@b') === null);
ok('empty is rejected', normalizeEmail('') === null && normalizeEmail(null) === null);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall account checks passed');
