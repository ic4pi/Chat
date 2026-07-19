/**
 * POST /api/git-push
 * Body: {
 *   message?: string,
 *   branch?: string,
 *   token: string,          // GitHub PAT with repo write access (required)
 *   files?: string[],       // optional — only stage these paths; else git add -A
 * }
 *
 * Commits sandbox changes and pushes to the cloned GitHub remote.
 * Token is used only for this request (not stored server-side).
 */

import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';

async function run(sandbox, args, opts = {}) {
  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: ['-c', args],
    cwd: opts.cwd || REPO_DIR,
  });
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  return {
    exitCode: result.exitCode ?? 0,
    stdout: String(stdout || ''),
    stderr: String(stderr || ''),
  };
}

function githubHttpsWithToken(remoteUrl, token) {
  // git@github.com:owner/repo.git  OR  https://github.com/owner/repo.git
  let m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  const safe = encodeURIComponent(token);
  return `https://x-access-token:${safe}@github.com/${owner}/${repo}.git`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sandbox-Session');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, branch, token, files } = req.body || {};
  if (!token || typeof token !== 'string' || token.trim().length < 8) {
    return res.status(400).json({
      error:
        'A GitHub personal access token is required to push. ' +
        'Create one at github.com/settings/tokens (repo scope) and paste it here. ' +
        'It is used once for this push and not stored.',
    });
  }

  try {
    const sandbox = await requireSession(req);

    // Ensure identity for commit
    await run(sandbox, 'git config user.email "sandbox-agent@users.noreply.github.com"');
    await run(sandbox, 'git config user.name "Sandbox Agent"');

    // Stage files
    if (Array.isArray(files) && files.length > 0) {
      for (const p of files) {
        const rel = String(p || '').replace(/^\.\//, '').replace(/\.\./g, '');
        if (!rel || rel.includes('..')) continue;
        const add = await run(sandbox, `git add -- "${rel.replace(/"/g, '')}"`);
        if (add.exitCode !== 0) {
          return res.status(400).json({ error: `git add failed for ${rel}: ${add.stderr || add.stdout}` });
        }
      }
    } else {
      const add = await run(sandbox, 'git add -A');
      if (add.exitCode !== 0) {
        return res.status(400).json({ error: `git add failed: ${add.stderr || add.stdout}` });
      }
    }

    const status = await run(sandbox, 'git status --porcelain');
    if (!status.stdout.trim()) {
      return res.status(200).json({
        ok: true,
        pushed: false,
        message: 'Nothing to commit — sandbox already matches the last commit.',
      });
    }

    const msg = (typeof message === 'string' && message.trim())
      ? message.trim().slice(0, 200)
      : 'Apply agent changes from sandbox';
    const commit = await run(
      sandbox,
      `git commit -m ${JSON.stringify(msg)}`,
    );
    if (commit.exitCode !== 0) {
      return res.status(400).json({
        error: `git commit failed: ${commit.stderr || commit.stdout}`,
      });
    }

    const remote = await run(sandbox, 'git remote get-url origin');
    const origin = (remote.stdout || '').trim();
    const authed = githubHttpsWithToken(origin, token.trim());
    if (!authed) {
      return res.status(400).json({
        error: `Origin is not a GitHub URL (got: ${origin || 'empty'}). Re-open a github.com repo.`,
      });
    }

    // Detect branch
    let pushRef = typeof branch === 'string' && branch.trim() ? branch.trim() : '';
    if (!pushRef) {
      const br = await run(sandbox, 'git rev-parse --abbrev-ref HEAD');
      pushRef = (br.stdout || '').trim();
      if (!pushRef || pushRef === 'HEAD') {
        const sym = await run(sandbox, 'git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main');
        pushRef = (sym.stdout || 'origin/main').trim().replace(/^origin\//, '') || 'main';
        const safeBr = pushRef.replace(/[^a-zA-Z0-9._\-\/]/g, '') || 'main';
        await run(sandbox, `git checkout -B "${safeBr}"`);
        pushRef = safeBr;
      }
    }
    const safeRef = String(pushRef).replace(/[^a-zA-Z0-9._\-\/]/g, '') || 'main';

    // Temporary remote with token — scrubbed after push (never left on disk).
    await run(sandbox, 'git remote remove push-auth 2>/dev/null || true');
    // Write token URL via env + printf to avoid leaking in process list overly...
    // Still best-effort; remote is removed immediately after.
    const setRemote = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', 'git remote add push-auth "$PUSH_URL"'],
      cwd: REPO_DIR,
      env: { PUSH_URL: authed },
    });
    if ((setRemote.exitCode ?? 0) !== 0) {
      const err = await setRemote.stderr();
      return res.status(500).json({ error: `Could not set push remote: ${err}` });
    }

    const push = await run(
      sandbox,
      `git push -u push-auth "HEAD:${safeRef}"`,
    );
    // Always scrub the authed remote
    await run(sandbox, 'git remote remove push-auth 2>/dev/null || true');

    if (push.exitCode !== 0) {
      return res.status(400).json({
        error:
          `git push failed: ${(push.stderr || push.stdout).slice(0, 600)}. ` +
          'Check that your token has repo write access and you can push to this repository.',
        branch: pushRef,
      });
    }

    return res.status(200).json({
      ok: true,
      pushed: true,
      branch: pushRef,
      message: msg,
      detail: (push.stdout || push.stderr || '').slice(0, 400),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
