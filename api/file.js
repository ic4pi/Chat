/**
 * GET /api/file?path=<relative-path>&maxBytes?=N
 * Reads one file from the cloned repo inside the sandbox.
 * Rejects build artifacts that would blow the model context window.
 */

import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';
import { isJunkContextPath } from '../lib/context-filters.js';

const DEFAULT_MAX_BYTES = 200_000;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'path required' });
  if (isJunkContextPath(String(relPath))) {
    return res.status(400).json({
      error: `Refusing to load build artifact into context: ${relPath}`,
    });
  }

  const maxBytes = Math.min(
    DEFAULT_MAX_BYTES,
    Math.max(1_000, parseInt(String(req.query.maxBytes || ''), 10) || DEFAULT_MAX_BYTES),
  );

  try {
    const sandbox = await requireSession(req);
    const abs = `${REPO_DIR}/${relPath}`;

    // Safety: abs must start with REPO_DIR
    if (!abs.startsWith(REPO_DIR + '/') && abs !== REPO_DIR) {
      return res.status(400).json({ error: 'Path traversal rejected' });
    }

    const sizeRes = await sandbox.runCommand({
      cmd: 'bash', args: ['-c', `stat -c %s "${abs}" 2>/dev/null || echo 0`],
    });
    const size = parseInt(await sizeRes.stdout(), 10) || 0;
    if (size <= 0) return res.status(404).json({ error: `File not found: ${relPath}` });

    const result = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', `head -c ${maxBytes} "${abs}"`],
    });
    if (result.exitCode !== 0) {
      return res.status(404).json({ error: `File not found: ${relPath}` });
    }
    let content = await result.stdout();
    const truncated = size > maxBytes;
    if (truncated) {
      content += `\n\n/* … truncated server-side: showing ${maxBytes} of ${size} bytes … */\n`;
    }
    const lines = content.split('\n').length;
    return res.json({ path: relPath, content, lines, size, truncated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
