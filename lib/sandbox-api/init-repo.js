/**
 * POST /api/init-repo
 * Body: { url: string (GitHub/git URL), sandboxId?: string, token?: string }
 *
 * A private repo needs credentials, and a sandbox has no terminal to ask at —
 * a bare clone dies with "could not read Username for github.com". The token
 * is the same GitHub PAT the push panel already keeps in the browser, so
 * opening a private repo needs nothing extra from the user. It is used for the
 * clone only and wiped from the remote afterwards, never written to .git/config.
 *
 * Creates a Vercel Sandbox, clones the repo into REPO_DIR, and returns:
 *   { sandboxId, tree, totalFiles, repoDir }
 *
 * If sandboxId is provided and the sandbox is still alive, resumes it and
 * does a `git pull` instead of a fresh clone. This lets you re-open a session
 * without losing changes.
 *
 * Returns X-Sandbox-Session header with the sandbox name so the client can
 * store it and send it on subsequent requests.
 */

import { Sandbox } from '@vercel/sandbox';
import {
  REPO_DIR,
  createSession,
  ensurePythonStack,
  ensureRustStack,
  ensureGoStack,
  probeRustStack,
  probeGoStack,
} from '../sandbox-session.js';

/** github.com/owner/repo -> https://x-access-token:TOKEN@github.com/owner/repo.git */
function githubUrlWithToken(url, token) {
  if (!token) return null;
  const m = String(url).trim().match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${m[1]}/${m[2]}.git`;
}

/** A token in a remote URL leaks into git's own error text — never echo it. */
function scrubToken(text, token) {
  let out = String(text || '');
  if (token) {
    out = out.split(token).join('***').split(encodeURIComponent(token)).join('***');
  }
  return out.replace(/x-access-token:[^@\s]*@/g, 'x-access-token:***@');
}

/** Git asking for a username in a sandbox means private repo, no credentials. */
function isAuthFailure(stderr) {
  return /could not read Username|Authentication failed|terminal prompts disabled|repository .* not found/i.test(
    String(stderr || ''),
  );
}

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

async function repoHasFile(sandbox, relPath) {
  const result = await sandbox.runCommand({
    cmd: 'test',
    args: ['-f', `${REPO_DIR}/${relPath}`],
  });
  return (result.exitCode ?? 1) === 0;
}

/**
 * Python always installs on init. Rust/Go install eagerly only when the repo
 * looks like a Rust/Go project — otherwise probe + defer (Hobby maxDuration).
 */
async function provisionToolchains(sandbox) {
  const py = await ensurePythonStack(sandbox);
  if (!py.ok) console.warn('ensurePythonStack failed:', py.error);

  const wantsRust = await repoHasFile(sandbox, 'Cargo.toml');
  const wantsGo = await repoHasFile(sandbox, 'go.mod');

  let rust;
  if (wantsRust) {
    rust = await ensureRustStack(sandbox);
    if (!rust.ok) console.warn('ensureRustStack failed:', rust.error);
  } else if (await probeRustStack(sandbox)) {
    rust = { ok: true, already: true, detail: 'rustc + cargo already on PATH' };
  } else {
    rust = { ok: true, deferred: true, detail: 'Rust installs on first cargo/rustc use' };
  }

  let go;
  if (wantsGo) {
    go = await ensureGoStack(sandbox);
    if (!go.ok) console.warn('ensureGoStack failed:', go.error);
  } else if (await probeGoStack(sandbox)) {
    go = { ok: true, already: true, detail: 'go already on PATH' };
  } else {
    go = { ok: true, deferred: true, detail: 'Go installs on first go use' };
  }

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

async function getFileTree(sandbox, dir, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  try {
    const result = await sandbox.runCommand({ cmd: 'find', args: [
      dir, '-maxdepth', '1', '-not', '-name', '.git',
      '-not', '-name', 'node_modules', '-not', '-name', 'dist',
      '-not', '-name', 'build', '-not', '-name', '.next',
      '-not', '-name', 'coverage', '-not', '-name', '__pycache__',
      '-not', '-path', dir,   // exclude the dir itself
    ]});
    const raw = await result.stdout();
    const entries = raw.trim().split('\n').filter(Boolean).sort();
    const nodes = [];
    for (const abs of entries) {
      const name = abs.split('/').pop();
      if (!name || name.startsWith('.') && name !== '.env.example') continue;
      if (name === 'assets' && (dir.endsWith('/public/agent') || dir.endsWith('/agent'))) continue;
      const statRes = await sandbox.runCommand({ cmd: 'stat', args: ['-c', '%F', abs] });
      const kind = (await statRes.stdout()).trim();
      const rel = abs.replace(dir + '/', '');
      if (kind === 'directory') {
        nodes.push({
          name, path: rel, type: 'dir',
          children: await getFileTree(sandbox, abs, depth + 1, maxDepth),
        });
      } else {
        const sizeRes = await sandbox.runCommand({ cmd: 'stat', args: ['-c', '%s', abs] });
        const size = parseInt(await sizeRes.stdout(), 10) || 0;
        nodes.push({
          name, path: rel, type: 'file',
          ext: name.includes('.') ? '.' + name.split('.').pop() : '',
          size,
        });
      }
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    return [];
  }
}

function countNodes(nodes) {
  let n = 0;
  for (const node of nodes) {
    if (node.type === 'file') n++;
    else if (node.children) n += countNodes(node.children);
  }
  return n;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const { url, sandboxId, token } = req.body || {};
  // The browser's saved PAT wins; a server-side token is the fallback for
  // deployments that would rather configure it once in the environment.
  const gitToken =
    (typeof token === 'string' && token.trim()) ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    '';
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
    // Try to resume an existing sandbox first
    if (sandboxId) {
      const auth = getSandboxAuth();
      try {
        sandbox = await Sandbox.get({ name: sandboxId, ...auth });
      } catch { /* sandbox gone, create new */ }
    }

    const isNew = !sandbox;
    if (isNew) {
      sandbox = await createSession();
      // Clone the repo. GIT_TERMINAL_PROMPT=0 turns the credential prompt
      // into an immediate, explainable failure instead of a wedged process.
      const cloneUrl = githubUrlWithToken(url, gitToken) || url;
      const clone = await sandbox.runCommand({
        cmd: 'git',
        args: ['clone', '--depth', '50', cloneUrl, REPO_DIR],
        env: { GIT_TERMINAL_PROMPT: '0' },
      });
      if (clone.exitCode !== 0) {
        const err = scrubToken(await clone.stderr(), gitToken);
        if (isAuthFailure(err)) {
          throw new Error(
            gitToken
              ? 'git clone failed: GitHub refused the saved token for this repo. ' +
                'It may be expired, or missing repo access. Open the push panel and paste a current token.'
              : 'git clone failed: this repo is private and no GitHub token was available. ' +
                'Paste a token once in the push panel (Push → token) and re-open — it is reused from then on.',
          );
        }
        throw new Error(`git clone failed: ${err.slice(0, 400)}`);
      }
      // Keep the token out of .git/config; git-push re-authenticates its own way.
      if (cloneUrl !== url) {
        await sandbox.runCommand({
          cmd: 'git',
          args: ['-C', REPO_DIR, 'remote', 'set-url', 'origin', url],
        });
      }
    } else {
      // Resume: git pull to refresh
      try {
        const pullUrl = githubUrlWithToken(url, gitToken);
        await sandbox.runCommand({
          cmd: 'git',
          args: pullUrl
            ? ['-C', REPO_DIR, 'pull', '--ff-only', pullUrl]
            : ['-C', REPO_DIR, 'pull', '--ff-only'],
          env: { GIT_TERMINAL_PROMPT: '0' },
        });
      } catch { /* ignore pull failures — the working copy is still usable */ }
    }

    // Extend timeout now that the repo is ready
    await sandbox.extendTimeout(30 * 60 * 1000);

    const stacks = await provisionToolchains(sandbox);

    const tree = await getFileTree(sandbox, REPO_DIR);
    const totalFiles = countNodes(tree);

    res.setHeader('X-Sandbox-Session', sandbox.name);
    return res.status(200).json({
      sandboxId: sandbox.name,
      repoDir: REPO_DIR,
      tree,
      totalFiles,
      isNew,
      ...stacks,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
