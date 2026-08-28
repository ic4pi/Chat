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
export const RUST_MARKER = '/vercel/sandbox/.rust-ready';
export const GO_MARKER = '/vercel/sandbox/.go-ready';
/** Optional rustup install prefix (fallback when dnf rust/cargo is unavailable). */
export const CARGO_HOME = '/vercel/sandbox/cargo';
export const RUSTUP_HOME = '/vercel/sandbox/rustup';

function getSandboxAuth() {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  if (VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID) {
    return { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID };
  }
  if (process.env.VERCEL_OIDC_TOKEN) return {};
  throw new Error(
    'Workspace sandbox is not configured. In Vercel → Project → Settings → Environment Variables, set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID (Sandbox API access), then redeploy. Without these, Start blank / Open repo cannot create a coding VM.',
  );
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
    // Base lifetime before any activity extends it. 45 min gives real
    // headroom for someone stepping away from the tab — extended further by
    // requireSession() on every request, and kept alive purely by an open
    // (even backgrounded) tab via the client's keepalive ping
    // (/api/keepalive, App.tsx). Vercel enforces its own plan-level ceiling
    // server-side regardless of what's requested here.
    timeout: 45 * 60 * 1000,
  });
}

/** Shell snippet: put the sandbox venv first on PATH (python / pip resolve correctly). */
export function venvPathExport() {
  return `export PATH="${VENV_DIR}/bin:$PATH"; hash -r 2>/dev/null || true`;
}

/** Shell snippet: prefer rustup/cargo install dir, then system PATH. */
export function rustPathExport() {
  return [
    `export CARGO_HOME="${CARGO_HOME}"`,
    `export RUSTUP_HOME="${RUSTUP_HOME}"`,
    `export PATH="${CARGO_HOME}/bin:$PATH"`,
    'hash -r 2>/dev/null || true',
  ].join('; ');
}

/** Shell snippet: ensure `go` resolves (system golang from dnf). */
export function goPathExport() {
  return 'hash -r 2>/dev/null || true';
}

/**
 * Combined PATH exports for shell commands (venv + rust/cargo).
 * Always safe to prepend — missing dirs are ignored by the shell.
 */
export function toolchainPathExport() {
  return `${venvPathExport()}; ${rustPathExport()}; ${goPathExport()}`;
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
 * Cheap probe — does not install. Used by init when we skip eager install.
 * @returns {Promise<boolean>}
 */
export async function probeRustStack(sandbox) {
  try {
    const probe = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `${rustPathExport()}; command -v rustc >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1`],
    });
    return (probe.exitCode ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<boolean>}
 */
export async function probeGoStack(sandbox) {
  try {
    const probe = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', 'command -v go >/dev/null 2>&1 && go version >/dev/null 2>&1'],
    });
    return (probe.exitCode ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure rustc + cargo exist in the sandbox.
 * Prefer Amazon Linux dnf packages; fall back to rustup into CARGO_HOME.
 * Idempotent via marker + binary probes.
 *
 * @returns {{ ok: boolean, already?: boolean, detail?: string, error?: string }}
 */
export async function ensureRustStack(sandbox) {
  try {
    const probe = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        rustPathExport(),
        `test -f ${RUST_MARKER}`,
        'command -v rustc >/dev/null 2>&1',
        'command -v cargo >/dev/null 2>&1',
        'rustc --version >/dev/null 2>&1',
        'cargo --version >/dev/null 2>&1',
      ].join(' && ')],
    });
    if ((probe.exitCode ?? 1) === 0) {
      return { ok: true, already: true, detail: 'rustc + cargo ready' };
    }

    const install = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        'set -euo pipefail',
        rustPathExport(),
        // Linker needed for rustc whether via dnf or rustup.
        'if ! command -v cc >/dev/null 2>&1 && ! command -v gcc >/dev/null 2>&1; then',
        '  if command -v dnf >/dev/null 2>&1; then',
        '    dnf install -y gcc',
        '  elif command -v yum >/dev/null 2>&1; then',
        '    yum install -y gcc',
        '  fi',
        'fi',
        'if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then',
        '  if command -v dnf >/dev/null 2>&1; then',
        '    dnf install -y rust cargo || true',
        '  elif command -v yum >/dev/null 2>&1; then',
        '    yum install -y rust cargo || true',
        '  fi',
        'fi',
        // rustup fallback into sandbox-owned dirs (not $HOME) if dnf lacked packages.
        'if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then',
        `  export CARGO_HOME="${CARGO_HOME}"`,
        `  export RUSTUP_HOME="${RUSTUP_HOME}"`,
        '  mkdir -p "$CARGO_HOME" "$RUSTUP_HOME"',
        '  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal',
        `  export PATH="${CARGO_HOME}/bin:$PATH"`,
        'fi',
        'command -v rustc >/dev/null 2>&1',
        'command -v cargo >/dev/null 2>&1',
        // Ensure non-sudo shells can read/exec the toolchain dirs.
        `chmod -R a+rX ${CARGO_HOME} ${RUSTUP_HOME} 2>/dev/null || true`,
        `mkdir -p /vercel/sandbox && touch ${RUST_MARKER}`,
        'echo "RUST_OK $(rustc --version) | $(cargo --version)"',
      ].join('\n')],
      sudo: true,
    });

    const stdout = typeof install.stdout === 'function' ? await install.stdout() : '';
    const stderr = typeof install.stderr === 'function' ? await install.stderr() : '';
    if ((install.exitCode ?? 1) !== 0) {
      return {
        ok: false,
        error: (stderr || stdout || `rust install failed (exit ${install.exitCode})`).slice(0, 800),
      };
    }

    const verify = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `${rustPathExport()}; rustc --version && cargo --version`],
    });
    if ((verify.exitCode ?? 1) !== 0) {
      const vErr = typeof verify.stderr === 'function' ? await verify.stderr() : '';
      return {
        ok: false,
        error: (vErr || stdout || 'rust installed but rustc/cargo still unavailable').slice(0, 800),
      };
    }

    return { ok: true, already: false, detail: String(stdout || '').trim().slice(0, 400) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Ensure the Go toolchain (`go`) exists in the sandbox.
 * Uses dnf/yum on Amazon Linux. Idempotent via marker + binary probe.
 *
 * @returns {{ ok: boolean, already?: boolean, detail?: string, error?: string }}
 */
export async function ensureGoStack(sandbox) {
  try {
    const probe = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        `test -f ${GO_MARKER}`,
        'command -v go >/dev/null 2>&1',
        'go version >/dev/null 2>&1',
      ].join(' && ')],
    });
    if ((probe.exitCode ?? 1) === 0) {
      return { ok: true, already: true, detail: 'go toolchain ready' };
    }

    const install = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        'set -euo pipefail',
        'if ! command -v go >/dev/null 2>&1; then',
        '  if command -v dnf >/dev/null 2>&1; then',
        '    dnf install -y golang',
        '  elif command -v yum >/dev/null 2>&1; then',
        '    yum install -y golang',
        '  else',
        '    echo "No dnf/yum package manager" >&2; exit 1',
        '  fi',
        'fi',
        'command -v go >/dev/null 2>&1',
        'go version >/dev/null 2>&1',
        `mkdir -p /vercel/sandbox && touch ${GO_MARKER}`,
        'echo "GO_OK $(go version)"',
      ].join('\n')],
      sudo: true,
    });

    const stdout = typeof install.stdout === 'function' ? await install.stdout() : '';
    const stderr = typeof install.stderr === 'function' ? await install.stderr() : '';
    if ((install.exitCode ?? 1) !== 0) {
      return {
        ok: false,
        error: (stderr || stdout || `go install failed (exit ${install.exitCode})`).slice(0, 800),
      };
    }

    const verify = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', 'go version'],
    });
    if ((verify.exitCode ?? 1) !== 0) {
      const vErr = typeof verify.stderr === 'function' ? await verify.stderr() : '';
      return {
        ok: false,
        error: (vErr || stdout || 'golang installed but go still unavailable').slice(0, 800),
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
    throw new Error('No active sandbox session. Start a blank project or open a GitHub URL (left panel).');
  }
  // Extend lifetime so the sandbox doesn't expire while the user is working.
  try { await sandbox.extendTimeout(60_000); } catch { /* best effort */ }
  return sandbox;
}
