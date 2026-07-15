/**
 * repo.ts — filesystem helpers for the local repo agent.
 *
 * Safety contract: every path that leaves or enters the server is validated
 * against the declared repoRoot with path.resolve + startsWith so no request
 * can read or write outside the root the user explicitly opened.
 */

import * as fs   from 'fs';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';

// ---------------------------------------------------------------------------
// Gitignore-aware ignore filter
// ---------------------------------------------------------------------------

function buildIgnore(root: string): Ignore {
  const ig = ignore();
  // Always ignore these regardless of .gitignore
  ig.add(['.git', 'node_modules', '__pycache__', '.DS_Store', '*.pyc',
          'dist', 'build', '.next', '.vercel', 'coverage', '.cache',
          '*.min.js', '*.min.css', '*.map']);

  const gitignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf8'));
  }
  return ig;
}

// ---------------------------------------------------------------------------
// FileNode — the tree structure returned to the client
// ---------------------------------------------------------------------------

export interface FileNode {
  name:     string;
  path:     string;   // relative to repoRoot
  type:     'file' | 'dir';
  ext?:     string;
  size?:    number;   // bytes, files only
  children?: FileNode[];
}

// ---------------------------------------------------------------------------
// Walk the directory tree (max depth 6 to avoid huge monorepos)
// ---------------------------------------------------------------------------

function walk(
  abs: string,
  rel: string,
  ig: Ignore,
  depth: number,
): FileNode[] {
  if (depth > 6) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileNode[] = [];
  for (const entry of entries) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (ig.ignores(entryRel + (entry.isDirectory() ? '/' : ''))) continue;
    if (ig.ignores(entryRel)) continue;

    const entryAbs = path.join(abs, entry.name);

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: entryRel,
        type: 'dir',
        children: walk(entryAbs, entryRel, ig, depth + 1),
      });
    } else if (entry.isFile()) {
      let size: number | undefined;
      try { size = fs.statSync(entryAbs).size; } catch { /* ok */ }
      nodes.push({
        name: entry.name,
        path: entryRel,
        type: 'file',
        ext:  path.extname(entry.name).toLowerCase(),
        size,
      });
    }
  }

  // dirs first, then files, both alphabetical
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return the full file tree for a repo root (gitignore-aware). */
export function getFileTree(root: string): FileNode[] {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) throw new Error(`Path not found: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`Not a directory: ${abs}`);
  const ig = buildIgnore(abs);
  return walk(abs, '', ig, 0);
}

/** Read a single file — must be inside root. Returns utf-8 string. */
export function readFile(root: string, relPath: string): string {
  const abs = safeResolve(root, relPath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${relPath}`);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);
  // Refuse to read very large files — they'd blow the context window
  if (stat.size > 500_000) throw new Error(`File too large (${stat.size} bytes): ${relPath}`);
  return fs.readFileSync(abs, 'utf8');
}

/** Write one or more files — all must be inside root. Creates dirs as needed. */
export function writeFiles(
  root: string,
  files: Array<{ path: string; content: string }>,
): Array<{ path: string; written: boolean; error?: string }> {
  return files.map(({ path: relPath, content }) => {
    try {
      const abs = safeResolve(root, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return { path: relPath, written: true };
    } catch (err: unknown) {
      return { path: relPath, written: false,
        error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Resolve a relative path and verify it stays inside root (no path traversal). */
export function safeResolve(root: string, relPath: string): string {
  const absRoot = path.resolve(root);
  const abs     = path.resolve(absRoot, relPath);
  if (!abs.startsWith(absRoot + path.sep) && abs !== absRoot) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  return abs;
}

/** Count total files in a tree (for quick stats). */
export function countFiles(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === 'file') n++;
    else if (node.children) n += countFiles(node.children);
  }
  return n;
}
