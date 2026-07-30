/**
 * POST /api/write-files
 * Body: { files: [{ path: string, content: string }] }
 * Writes files to the sandbox repo. All paths are relative to REPO_DIR.
 *
 * Rejects incomplete patch-style dumps (e.g. "// ... existing imports ...")
 * that previously overwrote api/agent-chat.js and took production to HTTP 500.
 */

import { requireSession, REPO_DIR } from '../sandbox-session.js';

const INCOMPLETE_PATCH_RE =
  /(?:^|\n)\s*(?:\/\/|#|\/\*)\s*\.\.\.\s*existing\b|(?:^|\n)\s*\/\/\s*Then in (?:the )?handler\b|\b\.\.\.\s*existing (?:code|imports|content|implementation)\b/i;

function rejectIncomplete(relPath, content) {
  const text = typeof content === 'string' ? content : '';
  if (!text.trim()) return 'empty file content';
  if (INCOMPLETE_PATCH_RE.test(text)) {
    return 'incomplete patch (contains "... existing" / stub comments) — write the FULL file';
  }
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (/^api\/.+\.js$/.test(rel)) {
    if (!/\bexport\s+default\b/.test(text)) {
      return 'api handlers must include export default';
    }
    if (text.length < 200) {
      return 'api file looks truncated (too short to be a complete handler)';
    }
  }
  return null;
}

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
          const bad = rejectIncomplete(relPath, content);
          if (bad) throw new Error(bad);
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
