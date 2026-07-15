/**
 * POST /api/write-files
 * Body: { files: [{ path: string, content: string }] }
 * Writes files to the sandbox repo. All paths are relative to REPO_DIR.
 */

import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { files } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files array required' });
  }

  try {
    const sandbox = await requireSession(req);

    const results = await Promise.all(
      files.map(async ({ path: relPath, content }) => {
        try {
          const abs = `${REPO_DIR}/${relPath}`;
          if (!abs.startsWith(REPO_DIR + '/')) throw new Error('Path traversal rejected');
          await sandbox.writeFiles([{ path: abs, content: Buffer.from(content, 'utf8') }]);
          return { path: relPath, written: true };
        } catch (e) {
          return { path: relPath, written: false, error: e.message };
        }
      })
    );

    const allOk = results.every(r => r.written);
    return res.status(allOk ? 200 : 207).json({ results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
