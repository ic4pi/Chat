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
 *
 * OS note: Vercel Sandbox node24 is Amazon Linux 2023 — use `dnf`, not apt-get.
 */

import { Sandbox } from '@vercel/sandbox';

export const REPO_DIR = '/vercel/sandbox/repo';
export const PYTHON_MARKER = '/vercel/sandbox/.python-ready';
export const VENV_DIR = '/vercel/sandbox/venv';

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
 * Create a new sandbox session. Runtime is node24 (Amazon Linux 2023).
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

/** Shell snippet: put the sandbox venv first on PATH (python / pip resolve correctly). */
export function venvPathExport() {
  return `export PATH="${VENV_DIR}/bin:$PATH"; hash -r 2>/dev/null || true`;
}

/**
 * Ensure python3 + pip (+ a shared venv) exist in the sandbox.
 * Uses dnf (Amazon Linux), never apt-get. Idempotent via marker file.
 * Ready means the venv binaries exist and pip works — not just a marker touch.
 *
 * @returns {{ ok: boolean, already?: boolean, detail?: string, error?: string }}
 */
export async function ensurePythonStack(sandbox) {
  try {
    const probe = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        `test -f ${PYTHON_MARKER}`,
        `test -x ${VENV_DIR}/bin/python`,
        `test -x ${VENV_DIR}/bin/pip`,
        `${VENV_DIR}/bin/python -m pip --version >/dev/null 2>&1`,
      ].join(' && ')],
    });
    if ((probe.exitCode ?? 1) === 0) {
      return { ok: true, already: true, detail: `venv ready at ${VENV_DIR}` };
    }

    // Amazon Linux 2023: dnf (not apt-get). Creates a shared venv at VENV_DIR.
    // pipefail so dnf/yum failures are not hidden by `| tail`.
    const install = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        'set -euo pipefail',
        'if ! command -v python3 >/dev/null 2>&1 || ! python3 -m pip --version >/dev/null 2>&1; then',
        '  if command -v dnf >/dev/null 2>&1; then',
        '    dnf install -y python3 python3-pip python3-devel gcc',
        '  elif command -v yum >/dev/null 2>&1; then',
        '    yum install -y python3 python3-pip python3-devel gcc',
        '  else',
        '    echo "No dnf/yum package manager" >&2; exit 1',
        '  fi',
        'fi',
        'python3 -m pip install --upgrade pip setuptools wheel -q || true',
        `rm -rf ${VENV_DIR}`,
        `python3 -m venv ${VENV_DIR}`,
        `test -x ${VENV_DIR}/bin/python`,
        `test -x ${VENV_DIR}/bin/pip`,
        `${VENV_DIR}/bin/pip install --upgrade pip setuptools wheel -q`,
        `mkdir -p /vercel/sandbox && touch ${PYTHON_MARKER}`,
        `echo "PYTHON_OK $(${VENV_DIR}/bin/python --version) pip=$(${VENV_DIR}/bin/pip --version)"`,
        `echo "VENV ${VENV_DIR} ready"`,
      ].join('\n')],
      sudo: true,
    });

    const stdout = typeof install.stdout === 'function' ? await install.stdout() : '';
    const stderr = typeof install.stderr === 'function' ? await install.stderr() : '';
    if ((install.exitCode ?? 1) !== 0) {
      return {
        ok: false,
        error: (stderr || stdout || `python install failed (exit ${install.exitCode})`).slice(0, 800),
      };
    }

    // Verify before claiming success (marker alone is not enough)
    const verify = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `test -x ${VENV_DIR}/bin/python && ${VENV_DIR}/bin/python -m pip --version`],
    });
    if ((verify.exitCode ?? 1) !== 0) {
      const vErr = typeof verify.stderr === 'function' ? await verify.stderr() : '';
      return {
        ok: false,
        error: (vErr || stdout || 'venv created but python/pip still unavailable').slice(0, 800),
      };
    }

    return { ok: true, already: false, detail: String(stdout || '').trim().slice(0, 400) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Get an existing sandbox or throw. Adds a 1-min timeout extension so an
 * active session doesn't expire mid-use.
 */
export async function requireSession(req) {
  const sandbox = await getExistingSession(req);
  if (!sandbox) {
    throw new Error('No active sandbox session. Open a GitHub repo first (left panel → Open).');
  }
  // Extend lifetime so the sandbox doesn't expire while the user is working.
  try { await sandbox.extendTimeout(60_000); } catch { /* best effort */ }
  return sandbox;
}
