/**
 * Keep agent prompts under the model context window.
 * Venice / Dolphin report ~131072 tokens; we stay well below that.
 */

/** Paths that must never be auto-selected or stuffed into context. */
const SKIP_PATH_RE = new RegExp(
  [
    '(^|/)_?node_modules(/|$)',
    '(^|/)(\\.git|dist|build|coverage|\\.next|\\.vercel|\\.cache|__pycache__)(/|$)',
    '(^|/)public/agent/assets(/|$)',
    '\\.(min\\.(js|css)|map|lock|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp4|zip|gz|wasm)$',
    '(^|/)(package-lock|yarn\\.lock|pnpm-lock\\.yaml)$',
    // Vite/webpack hashed bundles
    '(^|/)assets/index-[A-Za-z0-9_-]+\\.(js|css)$',
  ].join('|'),
  'i',
);

/** ~chars; ~4 chars/token → ~20k tokens/file hard cap. */
export const MAX_FILE_CHARS = 80_000;
/** Total file-contents budget in the system prompt (~60k tokens). */
export const MAX_CONTEXT_CHARS = 240_000;
/** Cap how many paths the file-tree listing may contribute. */
export const MAX_TREE_PATHS = 400;

export function isJunkContextPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return SKIP_PATH_RE.test(p);
}

export function truncateForContext(content: string, max = MAX_FILE_CHARS): string {
  if (content.length <= max) return content;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 80;
  return (
    content.slice(0, head) +
    `\n\n/* … truncated ${content.length - max} chars for context budget … */\n\n` +
    content.slice(-Math.max(tail, 0))
  );
}

/**
 * Pack context files into a char budget (largest first dropped when over).
 * Returns a new Map that fits under MAX_CONTEXT_CHARS after per-file caps.
 */
export function packContextFiles(
  files: Map<string, string>,
  budget = MAX_CONTEXT_CHARS,
): Map<string, string> {
  const entries = [...files.entries()]
    .filter(([p]) => !isJunkContextPath(p))
    .map(([p, c]) => [p, truncateForContext(c)] as const)
    // Prefer smaller source files over giant leftovers
    .sort((a, b) => a[1].length - b[1].length);

  const out = new Map<string, string>();
  let used = 0;
  for (const [p, c] of entries) {
    if (used + c.length > budget) continue;
    out.set(p, c);
    used += c.length;
  }
  return out;
}

/** Keep recent turns; drop oldest assistant/user pairs when over a char budget. */
export function trimMessageHistory(
  messages: Array<{ role: string; content: string }>,
  budgetChars = 80_000,
): Array<{ role: string; content: string }> {
  if (messages.length === 0) return messages;
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= budgetChars) return messages;

  const out = [...messages];
  // Always keep the latest user message
  while (out.length > 1 && total > budgetChars) {
    const removed = out.shift()!;
    total -= removed.content.length;
  }
  return out;
}
