/**
 * Fast sandbox file-tree listing.
 *
 * One `find` round-trip builds the whole tree (correct repo-relative paths).
 * The old walk did 2–3 sandbox.runCommand calls *per file* and routinely
 * blew the Hobby 60s budget — leaving the UI with a handful of root files
 * and empty folders ("illiterate" explorer after clone).
 */

/** Same path as sandbox-session REPO_DIR — kept local to avoid import cycles. */
export const TREE_REPO_DIR = '/vercel/sandbox/repo';

const PRUNE_NAMES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.cache',
  '.vercel',
];

/** Max entries returned from find (guards huge monorepos). */
const MAX_FIND_LINES = 8000;
/** Max directory depth from repo root (root = depth 1). */
const DEFAULT_MAX_DEPTH = 6;

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function shouldHideRelPath(rel) {
  if (!rel) return true;
  const parts = rel.split('/');
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('.') && part !== '.env.example') return true;
  }
  // Prebuilt agent bundles blow context if selected / listed.
  if (/(^|\/)(public\/)?agent\/assets(\/|$)/.test(rel)) return true;
  return false;
}

/**
 * Build a nested FileNode[] from flat find records.
 * @param {Array<{ rel: string, type: 'file'|'dir', size?: number }>} entries
 * @param {{ maxDepth?: number }} [opts]
 */
export function buildTreeFromEntries(entries, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const root = [];
  const dirMap = new Map();
  dirMap.set('', root);

  const cleaned = [];
  for (const e of entries) {
    const rel = String(e.rel || '').replace(/^\/+/, '').replace(/\\/g, '/');
    if (!rel || shouldHideRelPath(rel)) continue;
    const depth = rel.split('/').length;
    if (depth > maxDepth) continue;
    cleaned.push({
      rel,
      type: e.type === 'dir' ? 'dir' : 'file',
      size: typeof e.size === 'number' ? e.size : 0,
    });
  }

  // Dirs first so parent maps exist before children attach.
  cleaned.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.rel.localeCompare(b.rel);
  });

  for (const e of cleaned) {
    const slash = e.rel.lastIndexOf('/');
    const parent = slash >= 0 ? e.rel.slice(0, slash) : '';
    const name = slash >= 0 ? e.rel.slice(slash + 1) : e.rel;
    const siblings = dirMap.get(parent);
    if (!siblings) continue;

    if (e.type === 'dir') {
      const children = [];
      dirMap.set(e.rel, children);
      siblings.push({ name, path: e.rel, type: 'dir', children });
    } else {
      siblings.push({
        name,
        path: e.rel,
        type: 'file',
        ext: name.includes('.') ? `.${name.split('.').pop()}` : '',
        size: e.size || 0,
      });
    }
  }

  function sortNodes(nodes) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children) sortNodes(n.children);
    }
  }
  sortNodes(root);
  return root;
}

/**
 * Parse GNU find -printf lines: `d\trel\t0` / `f\trel\tsize`
 * @param {string} raw
 */
export function parseFindTreeOutput(raw) {
  const entries = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const kind = parts[0];
    const rel = parts[1];
    const size = parts.length >= 3 ? parseInt(parts[2], 10) || 0 : 0;
    if (kind === 'd') entries.push({ rel, type: 'dir', size: 0 });
    else if (kind === 'f') entries.push({ rel, type: 'file', size });
  }
  return entries;
}

export function countTreeFiles(nodes) {
  let n = 0;
  for (const node of nodes || []) {
    if (node.type === 'file') n++;
    else if (node.children) n += countTreeFiles(node.children);
  }
  return n;
}

function findPruneExpr() {
  // \( -name a -o -name b … \) -prune
  const names = PRUNE_NAMES.map((n) => `-name '${n}'`).join(' -o ');
  return `\\( ${names} \\) -prune`;
}

/**
 * List the sandbox repo tree in one command.
 * @param {import('@vercel/sandbox').Sandbox} sandbox
 * @param {string} [dir]
 * @param {{ maxDepth?: number }} [opts]
 */
export async function getSandboxFileTree(sandbox, dir = TREE_REPO_DIR, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  // %P = path relative to the start directory (GNU find).
  // maxdepth on find is relative to start: depth 1 = immediate children.
  const script = [
    'set +e',
    `ROOT=${JSON.stringify(dir)}`,
    `find "$ROOT" -mindepth 1 -maxdepth ${maxDepth} ${findPruneExpr()} -o \\( -type d -printf 'd\\t%P\\t0\\n' -o -type f -printf 'f\\t%P\\t%s\\n' \\) 2>/dev/null | head -n ${MAX_FIND_LINES}`,
  ].join('\n');

  try {
    const result = await sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', script],
    });
    const raw = typeof result.stdout === 'function' ? await result.stdout() : '';
    const entries = parseFindTreeOutput(raw);
    const tree = buildTreeFromEntries(entries, { maxDepth });
    return { tree, totalFiles: countTreeFiles(tree) };
  } catch (err) {
    console.warn('getSandboxFileTree failed:', err?.message || err);
    return { tree: [], totalFiles: 0 };
  }
}

/** Normalize git remotes / pasted GitHub URLs for equality checks. */
export function normalizeGitUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/^https?:\/\/www\./i, 'https://')
    .toLowerCase();
}
