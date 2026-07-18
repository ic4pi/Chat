/**
 * POST /api/search
 * Body: { query: string, maxFiles?: number }
 * Searches the cloned repo in the sandbox using ripgrep (included in node24 image).
 * Skips build artifacts / hashed bundles so auto-context cannot blow the model window.
 */

import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';
import { isJunkContextPath, SEARCH_EXCLUDE_GLOBS } from '../lib/context-filters.js';

const STOP_WORDS = new Set([
  'the','a','an','is','in','on','at','to','for','of','and','or','that','this','with',
  'it','me','my','fix','add','make','create','update','change','please','can','you',
  'should','would','could','will','get','use','how','why','what','when','where','do',
  'does','have','has','are','was','were','be','not','no','but','if','so','by','from',
  'file','code','function','class','method','error','bug','issue','test','run','build',
]);

/** Skip files larger than this in search hits (~80KB). */
const MAX_SEARCH_FILE_BYTES = 80_000;

function extractKeywords(query) {
  const expanded = query.replace(/([a-z])([A-Z])/g, '$1 $2');
  return [...new Set(
    expanded.replace(/[^\w\s]/g, ' ').split(/\s+/)
      .map(w => w.toLowerCase())
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  )].slice(0, 8);
}

function toRel(abs) {
  return abs.replace(REPO_DIR.replace(/\/$/, '') + '/', '').replace(/^\//, '');
}

function findPrunePaths() {
  // Directories to prune: find … \( -path … -o -path … \) -prune -o …
  return SEARCH_EXCLUDE_GLOBS
    .map(d => `-path "*/${d}" -o -path "*/${d}/*"`)
    .join(' -o ');
}

function rgGlobArgs() {
  return SEARCH_EXCLUDE_GLOBS
    .map(d => `--glob '!${d}' --glob '!${d}/**'`)
    .join(' ')
    + " --glob '!*.min.js' --glob '!*.min.css' --glob '!*.map' --glob '!package-lock.json'";
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
      if (!path || isJunkContextPath(path)) return;
      scores.set(path, (scores.get(path) ?? 0) + pts);
      const r = reasons.get(path) ?? [];
      r.push(reason);
      reasons.set(path, r);
    };

    const prunePaths = findPrunePaths();
    const rgGlobs = rgGlobArgs();

    await Promise.all(keywords.map(async kw => {
      const safeKw = kw.replace(/[^a-zA-Z0-9_.-]/g, '');
      if (!safeKw) return;

      // Filename search — prune junk dirs, skip huge files
      const fnRes = await sandbox.runCommand({ cmd: 'bash', args: ['-c',
        `find "${REPO_DIR}" \\( ${prunePaths} \\) -prune -o -type f -iname "*${safeKw}*" -size -${MAX_SEARCH_FILE_BYTES}c -print 2>/dev/null | head -10`
      ]});
      const fnOut = await fnRes.stdout();
      for (const abs of fnOut.trim().split('\n').filter(Boolean)) {
        addScore(toRel(abs), 3, `filename contains "${safeKw}"`);
      }

      // Content search
      const rgRes = await sandbox.runCommand({ cmd: 'bash', args: ['-c',
        `(rg --files-with-matches -i ${rgGlobs} -- "${safeKw}" "${REPO_DIR}" 2>/dev/null || true) | head -20`
      ]});
      const rgOut = await rgRes.stdout();
      for (const abs of rgOut.trim().split('\n').filter(Boolean)) {
        addScore(toRel(abs), 1, `content matches "${safeKw}"`);
      }
    }));

    // Drop any leftover junk + oversized files
    const candidates = [...scores.entries()]
      .filter(([path]) => !isJunkContextPath(path))
      .sort((a, b) => b[1] - a[1]);

    const matches = [];
    for (const [path, score] of candidates) {
      if (matches.length >= maxFiles) break;
      try {
        const st = await sandbox.runCommand({
          cmd: 'bash',
          args: ['-c', `stat -c %s "${REPO_DIR}/${path}" 2>/dev/null || echo 0`],
        });
        const size = parseInt(await st.stdout(), 10) || 0;
        if (size <= 0 || size > MAX_SEARCH_FILE_BYTES) continue;
      } catch { continue; }
      matches.push({
        path, score,
        reason: (reasons.get(path) ?? []).join(', '),
        snippets: [],
      });
    }

    return res.json({ matches });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
