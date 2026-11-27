/**
 * Who is asking, and which personas they may use.
 *
 *  - The OWNER (an account flagged is_owner, or a call carrying the admin secret, which is how the app's own
 *    scheduled jobs call /api/group-chat) sees every persona, brand and posting account.
 *  - Everyone else (signed in or not) sees only the built-in personas: NEXUS, the neutral assistant and Juno.
 *  - With no database configured at all (no accounts possible) the app keeps its old open behaviour.
 *
 * The server enforces this on every chat call, not just in the list the browser is shown, so a persona id typed by
 * hand does not open the owner's personas either.
 */
import { timingSafeEqual } from 'node:crypto';
import { accountsApi } from './hub.js';
import { readSessionToken } from './accounts.js';

export const BUILTIN_PERSONA_IDS = ['nexus', 'plain', 'juno'];

function adminSecrets() {
  const pass = String(process.env.ADMIN_PASSWORD || '').trim();
  const user = String(process.env.ADMIN_USERNAME || '').trim();
  if (!pass) return [];
  return user ? [pass, `${user}:${pass}`] : [pass];
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
/** True when `submitted` is the admin password (or username:password). */
export function isAdminSecret(submitted) {
  const raw = String(submitted || '').trim();
  return !!raw && adminSecrets().some((s) => safeEq(raw, s));
}

/** Builds requestContext around an accounts API (the tests pass one on a fake database). */
export function makeRequestContext(accounts) {
  /** { account, isOwner, signedIn } for a request. Never throws: a database hiccup means "anonymous". */
  return async function requestContext(req) {
    if (isAdminSecret(req.headers?.['x-paid-password'])) return { account: null, isOwner: true, signedIn: false, trusted: true };
    if (!accounts) return { account: null, isOwner: true, signedIn: false, open: true };
    const account = await accounts.accountFromToken(readSessionToken(req)).catch(() => null);
    return { account, isOwner: !!account?.isOwner, signedIn: !!account };
  };
}
export const requestContext = makeRequestContext(accountsApi);

/** The personas this caller may use. */
export function visiblePersonas(config, ctx) {
  const all = config?.personas || [];
  if (ctx?.isOwner) return all;
  return all.filter((p) => BUILTIN_PERSONA_IDS.includes(p.id));
}
