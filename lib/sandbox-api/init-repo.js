/**
 * POST /api/init-repo
 * Body: { url: string (GitHub/git URL), sandboxId?: string }
 *
 * Creates a Vercel Sandbox, clones the repo into REPO_DIR, and returns:
 *   { sandboxId, tree, totalFiles, repoDir }
 *
 * If sandboxId is provided and the sandbox still has the *same* remote URL,
 * resumes with `git pull`. A different URL (or a blank project with no remote)
 * wipes REPO_DIR and clones fresh — otherwise the explorer kept showing the
 * old 1–2 file blank tree after pasting a GitHub link.
 *
 * Toolchain installs are deferred to first use (run / run-code) so clone+tree
 * fit inside the Hobby 60s budget.
 */

import { Sandbox } from '@vercel/sandbox';
import {
  REPO_DIR,
  createSession,
  probeRustStack,
  probeGoStack,
  VENV_DIR,
} from '../sandbox-session.js';
import {
  getSandboxFileTree,
  normalizeGitUrl,
} from './file-tree.js';

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

/**
 * Lightweight probes only — no dnf/rustup during init (Hobby maxDuration).
 * run / run-code still call ensure*Stack on demand.
 */
async function provisionToolchains(sandbox) {
  const py = (await probePythonStack(sandbox))
    ? { ok: true, already: true, detail: `venv ready at ${VENV_DIR}` }
    : { ok: true, deferred: true, detail: 'Python installs on first use' };

  const rust = (await probeRustStack(sandbox))
    ? { ok: true, already: true, detail: 'rustc + cargo already on PATH' }
    : { ok: true, deferred: true, detail: 'Rust installs on first cargo/rustc use' };

  const go = (await probeGoStack(sandbox))
    ? { ok: true, already: true, detail: 'go already on PATH' }
    : { ok: true, deferred: true, detail: 'Go installs on first go use' };

  return {
    python: stackStatus(py, 'python install failed'),
    rust: stackStatus(rust, 'rust install failed'),
    go: stackStatus(go, 'go install failed'),
  };
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

async function readOriginUrl(sandbox) {
  try {
    const result = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `git -C ${JSON.stringify(REPO_DIR)} remote get-url origin 2>/dev/null || true`],
    });
    const raw = typeof result.stdout === 'function' ? await result.stdout() : '';
    return String(raw || '').trim();
  } catch {
    return '';
  }
}

async function wipeRepoDir(sandbox) {
  await sandbox.runCommand({
    cmd: 'bash',
    args: ['-lc', `rm -rf ${JSON.stringify(REPO_DIR)}`],
  });
}

async function cloneRepo(sandbox, url) {
  const clone = await sandbox.runCommand({
    cmd: 'git',
    args: ['clone', '--depth', '50', url, REPO_DIR],
  });
  if (clone.exitCode !== 0) {
    const err = typeof clone.stderr === 'function' ? await clone.stderr() : '';
    throw new Error(`git clone failed: ${String(err || '').slice(0, 400)}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const { url, sandboxId } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  const isGitUrl = /^https?:\/\/|^git@/.test(url);
  if (!isGitUrl) {
    return res.status(400).json({
      error: 'Only git/https URLs are supported in the online version. ' +
        'For local repos, run sandbox-runner locally.',
    });
  }

  let sandbox = null;

  try {
    if (sandboxId) {
      const auth = getSandboxAuth();
      try {
        sandbox = await Sandbox.get({ name: sandboxId, ...auth });
      } catch { /* sandbox gone, create new */ }
    }

    let isNew = !sandbox;
    let didClone = false;

    if (!sandbox) {
      sandbox = await createSession();
      isNew = true;
      await cloneRepo(sandbox, url);
      didClone = true;
    } else {
      const currentRemote = await readOriginUrl(sandbox);
      const sameRepo = currentRemote
        && normalizeGitUrl(currentRemote) === normalizeGitUrl(url);

      if (sameRepo) {
        try {
          await sandbox.runCommand({
            cmd: 'git',
            args: ['-C', REPO_DIR, 'pull', '--ff-only'],
          });
        } catch { /* ignore pull failures */ }
      } else {
        // Blank project or a different GitHub URL — must re-clone or the
        // file explorer keeps showing the old tiny tree.
        await wipeRepoDir(sandbox);
        await cloneRepo(sandbox, url);
        didClone = true;
        isNew = true;
      }
    }

    await sandbox.extendTimeout(30 * 60 * 1000);

    // Tree BEFORE any optional work — this is what the explorer needs.
    const { tree, totalFiles } = await getSandboxFileTree(sandbox, REPO_DIR);
    const stacks = await provisionToolchains(sandbox);

    res.setHeader('X-Sandbox-Session', sandbox.name);
    return res.status(200).json({
      sandboxId: sandbox.name,
      repoDir: REPO_DIR,
      tree,
      totalFiles,
      isNew,
      didClone,
      ...stacks,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
