/**
 * POST /api/search
 * Body: { query: string, maxFiles?: number }
 *
 * Returns ranked SOURCE files with short snippets — same pattern as Cursor /
 * Claude Code: search first, don't dump whole files into the model.
 */

import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';
import {
  isJunkContextPath,
  isSourcePath,
  sourcePathBonus,
  SEARCH_EXCLUDE_GLOBS,
} from '../lib/context-filters.js';

const STOP_WORDS = new Set([
  'the','a','an','is','in','on','at','to','for','of','and','or','that','this','with',
  'it','me','my','fix','add','make','create','update','change','please','can','you',
  'should','would','could','will','get','use','how','why','what','when','where','do',
  'does','have','has','are','was','were','be','not','no','but','if','so','by','from',
  'file','code','function','class','method','error','bug','issue','test','run','build',
]);

const MAX_SEARCH_FILE_BYTES = 80_000;
const MAX_SNIPPETS_PER_FILE = 4;
const SNIPPET_CONTEXT_LINES = 1;

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
  return SEARCH_EXCLUDE_GLOBS
    .map(d => `-path "*/${d}" -o -path "*/${d}/*"`)
    .join(' -o ');
}

function rgGlobArgs() {
  return SEARCH_EXCLUDE_GLOBS
    .map(d => `--glob '!${d}' --glob '!${d}/**'`)
    .join(' ')
    + " --glob '!*.min.js' --glob '!*.min.css' --glob '!*.map'"
    + " --glob '!package-lock.json' --glob '!**/assets/index-*.js'";
}

async function extractSnippets(sandbox, relPath, keywords) {
  try {
    const cat = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-c', `head -c ${MAX_SEARCH_FILE_BYTES} "${REPO_DIR}/${relPath}" 2>/dev/null`],
    });
    const content = await cat.stdout();
    if (!content) return [];
    const lines = content.split('\n');
    const hits = [];
    const lowerKws = keywords.map(k => k.toLowerCase());

    for (let i = 0; i < lines.length && hits.length < MAX_SNIPPETS_PER_FILE; i++) {
      const line = lines[i] ?? '';
      const low = line.toLowerCase();
      if (!lowerKws.some(kw => low.includes(kw))) continue;
      const start = Math.max(0, i - SNIPPET_CONTEXT_LINES);
      const end = Math.min(lines.length - 1, i + SNIPPET_CONTEXT_LINES);
      const chunk = [];
      for (let j = start; j <= end; j++) {
        chunk.push(`${j + 1}|${lines[j] ?? ''}`);
      }
      hits.push(chunk.join('\n'));
      i = end; // skip past this window
    }
    return hits;
  } catch {
    return [];
  }
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
      if (!path || isJunkContextPath(path) || !isSourcePath(path)) return;
      const bonus = sourcePathBonus(path);
      scores.set(path, (scores.get(path) ?? 0) + pts + bonus);
      const r = reasons.get(path) ?? [];
      r.push(reason);
      reasons.set(path, r);
    };

    const prunePaths = findPrunePaths();
    const rgGlobs = rgGlobArgs();

    await Promise.all(keywords.map(async kw => {
      const safeKw = kw.replace(/[^a-zA-Z0-9_.-]/g, '');
      if (!safeKw) return;

      const fnRes = await sandbox.runCommand({ cmd: 'bash', args: ['-c',
        `find "${REPO_DIR}" \\( ${prunePaths} \\) -prune -o -type f -iname "*${safeKw}*" -size -${MAX_SEARCH_FILE_BYTES}c -print 2>/dev/null | head -15`
      ]});
      for (const abs of (await fnRes.stdout()).trim().split('\n').filter(Boolean)) {
        addScore(toRel(abs), 3, `filename contains "${safeKw}"`);
      }

      const rgRes = await sandbox.runCommand({ cmd: 'bash', args: ['-c',
        `(rg --files-with-matches -i ${rgGlobs} -- "${safeKw}" "${REPO_DIR}" 2>/dev/null || true) | head -25`
      ]});
      for (const abs of (await rgRes.stdout()).trim().split('\n').filter(Boolean)) {
        addScore(toRel(abs), 1, `content matches "${safeKw}"`);
      }
    }));

    const ranked = [...scores.entries()]
      .filter(([path]) => isSourcePath(path))
      .sort((a, b) => b[1] - a[1]);

    const matches = [];
    for (const [path, score] of ranked) {
      if (matches.length >= maxFiles) break;
      try {
        const st = await sandbox.runCommand({
          cmd: 'bash',
          args: ['-c', `stat -c %s "${REPO_DIR}/${path}" 2>/dev/null || echo 0`],
        });
        const size = parseInt(await st.stdout(), 10) || 0;
        if (size <= 0 || size > MAX_SEARCH_FILE_BYTES) continue;
        const snippets = await extractSnippets(sandbox, path, keywords);
        matches.push({
          path,
          score,
          size,
          reason: (reasons.get(path) ?? []).join(', '),
          snippets,
        });
      } catch { /* skip */ }
    }

    return res.json({ matches, keywords });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
