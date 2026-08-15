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

const PROTECTED_BRANCHES = new Set(['main', 'master']);

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

    // Hard gate: NEVER push without a passing check.
    // Prefer scripts/check-api.mjs / npm run check|test; else built-in static smoke.
    // Refusing "no tests → allow" is intentional — that shipped broken review sites.
    const prePush = await run(
      sandbox,
      [
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
      ].join('\n'),
    );
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
      }
    }
    let safeRef = String(pushRef).replace(/[^a-zA-Z0-9._\-\/]/g, '') || 'main';
    const baseBranch = safeRef; // the branch the agent was targeting (usually main)

    // Never let the sandbox agent land straight on a protected branch.
    // This is the one incident in this repo's history that took production
    // down (a sandbox auto-commit wiped api/agent-chat.js on main): route
    // through a branch + PR instead, every time, no override.
    let openedPR = null;
    if (PROTECTED_BRANCHES.has(safeRef)) {
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
      message: msg,
      detail: (push.stdout || push.stderr || '').slice(0, 400),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
