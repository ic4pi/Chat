/**
 * GET /api/files?sandboxId=<name>
 * Returns the file tree of the cloned repo inside the sandbox.
 * The sandbox already has the repo at REPO_DIR from /api/init-repo.
 */

import { requireSession, REPO_DIR } from '../sandbox-session.js';
import { getSandboxFileTree } from './file-tree.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const sandbox = await requireSession(req);
    const { tree, totalFiles } = await getSandboxFileTree(sandbox, REPO_DIR);
    return res.json({ root: REPO_DIR, tree, totalFiles });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
