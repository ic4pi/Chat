/**
 * One place that turns a client-supplied relative path into an absolute path
 * inside the sandbox repo — or refuses.
 *
 * The previous per-handler check was `abs.startsWith(REPO_DIR + '/')`, applied
 * to an unnormalized string. That passes for `/vercel/sandbox/repo/../../etc/passwd`:
 * the prefix is intact, the escape happens after it. Normalizing first is what
 * makes the prefix check mean anything.
 *
 * Callers must pass the result to runCommand as an argv element, never
 * interpolated into a `bash -c` string — see the note in each handler.
 */

import path from 'node:path';
import { REPO_DIR } from './sandbox-session.js';

/**
 * @returns {{ ok: true, abs: string, rel: string } | { ok: false, error: string }}
 */
export function resolveRepoPath(relPath) {
  const raw = String(relPath ?? '').trim();
  if (!raw) return { ok: false, error: 'path required' };

  // Absolute paths and Windows-style separators are never valid input here.
  if (raw.startsWith('/')) return { ok: false, error: 'Path must be relative to the repo root' };
  if (raw.includes('\0')) return { ok: false, error: 'Path contains a null byte' };

  const abs = path.posix.normalize(`${REPO_DIR}/${raw.replace(/\\/g, '/')}`);
  if (abs !== REPO_DIR && !abs.startsWith(`${REPO_DIR}/`)) {
    return { ok: false, error: 'Path traversal rejected' };
  }
  return { ok: true, abs, rel: abs.slice(REPO_DIR.length + 1) };
}
