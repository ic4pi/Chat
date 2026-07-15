/**
 * POST /api/search
 * Body: { query: string, maxFiles?: number }
 * Searches the cloned repo in the sandbox using ripgrep (included in node24 image).
 */

import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';

const STOP_WORDS = new Set([
  'the','a','an','is','in','on','at','to','for','of','and','or','that','this','with',
  'it','me','my','fix','add','make','create','update','change','please','can','you',
  'should','would','could','will','get','use','how','why','what','when','where','do',
  'does','have','has','are','was','were','be','not','no','but','if','so','by','from',
  'file','code','function','class','method','error','bug','issue','test','run','build',
]);

function extractKeywords(query) {
  const expanded = query.replace(/([a-z])([A-Z])/g, '$1 $2');
  return [...new Set(
    expanded.replace(/[^\w\s]/g, ' ').split(/\s+/)
      .map(w => w.toLowerCase())
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  )].slice(0, 8);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { query, maxFiles = 6 } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const sandbox = await requireSession(req);
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return res.json({ matches: [] });

    const scores = new Map();
    const reasons = new Map();

    const addScore = (path, pts, reason) => {
      scores.set(path, (scores.get(path) ?? 0) + pts);
      const r = reasons.get(path) ?? [];
      r.push(reason);
      reasons.set(path, r);
    };

    // Run all keyword searches in parallel inside the sandbox
    await Promise.all(keywords.map(async kw => {
      // Filename search
      const fnRes = await sandbox.runCommand({ cmd: 'bash', args: ['-c',
        `find "${REPO_DIR}" -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -iname "*${kw}*" 2>/dev/null | head -10`
      ]});
      const fnOut = await fnRes.stdout();
      for (const abs of fnOut.trim().split('\n').filter(Boolean)) {
        addScore(abs.replace(REPO_DIR + '/', ''), 3, `filename contains "${kw}"`);
      }

      // Content search (use rg if available, fall back to grep)
      const rgRes = await sandbox.runCommand({ cmd: 'bash', args: ['-c',
        `(rg --files-with-matches -i --glob "!node_modules" --glob "!.git" -- "${kw}" "${REPO_DIR}" 2>/dev/null || grep -rl --include="*.*" --exclude-dir=node_modules --exclude-dir=.git -i "${kw}" "${REPO_DIR}" 2>/dev/null) | head -20`
      ]});
      const rgOut = await rgRes.stdout();
      for (const abs of rgOut.trim().split('\n').filter(Boolean)) {
        addScore(abs.replace(REPO_DIR + '/', ''), 1, `content matches "${kw}"`);
      }
    }));

    const matches = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFiles)
      .map(([path, score]) => ({
        path, score,
        reason: (reasons.get(path) ?? []).join(', '),
        snippets: [],
      }));

    return res.json({ matches });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
