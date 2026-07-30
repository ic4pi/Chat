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
  // Suggest/review language wins — never treat as apply.
  if (looksLikeSuggestRequest(t)) {
    return /\b(apply (it|them|this|the changes)|implement (it|them|this|now)|go ahead and (fix|change|write)|do it now|write the (fix|code|files)|save (it|them|the fix))\b/.test(t);
  }
  return /\b(apply|implement|write the|do it|go ahead|ship it|save (it|the)|patch it|fix (it|this|my|the)|build|create|add|update|refactor|rewrite|replace|delete|remove|rename|make the)\b/.test(t);
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
