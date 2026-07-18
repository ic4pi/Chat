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

/** True when the user clearly wants code written, not a conversational answer. */
export function looksLikeWorkRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (t.length < 4) return false;
  return /\b(fix|build|implement|create|add|write|update|refactor|change|make|generate|patch|repair|ship|code|app|feature|bug|error|fail|broken|improve|rewrite|replace|delete|remove|rename)\b/.test(t);
}

export const NUDGE_PROMPT =
  'STOP. You did not output any File: blocks, so nothing was written to disk.\n' +
  'Do the work NOW. Output complete file(s) using exactly this format — no plan, no "I will":\n\n' +
  'File: <relative-path>\n' +
  '```lang\n' +
  '<full file content>\n' +
  '```';
