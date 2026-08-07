/**
 * POST /api/init-blank
 * Body: { sandboxId?: string, name?: string }
 *
 * Starts a Workspace project with no GitHub clone — empty folder + git init.
 * Returns the same shape as /api/init-repo so the client can treat them alike.
 */

import { Sandbox } from '@vercel/sandbox';
import {
  REPO_DIR,
  createSession,
  probeRustStack,
  probeGoStack,
  VENV_DIR,
} from '../sandbox-session.js';
import { getSandboxFileTree } from './file-tree.js';

function stackStatus(result, failLabel) {
  if (result.deferred) {
    return {
      ready: true,
      deferred: true,
      detail: result.detail || 'Installs on first use',
    };
  }
  return result.ok
    ? { ready: true, already: !!result.already, detail: result.detail || null }
    : { ready: false, error: result.error || failLabel };
}

async function probePythonStack(sandbox) {
  try {
    const probe = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', [
        `test -x ${VENV_DIR}/bin/python`,
        `${VENV_DIR}/bin/python -m pip --version >/dev/null 2>&1`,
      ].join(' && ')],
    });
    return (probe.exitCode ?? 1) === 0;
  } catch {
    return false;
  }
}

function getSandboxAuth() {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  if (VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID) {
    return { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID };
  }
  if (process.env.VERCEL_OIDC_TOKEN) return {};
  throw new Error(
    'Workspace sandbox is not configured. Set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID in Vercel env, then redeploy.',
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const { sandboxId, name } = req.body || {};
  const projectName = typeof name === 'string' && name.trim()
    ? name.trim().slice(0, 80)
    : 'untitled-project';

  let sandbox = null;

  try {
    if (sandboxId) {
      const auth = getSandboxAuth();
      try {
        sandbox = await Sandbox.get({ name: sandboxId, ...auth });
      } catch { /* gone — create new */ }
    }

    let isNew = !sandbox;
    if (!sandbox) {
      sandbox = await createSession();
      isNew = true;
    }

    // Always (re)init a blank tree. Resuming a prior clone and only
    // returning its files made "Start blank" look like a 1–2 file ghost repo.
    const setup = await sandbox.runCommand({
      cmd: 'bash',
      args: [
        '-lc',
        [
          `rm -rf ${JSON.stringify(REPO_DIR)}`,
          `mkdir -p ${JSON.stringify(REPO_DIR)}`,
          `cd ${JSON.stringify(REPO_DIR)}`,
          'git init -b main',
          `printf '%s\\n' '# ${projectName.replace(/'/g, '')}' '' 'Started blank in Workspace — no clone required.' > README.md`,
          'git add README.md',
          'git -c user.email=workspace@local -c user.name=Workspace commit -m "Initial blank project" || true',
        ].join(' && '),
      ],
    });
    if (setup.exitCode !== 0) {
      const err = await setup.stderr();
      throw new Error(`blank project setup failed: ${String(err || '').slice(0, 400)}`);
    }

    await sandbox.extendTimeout(30 * 60 * 1000);

    const py = (await probePythonStack(sandbox))
      ? { ok: true, already: true, detail: `venv ready at ${VENV_DIR}` }
      : { ok: true, deferred: true, detail: 'Python installs on first use' };

    const rust = (await probeRustStack(sandbox))
      ? { ok: true, already: true, detail: 'rustc + cargo already on PATH' }
      : { ok: true, deferred: true, detail: 'Rust installs on first cargo/rustc use' };
    const go = (await probeGoStack(sandbox))
      ? { ok: true, already: true, detail: 'go already on PATH' }
      : { ok: true, deferred: true, detail: 'Go installs on first go use' };

    const { tree, totalFiles } = await getSandboxFileTree(sandbox, REPO_DIR);

    res.setHeader('X-Sandbox-Session', sandbox.name);
    return res.status(200).json({
      sandboxId: sandbox.name,
      repoDir: REPO_DIR,
      tree,
      totalFiles,
      isNew,
      blank: true,
      projectName,
      python: stackStatus(py, 'python install failed'),
      rust: stackStatus(rust, 'rust install failed'),
      go: stackStatus(go, 'go install failed'),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
