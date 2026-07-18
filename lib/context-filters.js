/**
 * Shared junk-path filters + source-file heuristics for the agent.
 */

const SKIP_PATH_RE = new RegExp(
  [
    '(^|/)_?node_modules(/|$)',
    '(^|/)(\\.git|dist|build|coverage|\\.next|\\.vercel|\\.cache|__pycache__)(/|$)',
    '(^|/)public/agent/assets(/|$)',
    '\\.(min\\.(js|css)|map|lock|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp4|zip|gz|wasm)$',
    '(^|/)(package-lock|yarn\\.lock|pnpm-lock\\.yaml)$',
    '(^|/)assets/index-[A-Za-z0-9_-]+\\.(js|css)$',
  ].join('|'),
  'i',
);

const SOURCE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|css|scss|html|md|json|yml|yaml|toml|sh)$/i;

export function isJunkContextPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return SKIP_PATH_RE.test(p);
}

export function isSourcePath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (isJunkContextPath(p)) return false;
  if (p.includes('/public/agent/')) return false;
  return SOURCE_EXT_RE.test(p);
}

/** Extra score for paths that look like editable application source. */
export function sourcePathBonus(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').toLowerCase();
  if (!isSourcePath(p)) return -50;
  let bonus = 2;
  if (/(^|\/)(src|api|lib|app|server|sandbox-terminal\/src|sandbox-runner\/src)\//.test(p)) {
    bonus += 4;
  }
  if (/(^|\/)public\//.test(p) && !p.endsWith('.css') && !p.endsWith('.html')) {
    bonus -= 2;
  }
  return bonus;
}

/** find/rg globs to exclude from sandbox search */
export const SEARCH_EXCLUDE_GLOBS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.vercel',
  '.cache',
  '__pycache__',
  'public/agent/assets',
];

/** Rough token estimate (chars/4). Good enough for budget guards. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
