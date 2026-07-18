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
/** Max full source files opened automatically per query (ephemeral working set). */
export const MAX_AUTO_FULL_FILES = 5;
/** Broad audits / vague asks get a slightly larger working set. */
export const MAX_AUDIT_FULL_FILES = 8;
/** Hard cap for any single file in the prompt. */
export const MAX_FILE_CHARS = 80_000;
/** Total full-file budget in the system prompt. */
export const MAX_CONTEXT_CHARS = 160_000;
/** Search-hit snippet budget. */
export const MAX_SNIPPET_CHARS = 24_000;
export const MAX_TREE_PATHS = 80;

/** Prefer these paths when the user asks for a broad audit and search is thin. */
const AUDIT_SEED_RE =
  /(^|\/)(api|lib|src|sandbox-terminal\/src|sandbox-runner\/src)\//;
const AUDIT_NAME_RE =
  /(agent|chat|context|repo|session|sandbox|search|auth|config|server|app)\./i;

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

/**
 * Rank source paths when the user didn't name a file (most non-coder asks).
 * Used for audits and as a fallback when keyword search is thin.
 */
export function pickAuditSeedPaths(paths: string[], limit = MAX_AUDIT_FULL_FILES): string[] {
  const scored = paths
    .filter(p => isSourcePath(p))
    .map(p => {
      const norm = p.replace(/\\/g, '/');
      let score = 1;
      if (AUDIT_SEED_RE.test(norm)) score += 6;
      if (AUDIT_NAME_RE.test(norm)) score += 4;
      if (/(^|\/)(package\.json|README\.md|vercel\.json)$/i.test(norm)) score += 2;
      // Prefer smaller editable sources over giant dumps (size unknown here — path only).
      if (norm.split('/').length <= 3) score += 1;
      return { path: norm, score };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const { path: p } of scored) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
