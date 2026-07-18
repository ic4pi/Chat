/**
 * Keep agent prompts under the model context window.
 * Pattern matches Cursor / Claude Code: search snippets first, full files sparingly.
 */

/** Paths that must never be auto-selected or stuffed into context. */
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

/** Only auto-load full files under this size (~12k tokens). */
export const MAX_AUTO_FULL_FILE_CHARS = 48_000;
/** Hard cap for any single file in the prompt. */
export const MAX_FILE_CHARS = 80_000;
/** Total full-file budget in the system prompt. */
export const MAX_CONTEXT_CHARS = 160_000;
/** Search-hit snippet budget. */
export const MAX_SNIPPET_CHARS = 24_000;
export const MAX_TREE_PATHS = 200;

export interface SearchHit {
  path: string;
  score?: number;
  size?: number;
  reason?: string;
  snippets: string[];
}

export function isJunkContextPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return SKIP_PATH_RE.test(p);
}

export function isSourcePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  if (isJunkContextPath(p)) return false;
  if (p.includes('/public/agent/')) return false;
  return SOURCE_EXT_RE.test(p);
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

export function packContextFiles(
  files: Map<string, string>,
  budget = MAX_CONTEXT_CHARS,
): Map<string, string> {
  const entries = [...files.entries()]
    .filter(([p]) => !isJunkContextPath(p))
    .map(([p, c]) => [p, truncateForContext(c)] as const)
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

/** Format search hits as compact snippet blocks for the system prompt. */
export function formatSearchHits(hits: SearchHit[], budget = MAX_SNIPPET_CHARS): string {
  if (!hits.length) return '';
  const parts: string[] = ['── Search hits (snippets only — not full files) ──'];
  let used = 0;
  for (const hit of hits) {
    if (isJunkContextPath(hit.path)) continue;
    const body = (hit.snippets ?? []).slice(0, 4).join('\n…\n');
    if (!body.trim()) {
      const line = `${hit.path}  (matched, no snippet)`;
      if (used + line.length > budget) break;
      parts.push(line);
      used += line.length;
      continue;
    }
    const block = `\n### ${hit.path}\n\`\`\`\n${body}\n\`\`\``;
    if (used + block.length > budget) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n');
}

export function trimMessageHistory(
  messages: Array<{ role: string; content: string }>,
  budgetChars = 60_000,
): Array<{ role: string; content: string }> {
  if (messages.length === 0) return messages;
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= budgetChars) return messages;

  const out = [...messages];
  while (out.length > 1 && total > budgetChars) {
    const removed = out.shift()!;
    total -= removed.content.length;
  }
  // Truncate oversized individual messages (e.g. huge prior assistant dumps)
  return out.map(m =>
    m.content.length > 20_000
      ? { ...m, content: truncateForContext(m.content, 20_000) }
      : m,
  );
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
