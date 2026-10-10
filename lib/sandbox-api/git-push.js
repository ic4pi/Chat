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
 *
 * Before commit, runs scripts/check-api.mjs or npm run check / npm test when
 * present. A failing check returns 400 and does not push.
 */

import { requireSession, REPO_DIR } from '../sandbox-session.js';
import { STATIC_SMOKE_COMMAND } from './static-smoke.js';

// Branches the sandbox agent must never land on directly — a normal push routes
// through a branch + PR instead. (This was referenced but never defined, which
// crashed the protected-branch routing path.)
const PROTECTED_BRANCHES = new Set(['main', 'master']);

// The pre-push check, shared by the normal push (as a hard gate) and the WIP
// backup (run only to LABEL the commit ok/broken, never to block it).
const CHECK_SCRIPT = [
  'set -e',
  'run_check() {',
  '  if [ -f scripts/check-api.mjs ] && command -v node >/dev/null 2>&1; then',
  '    echo "pre-push: node scripts/check-api.mjs"',
  '    node scripts/check-api.mjs',
  '    return $?',
  '  fi',
  '  if [ -f package.json ] && command -v npm >/dev/null 2>&1; then',
  '    if node --input-type=module -e "import fs from \\"fs\\"; const s=JSON.parse(fs.readFileSync(\\"package.json\\",\\"utf8\\")).scripts||{}; process.exit(s.check?0:2)"; then',
  '      echo "pre-push: npm run check"',
  '      npm run check',
  '      return $?',
  '    fi',
  '    if node --input-type=module -e "import fs from \\"fs\\"; const s=JSON.parse(fs.readFileSync(\\"package.json\\",\\"utf8\\")).scripts||{}; process.exit(s.test?0:2)"; then',
  '      echo "pre-push: npm test"',
  '      npm test',
  '      return $?',
  '    fi',
  '  fi',
  '  if [ -f index.html ] || [ -f index.htm ] || [ -f public/index.html ] || [ -f dist/index.html ] || ls ./*.html >/dev/null 2>&1; then',
  '    echo "pre-push: static HTML smoke"',
  `    ${STATIC_SMOKE_COMMAND}`,
  '    return $?',
  '  fi',
  '  echo "pre-push: FAIL — no check/test script and no index.html to smoke-test"',
  '  echo "Add npm run check / npm test, or an index.html entry page, before pushing."',
  '  return 1',
  '}',
  'run_check',
].join('\n');

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

function parseOwnerRepo(remoteUrl) {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workspace-app';
}

/**
 * Creates a brand-new GitHub repo for the user who owns `token`, so pushing
 * never requires them to have made one first. Retries once with a suffix if
 * the name is taken — no UI round-trip, no "go create a repo and come back".
 */
async function createGithubRepo({ token, name, isPrivate }) {
  const attempt = async (repoName) => {
    const resp = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'sandbox-agent',
      },
      body: JSON.stringify({
        name: repoName,
        private: isPrivate !== false,
        auto_init: false,
        description: 'Created automatically from Workspace',
      }),
    });
    const data = await resp.json().catch(() => ({}));
    return { resp, data };
  };

  let { resp, data } = await attempt(name);
  if (resp.status === 422) {
    const suffixed = `${name}-${Date.now().toString(36).slice(-5)}`;
    ({ resp, data } = await attempt(suffixed));
  }
  if (!resp.ok || !data.clone_url) {
    return { ok: false, error: data.message || `GitHub repo creation returned ${resp.status}` };
  }
  return { ok: true, cloneUrl: data.clone_url, htmlUrl: data.html_url, fullName: data.full_name };
}


/**
 * Opens (or reuses) a PR from headBranch into baseBranch. Never throws —
 * a PR-creation failure should not be reported as a push failure, since the
 * branch push itself already succeeded and is safely off main.
 */
async function openPullRequest({ owner, repo, token, head, base, title, body }) {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'sandbox-agent',
      },
      body: JSON.stringify({ title, head, base, body }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.html_url) {
      return { ok: true, url: data.html_url, number: data.number };
    }
    // Already exists → look it up instead of treating as failure.
    if (resp.status === 422) {
      const list = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&base=${base}&state=open`,
        { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'sandbox-agent' } },
      );
      const existing = await list.json().catch(() => []);
      if (Array.isArray(existing) && existing[0]?.html_url) {
        return { ok: true, url: existing[0].html_url, number: existing[0].number, reused: true };
      }
    }
    return { ok: false, error: data.message || `GitHub PR API returned ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Sandbox-Session');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { message, branch, token, files, repoName, private: wantPrivate, wip } = req.body || {};
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

    // ── WIP backup ──────────────────────────────────────────────────────────
    // A safety net so a VM reset never loses progress, even when the app does
    // not work yet. The check still runs — but only to LABEL the commit, never
    // to block it. Always a dedicated throwaway branch (force-pushed), never
    // main and never a PR.
    if (wip) {
      const check = await run(sandbox, CHECK_SCRIPT);
      const checkPassed = check.exitCode === 0;
      const label = checkPassed ? 'WIP ok' : 'WIP broken';
      const base = (typeof message === 'string' && message.trim())
        ? message.trim().slice(0, 140)
        : 'Workspace progress';
      const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const wipMsg = `[${label}] ${base} — ${stamp}`;

      const commit = await run(sandbox, `git commit -m ${JSON.stringify(wipMsg)}`);
      if (commit.exitCode !== 0) {
        return res.status(400).json({ error: `git commit failed: ${commit.stderr || commit.stdout}` });
      }

      let createdRepo = null;
      const remoteW = await run(sandbox, 'git remote get-url origin');
      let originW = (remoteW.stdout || '').trim();
      if (!originW) {
        const dirName = await run(sandbox, 'basename "$(pwd)"');
        const created = await createGithubRepo({
          token: token.trim(),
          name: slugify(repoName || (dirName.stdout || '').trim()),
          isPrivate: wantPrivate,
        });
        if (!created.ok) {
          return res.status(400).json({ error: `Could not create a GitHub repo to back up to: ${created.error}` });
        }
        await run(sandbox, `git remote add origin "${created.cloneUrl}"`);
        originW = created.cloneUrl;
        createdRepo = created;
      }
      const authedW = githubHttpsWithToken(originW, token.trim());
      if (!authedW) {
        return res.status(400).json({ error: `Origin is not a GitHub URL (got: ${originW || 'empty'}).` });
      }
      const wipBranch = (typeof branch === 'string' && branch.trim())
        ? branch.trim().replace(/[^a-zA-Z0-9._\-\/]/g, '')
        : 'workspace-wip';
      await run(sandbox, 'git remote remove push-auth 2>/dev/null || true');
      const setRemoteW = await sandbox.runCommand({
        cmd: 'bash', args: ['-c', 'git remote add push-auth "$PUSH_URL"'], cwd: REPO_DIR, env: { PUSH_URL: authedW },
      });
      if ((setRemoteW.exitCode ?? 0) !== 0) {
        return res.status(500).json({ error: `Could not set push remote: ${await setRemoteW.stderr()}` });
      }
      // Force: this branch is a scratch progress mirror. After a re-clone the
      // local history restarts from the base branch, so a plain push would be
      // rejected as non-fast-forward — expected for a throwaway backup.
      const pushW = await run(sandbox, `git push -f -u push-auth "HEAD:${wipBranch}"`);
      await run(sandbox, 'git remote remove push-auth 2>/dev/null || true');
      if (pushW.exitCode !== 0) {
        return res.status(400).json({
          error: `WIP push failed: ${(pushW.stderr || pushW.stdout).slice(0, 500)}. Check the token has repo write access.`,
          branch: wipBranch,
        });
      }
      return res.status(200).json({
        ok: true,
        pushed: true,
        wip: true,
        checkPassed,
        branch: wipBranch,
        createdRepoUrl: createdRepo?.htmlUrl || null,
        message: wipMsg,
      });
    }

    // Hard gate: NEVER push without a passing check.
    // Prefer scripts/check-api.mjs / npm run check|test; else built-in static smoke.
    // Refusing "no tests → allow" is intentional — that shipped broken review sites.
    const prePush = await run(sandbox, CHECK_SCRIPT);
    if (prePush.exitCode !== 0) {
      const detail = `${prePush.stdout || ''}\n${prePush.stderr || ''}`.trim().slice(0, 1200);
      return res.status(400).json({
        error:
          'Pre-push check failed — not pushing unproven code to GitHub.\n' +
          'Keep Auto-test on, fix until tests/smoke pass, then Push again.\n\n' +
          detail,
        checkFailed: true,
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

    let createdRepo = null;
    const remote = await run(sandbox, 'git remote get-url origin');
    let origin = (remote.stdout || '').trim();
    if (!origin) {
      // Blank projects (and private clones with origin stripped) have no
      // GitHub remote — create one now instead of making the user go set
      // up a repo first. New repos are private by default, matching the
      // rest of this account's apps.
      const dirName = await run(sandbox, 'basename "$(pwd)"');
      const fallbackName = slugify(repoName || (dirName.stdout || '').trim());
      const created = await createGithubRepo({
        token: token.trim(),
        name: fallbackName,
        isPrivate: wantPrivate,
      });
      if (!created.ok) {
        return res.status(400).json({
          error: `Could not create a GitHub repo to push to: ${created.error}`,
        });
      }
      const addRemote = await run(sandbox, `git remote add origin "${created.cloneUrl}"`);
      if (addRemote.exitCode !== 0) {
        return res.status(500).json({
          error: `Repo created (${created.htmlUrl}) but could not set it as remote: ${addRemote.stderr || addRemote.stdout}`,
        });
      }
      origin = created.cloneUrl;
      createdRepo = created;
    }
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
      }
    }
    let safeRef = String(pushRef).replace(/[^a-zA-Z0-9._\-\/]/g, '') || 'main';
    const baseBranch = safeRef; // the branch the agent was targeting (usually main)

    // Never let the sandbox agent land straight on a protected branch.
    // This is the one incident in this repo's history that took production
    // down (a sandbox auto-commit wiped api/agent-chat.js on main): route
    // through a branch + PR instead, every time, no override — EXCEPT a repo
    // this very request just created (createdRepo), which by definition has
    // no prior history to protect and no base branch on GitHub yet to PR into.
    let openedPR = null;
    if (PROTECTED_BRANCHES.has(safeRef) && !createdRepo) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const agentBranch = `agent/${stamp}`;
      const co = await run(sandbox, `git checkout -B "${agentBranch}"`);
      if (co.exitCode !== 0) {
        return res.status(500).json({ error: `Could not create branch ${agentBranch}: ${co.stderr || co.stdout}` });
      }
      safeRef = agentBranch;
    }

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

    if (safeRef !== baseBranch && PROTECTED_BRANCHES.has(baseBranch)) {
      const ownerRepo = parseOwnerRepo(origin);
      if (ownerRepo) {
        const pr = await openPullRequest({
          ...ownerRepo,
          token: token.trim(),
          head: safeRef,
          base: baseBranch,
          title: msg,
          body:
            'Opened automatically by the sandbox agent — checks passed, but this ' +
            'is not merged. Review the diff before merging into ' + baseBranch + '.',
        });
        if (pr.ok) openedPR = pr;
        // If PR creation itself fails, we still report success below: the
        // code is safely on a branch, not lost, just not yet in a PR.
      }
    }

    return res.status(200).json({
      ok: true,
      pushed: true,
      branch: safeRef,
      routedFromProtectedBranch: safeRef !== baseBranch,
      pullRequestUrl: openedPR?.url || null,
      createdRepoUrl: createdRepo?.htmlUrl || null,
      message: msg,
      detail: (push.stdout || push.stderr || '').slice(0, 400),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
