/**
 * Shared junk-path filters for agent search / file tree (sandbox API).
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

export function isJunkContextPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return SKIP_PATH_RE.test(p);
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
