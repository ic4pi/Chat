/**
 * useAutoVerify — the auto-test-and-fix loop.
 *
 * After a file change is applied to disk, call verify(). It will:
 *   1. Detect the project's test command (from package.json / static smoke / etc).
 *   2. Run it in the sandbox terminal, stream output, capture exit code.
 *   3. Pass → verifyState 'passed' (Push may unlock).
 *   4. Fail → inject failure into chat, apply File: fixes, retry.
 *   5. Exhaust attempts → 'failed' (Push stays locked).
 *
 * Push must NOT be offered unless verifyState === 'passed'.
 */

import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TerminalHandle } from './Terminal.js';
import type { ChatHandle }    from './ChatPane.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

const MAX_ATTEMPTS = 5;
const MAX_OUTPUT_CHARS = 3_500;

export type VerifyState =
  | 'idle'
  | 'detecting'
  | 'running'
  | 'passed'
  | `retry-${number}`
  | 'failed';

interface DetectedTest {
  command: string | null;
  source:  string | null;
  confidence: 'detected' | 'guessed' | 'none';
  note?: string;
}

export function useAutoVerify(
  repoRoot:   string,
  sandboxId:  string | null,
  termRef:    RefObject<TerminalHandle>,
  chatRef:    RefObject<ChatHandle>,
  applyChanges: (files?: Array<{ path: string; content: string; original?: string }>) =>
    Promise<Array<{ path: string; ok: boolean; error?: string }>>,
) {
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [attempt,     setAttempt]     = useState(0);
  const [testCommand, setTestCommand] = useState<string | null>(null);
  const [askCommand,  setAskCommand]  = useState(false);
  const [lastFailDetail, setLastFailDetail] = useState<string | null>(null);
  const cachedCmd = useRef<string | null>(null);
  // Invalidate cache when sandbox/repo changes
  const cacheKey = useRef<string>('');

  const resolveTestCommand = useCallback(async (): Promise<string | null> => {
    const key = `${sandboxId || ''}::${repoRoot || ''}`;
    if (cacheKey.current !== key) {
      cacheKey.current = key;
      cachedCmd.current = null;
    }
    if (cachedCmd.current) return cachedCmd.current;
    if (!repoRoot && !sandboxId) return null;

    setVerifyState('detecting');
    try {
      const headers: Record<string, string> = {};
      if (sandboxId) headers['X-Sandbox-Session'] = sandboxId;
      const qs = repoRoot ? `?root=${encodeURIComponent(repoRoot)}` : '';
      const res = await fetch(`${API_URL}/detect-test-command${qs}`, { headers });
      const data = await res.json() as DetectedTest & { error?: string };
      if (data.command) {
        cachedCmd.current = data.command;
        setTestCommand(data.command);
        setAskCommand(false);
        return data.command;
      }
    } catch { /* fall through */ }

    setAskCommand(true);
    return null;
  }, [repoRoot, sandboxId]);

  const setCustomCommand = useCallback((cmd: string) => {
    cachedCmd.current = cmd;
    setTestCommand(cmd);
    setAskCommand(false);
  }, []);

  const verify = useCallback(async (): Promise<'passed' | 'failed' | 'idle'> => {
    if (!termRef.current || !chatRef.current) return 'idle';

    const cmd = await resolveTestCommand();
    if (!cmd) {
      setVerifyState('failed');
      setLastFailDetail(
        'No test/smoke command found. Add npm test / npm run check, or an index.html for the built-in static smoke.',
      );
      return 'failed';
    }

    setAttempt(0);
    setLastFailDetail(null);

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      setAttempt(i);
      setVerifyState('running');

      const { exitCode, output } = await termRef.current.runCommand(cmd);

      if (exitCode === 0) {
        setVerifyState('passed');
        setLastFailDetail(null);
        return 'passed';
      }

      const truncated = output.length > MAX_OUTPUT_CHARS
        ? '…(truncated)…\n' + output.slice(-MAX_OUTPUT_CHARS)
        : output;
      setLastFailDetail(truncated.trim().slice(0, 800));

      if (i === MAX_ATTEMPTS) {
        setVerifyState('failed');
        return 'failed';
      }

      setVerifyState(`retry-${i}`);

      const failureMsg =
        `Tests/smoke FAILED (attempt ${i}/${MAX_ATTEMPTS}, exit ${exitCode}).\n` +
        `Do NOT claim the site is done. Do NOT suggest Push yet.\n\n` +
        `Command: \`${cmd.slice(0, 120)}${cmd.length > 120 ? '…' : ''}\`\n\n` +
        `Output:\n\`\`\`\n${truncated.trim()}\n\`\`\`\n\n` +
        `Fix every failure. Output complete File: blocks only (full files). ` +
        `Make the page look finished: real title, working CSS, readable layout, no broken links.`;

      const changes = await chatRef.current.programmaticSend(failureMsg, 'retry-inject');

      if (changes.length > 0) {
        await applyChanges(changes);
      }
    }

    setVerifyState('failed');
    return 'failed';
  }, [resolveTestCommand, termRef, chatRef, applyChanges]);

  const reset = useCallback(() => {
    setVerifyState('idle');
    setAttempt(0);
    setLastFailDetail(null);
  }, []);

  /** Push is only honest after a green verify this session. */
  const pushAllowed = verifyState === 'passed';

  return {
    verify,
    reset,
    verifyState,
    attempt,
    testCommand,
    askCommand,
    setCustomCommand,
    pushAllowed,
    lastFailDetail,
  };
}
