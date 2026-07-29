/**
 * POST /api/init-blank
 * Body: { sandboxId?: string, name?: string }
 *
 * Starts a Workspace project with no GitHub clone — empty folder + git init.
 * Returns the same shape as /api/init-repo so the client can treat them alike.
 */

import { Sandbox } from '@vercel/sandbox';
import { REPO_DIR, createSession, ensurePythonStack } from '../sandbox-session.js';

function getSandboxAuth() {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID } = process.env;
  if (VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID) {
    return { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID };
  }
  if (process.env.VERCEL_OIDC_TOKEN) return {};
  throw new Error('No Vercel credentials.');
}

async function getFileTree(sandbox, dir, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  try {
    const result = await sandbox.runCommand({
      cmd: 'find',
      args: [
        dir, '-maxdepth', '1', '-not', '-name', '.git',
        '-not', '-name', 'node_modules', '-not', '-name', 'dist',
        '-not', '-name', 'build', '-not', '-name', '.next',
        '-not', '-name', 'coverage', '-not', '-name', '__pycache__',
        '-not', '-path', dir,
      ],
    });
    const raw = await result.stdout();
    const entries = raw.trim().split('\n').filter(Boolean).sort();
    const nodes = [];
    for (const abs of entries) {
      const name = abs.split('/').pop();
      if (!name || (name.startsWith('.') && name !== '.env.example')) continue;
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

    const isNew = !sandbox;
    if (isNew) {
      sandbox = await createSession();
      const setup = await sandbox.runCommand({
        cmd: 'bash',
        args: [
          '-lc',
          [
            `mkdir -p ${REPO_DIR}`,
            `cd ${REPO_DIR}`,
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
    }

    await sandbox.extendTimeout(30 * 60 * 1000);

    const py = await ensurePythonStack(sandbox);
    if (!py.ok) {
      console.warn('ensurePythonStack failed:', py.error);
    }

    const tree = await getFileTree(sandbox, REPO_DIR);
    const totalFiles = countNodes(tree);

    res.setHeader('X-Sandbox-Session', sandbox.name);
    return res.status(200).json({
      sandboxId: sandbox.name,
      repoDir: REPO_DIR,
      tree,
      totalFiles,
      isNew,
      blank: true,
      projectName,
      python: py.ok
        ? { ready: true, already: !!py.already, detail: py.detail || null }
        : { ready: false, error: py.error || 'python install failed' },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
