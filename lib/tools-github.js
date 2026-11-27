/**
 * GitHub tool — the team's hands on the owner's repos.
 *
 *   Read:   getRepoContext() pulls the file tree + key files so personas
 *           discuss the REAL code, not a guess.
 *   Write:  openPullRequest() turns the dev persona's FILE: blocks into a
 *           branch + commits + PR. The owner merging is the approval step —
 *           nothing lands on main without their tap.
 *
 * Needs one env var: GITHUB_TOKEN (a fine-grained PAT with contents+pulls
 * access to the owner's repos). Server-side only; the token never leaves
 * these functions.
 */

const API = 'https://api.github.com';

export function githubConnected() {
  return !!(process.env.GITHUB_TOKEN || '').trim();
}

async function gh(path, { method = 'GET', body } = {}) {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('GitHub is not connected (no GITHUB_TOKEN).');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|html|css|py|md|sql|yml|yaml|toml|sh)$/i;
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|\.next|\.git|coverage|vendor)\//;
const KEY_FILES = [
  'package.json', 'README.md', 'readme.md', 'vercel.json', 'next.config.js', 'next.config.ts',
  'prisma/schema.prisma', '.env.example',
];

/** The repo shape + the handful of files a persona needs to orient. */
export async function getRepoContext(repo, { maxKeyFiles = 6 } = {}) {
  const meta = await gh(`/repos/${repo}`);
  const base = meta.default_branch || 'main';
  const tree = await gh(`/repos/${repo}/git/trees/${encodeURIComponent(base)}?recursive=1`);
  const paths = (tree.tree || [])
    .filter((n) => n.type === 'blob' && !SKIP_DIRS.test(n.path))
    .map((n) => n.path)
    .slice(0, 400);

  // Key config/doc files first, then a few real source files so the code is real.
  const keyPaths = KEY_FILES.filter((k) => paths.includes(k));
  const sourcePaths = paths.filter((p) => CODE_EXT.test(p) && !keyPaths.includes(p)).slice(0, 4);
  const files = [];
  for (const path of [...keyPaths, ...sourcePaths].slice(0, maxKeyFiles)) {
    try {
      const f = await gh(`/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(base)}`);
      if (f.size > 30_000) continue;
      files.push({ path, content: Buffer.from(f.content, 'base64').toString('utf8').slice(0, 12_000) });
    } catch { /* a file that won't read doesn't block the job */ }
  }
  return { repo, base, paths, files };
}

/**
 * Parse the dev persona's proposed changes:
 *
 *   FILE: path/in/repo.js
 *   ```
 *   <complete new file content>
 *   ```
 *
 * Strict on purpose — a block without a FILE: line is prose, not a change.
 */
export function parseFileChanges(text) {
  const out = [];
  const re = /^FILE:\s*(\S[^\n]*)\n```[^\n]*\n([\s\S]*?)```/gm;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const path = m[1].trim();
    if (!path || path.includes('..') || path.startsWith('/') || SKIP_DIRS.test(path)) continue;
    out.push({ path, content: m[2] });
    if (out.length >= 20) break;   // a runaway persona can't rewrite the universe
  }
  return out;
}

/** Create branch → commit each file → open the PR (or reuse the open one). */
export async function openPullRequest(repo, { branch, title, body, files }) {
  if (!files?.length) throw new Error('No file changes to commit.');
  const meta = await gh(`/repos/${repo}`);
  const base = meta.default_branch || 'main';
  const baseRef = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const baseSha = baseRef.object.sha;

  try {
    await gh(`/repos/${repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: baseSha } });
  } catch (err) {
    if (!/422/.test(err.message)) throw err;   // 422 = branch already exists; commit on top of it
  }

  for (const f of files) {
    let sha;
    try {
      const cur = await gh(`/repos/${repo}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`);
      sha = cur.sha;
    } catch { /* new file */ }
    await gh(`/repos/${repo}/contents/${encodeURIComponent(f.path)}`, {
      method: 'PUT',
      body: {
        message: `chore(agency): update ${f.path}`,
        content: Buffer.from(f.content, 'utf8').toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      },
    });
  }

  try {
    const pr = await gh(`/repos/${repo}/pulls`, {
      method: 'POST',
      body: { title: title.slice(0, 200), head: branch, base, body: body.slice(0, 4000) },
    });
    return { prUrl: pr.html_url, prNumber: pr.number, branch };
  } catch (err) {
    if (/422/.test(err.message)) {
      const owner = repo.split('/')[0];
      const existing = await gh(`/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`);
      if (existing?.[0]) return { prUrl: existing[0].html_url, prNumber: existing[0].number, branch, reused: true };
    }
    throw err;
  }
}
