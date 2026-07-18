/**
 * GET /api/files?sandboxId=<name>
 * Returns the file tree of the cloned repo inside the sandbox.
 * The sandbox already has the repo at REPO_DIR from /api/init-repo.
 */

import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';

async function getFileTree(sandbox, dir, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  try {
    const result = await sandbox.runCommand({ cmd: 'bash', args: ['-c',
      `find "${dir}" -maxdepth 1 ! -path "${dir}" ! -name ".git" ! -name "node_modules" ! -name "dist" ! -name "build" ! -name ".next" ! -name "coverage" ! -name "__pycache__" ! -name "*.pyc" -print0 | sort -z`
    ]});
    const raw = await result.stdout();
    const entries = raw.split('\0').filter(Boolean);
    const nodes = [];
    for (const abs of entries) {
      const name = abs.split('/').pop();
      if (!name) continue;
      // Hide prebuilt agent bundles from the tree (they blow context if selected).
      if (name === 'assets' && (dir.endsWith('/public/agent') || dir.endsWith('/agent'))) continue;
      const statRes = await sandbox.runCommand({ cmd: 'bash', args: ['-c',
        `[ -d "${abs}" ] && echo dir || echo file`] });
      const kind = (await statRes.stdout()).trim();
      const rel = abs.replace(dir + '/', '');
      if (kind === 'dir') {
        nodes.push({ name, path: rel, type: 'dir',
          children: await getFileTree(sandbox, abs, depth + 1, maxDepth) });
      } else {
        const sizeRes = await sandbox.runCommand({ cmd: 'stat', args: ['-c', '%s', abs] });
        const size = parseInt(await sizeRes.stdout(), 10) || 0;
        nodes.push({ name, path: rel, type: 'file',
          ext: name.includes('.') ? '.' + name.split('.').pop() : '', size });
      }
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch { return []; }
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
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const sandbox = await requireSession(req);
    const tree = await getFileTree(sandbox, REPO_DIR);
    return res.json({ root: REPO_DIR, tree, totalFiles: countNodes(tree) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
