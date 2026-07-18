/**
 * search.ts — keyword-based file search for auto-context.
 *
 * Strategy (in order of weight):
 *   3 pts — filename contains keyword
 *   2 pts — file content matches keyword (ripgrep, falls back to grep -r)
 *   Bonus  — multiple keywords match the same file
 *
 * Results are sorted by score and capped at maxFiles.
 * Returns relative paths inside root.
 */

import { spawn }  from 'child_process';
import * as fs    from 'fs';
import * as path  from 'path';
import ignore     from 'ignore';

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the','a','an','is','in','on','at','to','for','of','and','or','that',
  'this','with','it','me','my','fix','add','make','create','update','change',
  'please','can','you','should','would','could','will','get','use','how',
  'why','what','when','where','which','do','does','did','have','has','had',
  'are','was','were','be','been','being','not','no','but','if','so','than',
  'then','also','just','need','want','write','build','implement','show','tell',
  'let','help','give','new','old','all','any','some','there','here','by','from',
  'up','out','file','code','function','class','method','line','error','bug',
  'issue','problem','feature','test','run','into','onto','about','like','more',
]);

export function extractKeywords(query: string): string[] {
  // Split camelCase / PascalCase first
  const expanded = query.replace(/([a-z])([A-Z])/g, '$1 $2');

  const words = expanded
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  return [...new Set(words)].slice(0, 8); // cap at 8 keywords
}

// ---------------------------------------------------------------------------
// Gitignore filter (reuse the repo-level one)
// ---------------------------------------------------------------------------

function buildIgnore(root: string) {
  const ig = ignore();
  ig.add(['.git','node_modules','__pycache__','.DS_Store','*.pyc',
          'dist','build','.next','.vercel','coverage','.cache',
          'public/agent/assets','**/assets/index-*.js','**/assets/index-*.css',
          '*.min.js','*.min.css','*.map','*.lock',
          'package-lock.json','yarn.lock','pnpm-lock.yaml']);
  const gp = path.join(root, '.gitignore');
  if (fs.existsSync(gp)) ig.add(fs.readFileSync(gp, 'utf8'));
  return ig;
}

// ---------------------------------------------------------------------------
// Filename search (synchronous walk)
// ---------------------------------------------------------------------------

function filenameSearch(root: string, keyword: string, ig: ReturnType<typeof ignore>): string[] {
  const results: string[] = [];
  const kw = keyword.toLowerCase();

  function walk(dir: string, rel: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const eRel = rel ? `${rel}/${e.name}` : e.name;
      if (ig.ignores(eRel) || ig.ignores(eRel + '/')) continue;
      if (e.isDirectory()) { walk(path.join(dir, e.name), eRel); }
      else if (e.isFile() && e.name.toLowerCase().includes(kw)) {
        results.push(eRel);
      }
    }
  }
  walk(root, '');
  return results;
}

// ---------------------------------------------------------------------------
// Content search — ripgrep preferred, grep -r fallback
// ---------------------------------------------------------------------------

function spawnSearch(cmd: string, args: string[]): Promise<string> {
  return new Promise(resolve => {
    let out = '';
    const child = spawn(cmd, args, { stdio: 'pipe' });
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
  });
}

async function contentSearch(root: string, keyword: string): Promise<string[]> {
  // Try ripgrep first (much faster)
  let output = await spawnSearch('rg', [
    '--files-with-matches', '--ignore-case', '--glob=!node_modules',
    '--glob=!.git', '--glob=!dist', '--glob=!build', '--glob=!coverage',
    '--glob=!.next', '--glob=!public/agent/assets',
    '--glob=!*.min.js', '--glob=!*.min.css', '--glob=!*.map',
    '--glob=!package-lock.json', '--glob=!**/assets/index-*.js',
    '--', keyword, root,
  ]);

  if (!output) {
    // Fall back to grep -r
    output = await spawnSearch('grep', [
      '-rl', '--include=*.*',
      '--exclude-dir=node_modules', '--exclude-dir=.git',
      '--exclude-dir=dist', '--exclude-dir=build',
      '--exclude-dir=coverage', '--exclude-dir=.next',
      '-i', keyword, root,
    ]);
  }

  return output.trim().split('\n')
    .filter(Boolean)
    .map(f => {
      try { return path.relative(root, f); } catch { return ''; }
    })
    .filter(rel => {
      if (!rel) return false;
      if (rel.includes('public/agent/assets/')) return false;
      if (/assets\/index-[A-Za-z0-9_-]+\.(js|css)$/.test(rel)) return false;
      return true;
    });
}

// ---------------------------------------------------------------------------
// Snippet extraction — up to 2 context lines per keyword match
// ---------------------------------------------------------------------------

function extractSnippets(
  root: string,
  relPath: string,
  keywords: string[],
  maxLines = 4,
): string[] {
  try {
    const lines = fs.readFileSync(path.join(root, relPath), 'utf8').split('\n');
    const snippets: string[] = [];
    for (let i = 0; i < lines.length && snippets.length < maxLines; i++) {
      const l = lines[i]!.toLowerCase();
      if (keywords.some(kw => l.includes(kw))) {
        snippets.push(`L${i + 1}: ${lines[i]!.trim()}`);
      }
    }
    return snippets;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

export interface SearchMatch {
  path:     string;   // relative to root
  score:    number;
  snippets: string[]; // short preview lines
  reason:   string;   // human-readable explanation
}

export async function searchRepo(
  root: string,
  query: string,
  maxFiles = 6,
): Promise<SearchMatch[]> {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  const ig     = buildIgnore(root);
  const scores = new Map<string, number>();
  const reasons= new Map<string, string[]>();

  const addScore = (relPath: string, pts: number, reason: string) => {
    scores.set(relPath, (scores.get(relPath) ?? 0) + pts);
    const r = reasons.get(relPath) ?? [];
    r.push(reason);
    reasons.set(relPath, r);
  };

  // Filename matches (parallel)
  for (const kw of keywords) {
    for (const f of filenameSearch(root, kw, ig)) {
      addScore(f, 3, `filename contains "${kw}"`);
    }
  }

  // Content matches (parallel)
  await Promise.all(keywords.map(async kw => {
    for (const f of await contentSearch(root, kw)) {
      addScore(f, 1, `content matches "${kw}"`);
    }
  }));

  // Sort and cap
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFiles);

  return sorted.map(([relPath, score]) => ({
    path:     relPath,
    score,
    snippets: extractSnippets(root, relPath, keywords),
    reason:   (reasons.get(relPath) ?? []).join(', '),
  }));
}
