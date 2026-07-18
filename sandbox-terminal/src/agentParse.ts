/**
 * Pure helpers for coding-agent replies: File: block extraction and
 * "does this user message want code written?" detection.
 */

export interface FileChange {
  path: string;
  content: string;
}

/** Parse LLM output for "File: path\\n```lang\\ncontent```" blocks. */
export function extractFileChanges(text: string): FileChange[] {
  const changes: FileChange[] = [];
  // Match: File: <path> then optional blank line then ```lang\ncontent```
  // Also tolerates **File:** / *File:* markdown emphasis and CRLF.
  const re =
    /^[*_]*File:\s*(.+?)[*_]*\s*\r?\n(?:\r?\n)?```[a-zA-Z0-9_+\-.]*\r?\n([\s\S]*?)```/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filePath = m[1]!.trim().replace(/^[`'"]+|[`'"]+$/g, '');
    const content  = m[2]!;
    if (filePath && !filePath.includes('\n')) {
      changes.push({ path: filePath, content });
    }
  }
  return changes;
}

/** True when the user wants a repo audit/review (prose assessment), not file writes. */
export function looksLikeAuditRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 4) return false;
  return /\b(audit|review|assess(?:ment)?|analy[sz]e|inspect|look at (the )?repo|read (the )?repo|what('?s| is) wrong|recommend(?:ed)? (changes|fixes))\b/.test(t);
}

/** True when the user clearly wants code written, not a conversational answer. */
export function looksLikeWorkRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 4) return false;
  // Audits/reviews should stay prose — don't force File: blocks.
  if (looksLikeAuditRequest(t) && !/\b(fix|implement|apply|patch|rewrite|refactor)\b/.test(t)) {
    return false;
  }
  return /\b(fix|build|implement|create|add|write|update|refactor|change|make|generate|patch|repair|ship|code|app|feature|bug|error|fail|broken|improve|rewrite|replace|delete|remove|rename)\b/.test(t);
}

/**
 * Small talk / meta questions should NOT pull repo files into the prompt.
 * That's how Cursor/Claude stay cheap on "hey" while still having the whole
 * project available when you ask for a fix.
 */
export function needsCodeContext(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (looksLikeAuditRequest(t) || looksLikeWorkRequest(t)) return true;
  // Explicit code/project questions
  if (/\b(repo|codebase|project|file|function|bug|error|stack|crash|endpoint|api|component|where is|how does|why (is|does)|show me|find)\b/.test(t)) {
    return true;
  }
  // Very short chit-chat / acknowledgements
  if (t.length <= 40 && /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|great|sure|yes|no|yep|nope|what can you do|who are you|help)\b/.test(t)) {
    return false;
  }
  // Default: if they typed a real sentence and a repo is open, look at code.
  // Short fragments without code intent stay light.
  return t.length >= 24 || /\b(please|can you|could you|would you)\b/.test(t);
}

export const NUDGE_PROMPT =
  'STOP. You did not output any File: blocks, so nothing was written to disk.\n' +
  'Do the work NOW. Output complete file(s) using exactly this format — no plan, no "I will":\n\n' +
  'File: <relative-path>\n' +
  '```lang\n' +
  '<full file content>\n' +
  '```';
