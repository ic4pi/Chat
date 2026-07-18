/**
 * Pure helpers for coding-agent replies: File: block extraction and
 * intent detection (suggest vs apply).
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
  'STOP. You did not output any File: blocks, so nothing was written.\n' +
  'The user asked you to APPLY changes. Output complete file(s) now:\n\n' +
  'File: <relative-path>\n' +
  '```lang\n' +
  '<full file content>\n' +
  '```';
