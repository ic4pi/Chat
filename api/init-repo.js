/**
 * POST /api/init-repo
 * Body: { url: string (GitHub/git URL), sandboxId?: string }
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
import { REPO_DIR, createSession, getExistingSession } from '../lib/sandbox-session.js';

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
    const result = await sandbox.runCommand({ cmd: 'find', args: [
      dir, '-maxdepth', '1', '-not', '-name', '.git',
      '-not', '-name', 'node_modules', '-not', '-name', '__pycache__',
      '-not', '-path', dir,   // exclude the dir itself
    ]});
    const raw = await result.stdout();
    const entries = raw.trim().split('\n').filter(Boolean).sort();
    const nodes = [];
    for (const abs of entries) {
      const name = abs.split('/').pop();
      if (!name || name.startsWith('.') && name !== '.env.example') continue;
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
      // Clone the repo
      const clone = await sandbox.runCommand({
        cmd: 'git',
        args: ['clone', '--depth', '50', url, REPO_DIR],
      });
      if (clone.exitCode !== 0) {
        const err = await clone.stderr();
        throw new Error(`git clone failed: ${err.slice(0, 400)}`);
      }
    } else {
      // Resume: git pull to refresh
      try {
        await sandbox.runCommand({ cmd: 'git', args: ['-C', REPO_DIR, 'pull', '--ff-only'] });
      } catch { /* ignore pull failures */ }
    }

    // Extend timeout now that the repo is ready
    await sandbox.extendTimeout(30 * 60 * 1000);

    const tree = await getFileTree(sandbox, REPO_DIR);
    const totalFiles = countNodes(tree);

    res.setHeader('X-Sandbox-Session', sandbox.name);
    return res.status(200).json({
      sandboxId: sandbox.name,
      repoDir: REPO_DIR,
      tree,
      totalFiles,
      isNew,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
