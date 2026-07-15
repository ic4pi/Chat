/**
 * Sandbox session helpers.
 *
 * Each "session" is a named Vercel Sandbox microVM that persists across HTTP
 * requests. The client stores the sandbox name (returned by /api/init-repo)
 * and sends it as the X-Sandbox-Session request header on every subsequent
 * call. Server-side routes call getSession(req) to get (or lazily create) the
 * sandbox for this session.
 *
 * Repos are cloned to REPO_DIR inside the sandbox.
 */

import { Sandbox } from '@vercel/sandbox';

export const REPO_DIR = '/vercel/sandbox/repo';

function getSandboxAuth() {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  if (VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID) {
    return { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID };
  }
  if (process.env.VERCEL_OIDC_TOKEN) return {};
  throw new Error('No Vercel credentials. Set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.');
}

/**
 * Get an existing sandbox by name from the X-Sandbox-Session header.
 * Returns null if no header is present.
 */
export async function getExistingSession(req) {
  const name = req.headers['x-sandbox-session'];
  if (!name || typeof name !== 'string') return null;
  try {
    const auth = getSandboxAuth();
    const sandbox = await Sandbox.get({ name, ...auth });
    return sandbox;
  } catch {
    return null;
  }
}

/**
 * Create a new sandbox session. Runtime is node24 (has git, python3, node).
 * Returns the sandbox instance. Caller is responsible for setting
 * X-Sandbox-Session: sandbox.name in the response.
 */
export async function createSession() {
  const auth = getSandboxAuth();
  return Sandbox.create({
    ...auth,
    runtime: 'node24',
    timeout: 30 * 60 * 1000, // 30 minutes default; extend on activity
  });
}

/**
 * Get an existing sandbox or throw. Adds a 1-min timeout extension so an
 * active session doesn't expire mid-use.
 */
export async function requireSession(req) {
  const sandbox = await getExistingSession(req);
  if (!sandbox) throw new Error('No active sandbox session. Open a repo first.');
  // Extend lifetime so the sandbox doesn't expire while the user is working.
  try { await sandbox.extendTimeout(60_000); } catch { /* best effort */ }
  return sandbox;
}
