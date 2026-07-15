/**
 * GET /api/file?path=<relative-path>
 * Reads one file from the cloned repo inside the sandbox.
 */

import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path required' });

  try {
    const sandbox = await requireSession(req);
    const abs = `${REPO_DIR}/${relPath}`;

    // Safety: abs must start with REPO_DIR
    if (!abs.startsWith(REPO_DIR + '/') && abs !== REPO_DIR) {
      return res.status(400).json({ error: 'Path traversal rejected' });
    }

    const result = await sandbox.runCommand({ cmd: 'cat', args: [abs] });
    if (result.exitCode !== 0) {
      return res.status(404).json({ error: `File not found: ${relPath}` });
    }
    const content = await result.stdout();
    const lines = content.split('\n').length;
    return res.json({ path: relPath, content, lines });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
