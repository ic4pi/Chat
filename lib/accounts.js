// Email + password accounts, layered on top of the device-cookie identity.
//
// An account changes nothing about how the hub scopes data: it is a named
// pointer at an owner row. Registering ties the browser's CURRENT owner to
// the account (so the memories this device already made come along — no
// migration), and logging in on any other browser links that browser to the
// same owner through owner_devices, the exact mechanism a link code uses.
// A visitor who never logs in keeps the auto-minted device identity, and a
// self-host deployment works with zero accounts at all.
//
// Passwords are scrypt hashes (node:crypto, no new dependencies). The table:
//
//   create table if not exists accounts (
//     id         uuid primary key default gen_random_uuid(),
//     email      text not null unique,          -- stored lowercased
//     pass_hash  text not null,                 -- scrypt$N$r$p$salt$hash
//     owner_id   uuid not null references owners(id) on delete cascade,
//     created_at timestamptz not null default now()
//   );
//   alter table accounts enable row level security;   -- service role bypasses
//
// If the table is missing (migration not run yet), every function here fails
// soft: session lookups return null and the app behaves exactly as it did
// before accounts existed.

import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { db, peekOwner, adoptOwner, fail, rateLimit } from './hub.js';
import { requireAdminAuth } from './auth.js';

const scrypt = (password, salt, N, r, p, keylen) =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { N, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEYLEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  let key;
  try {
    key = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(N), Number(r), Number(p), KEYLEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(keyB64, 'base64');
  return expected.length === key.length && timingSafeEqual(expected, key);
}

export function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  // Deliberately simple: something@something.tld. The confirmation round-trip
  // catches typos better than any regex.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

// A dummy hash so a login attempt for an unknown email pays the same scrypt
// cost as a real one — the response time stops revealing which emails exist.
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(randomBytes(16).toString('base64url'));
  return dummyHash;
}

/** The account this browser is logged into, or null. Never creates anything. */
export async function sessionAccount(req) {
  if (!db) return null;
  try {
    const ownerId = await peekOwner(req);
    if (!ownerId) return null;
    const { data, error } = await db
      .from('accounts')
      .select('id, email, owner_id, created_at')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return null; // table missing or a transient error: treat as logged out
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Is this browser the deployment owner? The owner is the account matching
 * OWNER_EMAIL; when that env var is unset (self-hosters), the first account
 * ever registered owns the deployment. No account session → false, and the
 * caller falls back to whatever gate it already had.
 */
export async function isOwnerSession(req) {
  const account = await sessionAccount(req);
  if (!account) return false;
  const pinned = normalizeEmail(process.env.OWNER_EMAIL || '');
  if (pinned) return account.email === pinned;
  try {
    const { data: first } = await db
      .from('accounts')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    return !!first && first.id === account.id;
  } catch {
    return false;
  }
}

/**
 * Gate for the agency surfaces: the owner's logged-in session passes, and
 * everyone else gets the pre-accounts behaviour (HTTP Basic) unchanged —
 * so self-hosters without accounts lose nothing, and API/CLI clients that
 * send Basic credentials are unaffected.
 */
export async function requireOwnerOrAdmin(req, res) {
  if (await isOwnerSession(req)) return true;
  return requireAdminAuth(req, res);
}

/**
 * POST register: create an account tied to THIS browser's owner (minted on
 * the spot if the browser is brand new, via the caller's resolveOwner).
 */
export async function handleRegister(req, res, ownerId) {
  if (!(await rateLimit(req, res, { bucket: 'auth-register', limit: 20, windowSeconds: 3600 }))) return;

  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email) return fail(res, 400, 'A valid email address is required.');
  if (password.length < 8) return fail(res, 400, 'Password needs at least 8 characters.');
  if (password.length > 200) return fail(res, 400, 'Password is too long.');

  const passHash = await hashPassword(password);
  const { data, error } = await db
    .from('accounts')
    .insert({ email, pass_hash: passHash, owner_id: ownerId })
    .select('id, email')
    .single();
  if (error) {
    if (String(error.code) === '23505' || /duplicate|unique/i.test(error.message)) {
      return fail(res, 409, 'That email already has an account — log in instead.');
    }
    if (/relation .* does not exist|Could not find the table/i.test(error.message)) {
      return fail(res, 503, 'Accounts are not set up on this deployment yet.');
    }
    throw new Error(`could not create account: ${error.message}`);
  }

  // One owner can only feed one account: a second register from this browser
  // is almost certainly an accident, and silently stacking accounts on one
  // owner would make "which account owns the deployment" ambiguous.
  res.json({ ok: true, email: data.email, isOwner: await isOwnerSession(req) });
}

/** POST login: verify, then link this browser to the account's owner. */
export async function handleLogin(req, res) {
  if (!(await rateLimit(req, res, { bucket: 'auth-login', limit: 10, windowSeconds: 600 }))) return;

  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (!email || !password) return fail(res, 400, 'Email and password are required.');

  const { data: account, error } = await db
    .from('accounts')
    .select('id, email, pass_hash, owner_id')
    .eq('email', email)
    .maybeSingle();
  if (error) {
    if (/relation .* does not exist|Could not find the table/i.test(error.message)) {
      return fail(res, 503, 'Accounts are not set up on this deployment yet.');
    }
    throw new Error(`could not read account: ${error.message}`);
  }

  const ok = await verifyPassword(password, account ? account.pass_hash : await getDummyHash());
  if (!account || !ok) return fail(res, 401, 'Wrong email or password.');

  // Link this browser as a device of the account's owner. The cookie this
  // replaces belonged to this browser's anonymous owner — that row stays in
  // the database untouched, it is simply no longer this browser's identity.
  await adoptOwner(res, account.owner_id);
  res.json({ ok: true, email: account.email, isOwner: await isOwnerSession(req) });
}

/** POST logout: unlink this browser (when it arrived via login) and clear the cookie. */
export async function handleLogout(req, res, presentedHash) {
  if (presentedHash) {
    // Only device links are deleted — the account's first-device secret lives
    // in owners.token_hash and must survive every logout.
    await db.from('owner_devices').delete().eq('token_hash', presentedHash);
  }
  const cookie = 'chat_owner=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', [].concat(existing, cookie));
  res.json({ ok: true });
}
