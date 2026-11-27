/**
 * Accounts: email + password logins kept in the existing Supabase database.
 *
 * Passwords are stored only as scrypt hashes. A login creates a session: a random secret in an HttpOnly cookie,
 * stored hashed (like the device cookie in lib/hub.js), valid 30 days. Password resets use a one-time link
 * emailed through Resend. `makeAccounts({ db })` takes the database so the tests run on an in-memory fake.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const SESSION_COOKIE = 'jive_session';
export const SESSION_DAYS = 30;
export const RESET_MINUTES = 60;
export const MIN_PASSWORD = 10;
export const MAX_PASSWORD = 200;

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const normEmail = (e) => String(e || '').trim().toLowerCase();

const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const want = Buffer.from(keyB64, 'base64');
  let got;
  try { got = scryptSync(String(pw), Buffer.from(saltB64, 'base64'), want.length, { N: +N, r: +r, p: +p }); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}
// So an unknown email costs the same time as a wrong password.
const DUMMY_HASH = hashPassword('not-a-real-password');

export function checkCredentials({ email, password }) {
  if (!EMAIL_RE.test(normEmail(email))) return 'Enter a valid email address.';
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return 'That password is too long.';
  return null;
}

const publicAccount = (a) => (a ? { id: a.id, email: a.email, isOwner: !!a.is_owner, plan: a.plan || 'free', ownerId: a.owner_id || null } : null);

export function readSessionToken(req) {
  const header = String(req.headers?.cookie || '');
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
export function sessionCookie(token, maxAgeSec = SESSION_DAYS * 86400) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function makeAccounts({ db, now = () => Date.now() }) {
  const iso = (ms = now()) => new Date(ms).toISOString();

  async function byEmail(email) {
    const { data } = await db.from('accounts').select('*').eq('email_norm', normEmail(email)).maybeSingle();
    return data || null;
  }

  async function signup({ email, password }) {
    const bad = checkCredentials({ email, password });
    if (bad) throw Object.assign(new Error(bad), { status: 400 });
    if (await byEmail(email)) throw Object.assign(new Error('That email already has an account. Sign in instead.'), { status: 409 });
    const { data, error } = await db.from('accounts')
      .insert({ email: String(email).trim(), email_norm: normEmail(email), password_hash: hashPassword(password) })
      .select('*').single();
    if (error) {
      // two sign-ups racing on the same email: the unique index decides
      throw Object.assign(new Error(/duplicate|unique/i.test(error.message) ? 'That email already has an account. Sign in instead.' : 'Could not create the account.'), { status: 409 });
    }
    return publicAccount(data);
  }

  /** The account, or null for a wrong email or password (never says which). */
  async function login({ email, password }) {
    const acct = await byEmail(email);
    const ok = verifyPassword(password, acct ? acct.password_hash : DUMMY_HASH);
    if (!acct || !ok) return null;
    await db.from('accounts').update({ last_login_at: iso() }).eq('id', acct.id);
    return publicAccount(acct);
  }

  async function createSession(accountId) {
    const token = randomBytes(32).toString('base64url');
    const { error } = await db.from('account_sessions')
      .insert({ token_hash: sha(token), account_id: accountId, expires_at: iso(now() + SESSION_DAYS * 86400_000) });
    if (error) throw new Error('Could not start a session.');
    return token;
  }

  /** The signed-in account for a session secret, or null (unknown, expired). */
  async function accountFromToken(token) {
    if (!token) return null;
    const { data: s } = await db.from('account_sessions').select('*').eq('token_hash', sha(token)).maybeSingle();
    if (!s || Date.parse(s.expires_at) <= now()) return null;
    const { data: a } = await db.from('accounts').select('*').eq('id', s.account_id).maybeSingle();
    return publicAccount(a);
  }

  async function endSession(token) {
    if (token) await db.from('account_sessions').delete().eq('token_hash', sha(token));
  }

  async function setOwnerLink(accountId, ownerId) {
    await db.from('accounts').update({ owner_id: ownerId }).eq('id', accountId);
  }
  async function markOwner(accountId) {
    await db.from('accounts').update({ is_owner: true }).eq('id', accountId);
  }
  async function ownerIdTaken(ownerId) {
    const { data } = await db.from('accounts').select('id').eq('owner_id', ownerId).maybeSingle();
    return !!data;
  }

  /** Starts a reset: { account, token } for the caller to email, or null when there is no such account (the caller still says "sent"). */
  async function startReset(email) {
    const acct = await byEmail(email);
    if (!acct) return null;
    const token = randomBytes(32).toString('base64url');
    await db.from('account_tokens').insert({ token_hash: sha(token), account_id: acct.id, kind: 'reset', expires_at: iso(now() + RESET_MINUTES * 60_000) });
    return { account: publicAccount(acct), token };
  }

  /** Sets a new password from a reset link and signs the account out everywhere. */
  async function finishReset(token, password) {
    const bad = checkCredentials({ email: 'x@x.xx', password });
    if (bad) throw Object.assign(new Error(bad), { status: 400 });
    const { data: t } = await db.from('account_tokens').select('*').eq('token_hash', sha(String(token || ''))).maybeSingle();
    if (!t || t.used_at || Date.parse(t.expires_at) <= now()) throw Object.assign(new Error('That reset link has expired. Ask for a new one.'), { status: 400 });
    await db.from('accounts').update({ password_hash: hashPassword(password) }).eq('id', t.account_id);
    await db.from('account_tokens').update({ used_at: iso() }).eq('token_hash', t.token_hash);
    await db.from('account_sessions').delete().eq('account_id', t.account_id);
    return true;
  }

  return { signup, login, createSession, accountFromToken, endSession, setOwnerLink, markOwner, ownerIdTaken, startReset, finishReset };
}
