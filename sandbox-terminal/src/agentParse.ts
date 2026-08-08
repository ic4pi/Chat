/**
 * Pure helpers for coding-agent replies: File: block extraction and
 * intent detection (suggest vs apply).
 *
 * Incomplete / stub File: blocks are NEVER accepted. Silent drops used to
 * wipe production APIs — rejected paths must be reported loudly to the UI.
 */

export interface FileChange {
  path: string;
  content: string;
}

export interface RejectedFileChange {
  path: string;
  reason: string;
}

export interface FileChangeReport {
  accepted: FileChange[];
  rejected: RejectedFileChange[];
}

/** Why a file dump is unsafe to write into the sandbox (or null if OK). */
export function incompleteFileReason(content: string, filePath = ''): string | null {
  const c = content || '';
  if (!c.trim()) return 'empty file content';

  if (/(?:^|\n)\s*(?:\/\/|#|\/\*|<!--)\s*\.\.\.\s*existing\b/i.test(c)) {
    return 'stub comment “… existing …” — write the FULL file';
  }
  if (/(?:^|\n)\s*\/\/\s*Then in (?:the )?handler\b/i.test(c)) {
    return 'patch stub (“Then in handler”) — write the FULL file';
  }
  if (/\b\.\.\.\s*existing (?:code|imports|content|implementation|logic|handlers?)\b/i.test(c)) {
    return 'incomplete “… existing …” dump — write the FULL file';
  }
  if (/\b(rest of (?:the )?file|unchanged below|keep the rest|same as before)\b/i.test(c)) {
    return 'partial rewrite language — write the FULL file';
  }
  if (/\bYOUR[_ -]?CODE[_ -]?HERE\b|\bINSERT[_ -]?CODE[_ -]?HERE\b|<placeholders?>/i.test(c)) {
    return 'placeholder junk — write real complete code';
  }
  // Truncated fences / ellipsis-only bodies
  if (/^\s*\.\.\.\s*$/m.test(c) && c.trim().length < 80) {
    return 'ellipsis-only body — write the FULL file';
  }

  const rel = filePath.replace(/\\/g, '/');
  // API serverless handlers must export a default function — stubs never do.
  if (/^api\/.+\.js$/.test(rel) || /(^|\/)api\/.+\.js$/.test(rel)) {
    if (!/\bexport\s+default\b/.test(c)) {
      return 'api handler missing export default — refusing to trash the sandbox';
    }
    if (c.length < 200) {
      return 'api file looks truncated — refusing to trash the sandbox';
    }
  }
  // Critical shared libs — never accept tiny wipe stubs
  if (/(^|\/)lib\/sandbox-api\/.+\.js$/.test(rel) || /(^|\/)lib\/config\.js$/.test(rel)) {
    if (c.length < 120) {
      return 'critical lib looks truncated — refusing to trash the sandbox';
    }
  }
  return null;
}

/**
 * True when the model emitted a diff/stub instead of a complete file.
 * Writing these to disk is what wiped api/agent-chat.js and caused HTTP 500s.
 */
export function looksLikeIncompleteFileContent(content: string, filePath = ''): boolean {
  return incompleteFileReason(content, filePath) != null;
}

/** Default relative path when the model omits `File:` but emits a clear fence. */
export function defaultPathForLang(lang: string, used: Set<string>): string {
  const l = (lang || '').toLowerCase().replace(/^\./, '');
  const pick = (base: string) => {
    if (!used.has(base)) return base;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let i = 2;
    while (used.has(`${stem}${i}${ext}`)) i += 1;
    return `${stem}${i}${ext}`;
  };
  if (l === 'html' || l === 'htm') return pick('index.html');
  if (l === 'css' || l === 'scss' || l === 'less') return pick('styles.css');
  if (l === 'javascript' || l === 'js' || l === 'jsx') return pick('app.js');
  if (l === 'typescript' || l === 'ts') return pick('app.ts');
  if (l === 'tsx') return pick('App.tsx');
  if (l === 'python' || l === 'py') return pick('main.py');
  if (l === 'json') return pick('data.json');
  if (l === 'md' || l === 'markdown') return pick('README.md');
  if (l === 'go') return pick('main.go');
  if (l === 'rust' || l === 'rs') return pick('src/main.rs');
  if (l === 'java') return pick('Main.java');
  if (l === 'c') return pick('main.c');
  if (l === 'cpp' || l === 'c++' || l === 'cc') return pick('main.cpp');
  if (l === 'sh' || l === 'bash' || l === 'shell') return pick('script.sh');
  if (l === 'svg') return pick('image.svg');
  // Unknown / empty lang — only promote when content clearly looks like HTML.
  return pick('snippet.txt');
}

/**
 * When the model forgot `File:` headers but clearly dumped complete code fences
 * (common on "write a hello world page"), promote those fences to files so the
 * sandbox actually receives them. Never runs when any File: block was present.
 */
export function promoteBareFencesToFiles(text: string, report: FileChangeReport): FileChangeReport {
  if (report.accepted.length > 0 || report.rejected.length > 0) return report;
  // Explicit File: markers means the model tried the protocol — don't invent.
  if (/\bFile:\s*\S+/i.test(text)) return report;

  const fenceRe = /```([a-zA-Z0-9_+\-.]*)\s*\r?\n([\s\S]*?)```/g;
  const accepted: FileChange[] = [];
  const rejected: RejectedFileChange[] = [];
  const used = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const lang = (m[1] || '').trim();
    const content = m[2] || '';
    if (!content.trim()) continue;
    // Skip tiny prose fences / one-liners that aren't real files.
    if (content.trim().length < 20 && !lang) continue;
    let path = defaultPathForLang(lang, used);
    // Empty lang but looks like HTML → index.html
    if ((!lang || lang === 'txt') && /^\s*</.test(content) && /<\/[a-z]/i.test(content)) {
      path = defaultPathForLang('html', used);
    }
    used.add(path);
    const reason = incompleteFileReason(content, path);
    if (reason) rejected.push({ path, reason });
    else accepted.push({ path, content });
  }
  if (!accepted.length && !rejected.length) return report;
  return { accepted, rejected };
}

/** Parse LLM output; return accepted full files + rejected stubs with reasons. */
export function extractFileChangeReport(text: string): FileChangeReport {
  const accepted: FileChange[] = [];
  const rejected: RejectedFileChange[] = [];
  // Match: File: <path> then optional blank line then ```lang\ncontent```
  // Also tolerates **File:** / *File:* markdown emphasis and CRLF.
  const re =
    /^[*_]*File:\s*(.+?)[*_]*\s*\r?\n(?:\r?\n)?```[a-zA-Z0-9_+\-.]*\r?\n([\s\S]*?)```/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filePath = m[1]!.trim().replace(/^[`'"]+|[`'"]+$/g, '');
    const content  = m[2]!;
    if (!filePath || filePath.includes('\n')) continue;
    const reason = incompleteFileReason(content, filePath);
    if (reason) {
      rejected.push({ path: filePath, reason });
    } else {
      accepted.push({ path: filePath, content });
    }
  }
  return { accepted, rejected };
}

/**
 * Extract files for writing: prefer explicit File: blocks; on apply turns,
 * also promote bare code fences when the model forgot the header.
 */
export function extractFilesForApply(text: string, opts?: { promoteBare?: boolean }): FileChangeReport {
  const report = extractFileChangeReport(text);
  if (opts?.promoteBare) return promoteBareFencesToFiles(text, report);
  return report;
}

/** Parse LLM output for "File: path\\n```lang\\ncontent```" blocks (accepted only). */
export function extractFileChanges(text: string): FileChange[] {
  return extractFileChangeReport(text).accepted;
}

/** Loud chat warning when stubs were blocked from touching the sandbox. */
export function formatRejectedSandboxWarning(rejected: RejectedFileChange[]): string {
  if (!rejected.length) return '';
  const lines = rejected.map(r => `• ${r.path} — ${r.reason}`);
  return [
    '⛔ SANDBOX PROTECTED — incomplete File: blocks were NOT saved.',
    'Stubs / patches degrade this sandbox and have broken production before.',
    'Rewrite each file in FULL (every line) and try again:',
    ...lines,
  ].join('\n');
}

/** Old welcome blurb that poisoned the model into inventing fake tasks. */
export function looksLikeLegacyWelcome(text: string): boolean {
  return /Fix the auth token expiry|rate limiting to the \/api\/run|fetches GitHub stars/i.test(text);
}

/**
 * User wants ideas / review / recommendations — NOT automatic code writes.
 * "suggest additions and fixes" must stay here.
 */
export function looksLikeSuggestRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 4) return false;
  return /\b(suggest|suggestion|recommend|recommendation|advice|advise|ideas?|feedback|audit|review|assess(?:ment)?|analy[sz]e|inspect|improvements?|additions?|what should|how (can|should|would)|tell me what|look at (the )?repo|read (the )?repo|what('?s| is) wrong)\b/.test(t);
}

/** Explicit permission to write files into the sandbox. */
export function looksLikeApplyRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 4) return false;
  // Suggest/review language wins — unless the user also explicitly says apply.
  if (looksLikeSuggestRequest(t)) {
    return /\b(apply (it|them|this|the changes|that)|implement (it|them|this|now)|go ahead and (fix|change|write|apply)|do it now|write (the|it|them)|save (it|them|the fix)|put it in (the )?(repo|sandbox|files?))\b/.test(t);
  }
  // Common coding asks people actually type ("write a…", "code a…", "make a…").
  return /\b(apply|implement|write (the|a|an|me|my|us|our|some|this|that)|write\b.{0,40}\b(page|app|site|file|component|script|function|endpoint|api|html|css|js)|code (a|an|the|me|my|this|that)|do it|go ahead|ship it|save (it|the)|patch it|fix (it|this|my|the|a|an)|build|create|add|update|refactor|rewrite|replace|delete|remove|rename|make (the|a|an|me|my|us|our|this|that)|generate (a|an|the|me|my)|scaffold|bootstrap)\b/.test(t);
}

/** @deprecated use looksLikeSuggestRequest */
export function looksLikeAuditRequest(text: string): boolean {
  return looksLikeSuggestRequest(text);
}

/** @deprecated use looksLikeApplyRequest — kept for older imports/tests */
export function looksLikeWorkRequest(text: string): boolean {
  return looksLikeApplyRequest(text);
}

/**
 * Small talk / meta questions should NOT pull repo files into the prompt.
 */
export function needsCodeContext(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (looksLikeSuggestRequest(t) || looksLikeApplyRequest(t)) return true;
  if (/\b(repo|codebase|project|file|function|bug|error|stack|crash|endpoint|api|component|where is|how does|why (is|does)|show me|find)\b/.test(t)) {
    return true;
  }
  if (t.length <= 40 && /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|great|sure|yes|no|yep|nope|what can you do|who are you|help)\b/.test(t)) {
    return false;
  }
  return t.length >= 24 || /\b(please|can you|could you|would you)\b/.test(t);
}

/** Only used when the user explicitly asked to apply/write. */
export const NUDGE_PROMPT =
  'STOP. You did not output any usable File: blocks, so nothing was written.\n' +
  'NEVER degrade the sandbox with stubs, diffs, or “… existing …” comments.\n' +
  'Output COMPLETE file(s) now — every line of each file:\n\n' +
  'File: <relative-path>\n' +
  '```lang\n' +
  '<full file content — no omissions>\n' +
  '```';

export function nudgeAfterRejects(rejected: RejectedFileChange[]): string {
  const detail = rejected.map(r => `- ${r.path}: ${r.reason}`).join('\n');
  return (
    'STOP. Your File: blocks were REJECTED to protect the sandbox.\n' +
    'Nothing was saved. Incomplete patches have wiped production APIs before.\n' +
    `${detail}\n\n` +
    'Output each file again in FULL — every import, every function, no ellipses:\n\n' +
    'File: <relative-path>\n' +
    '```lang\n' +
    '<complete file>\n' +
    '```'
  );
}
