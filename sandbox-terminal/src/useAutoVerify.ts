/**
 * useAutoVerify — the auto-test-and-fix loop.
 *
 * After a file change is applied to disk, call verify(). It will:
 *   1. Detect the project's test command (from package.json / pyproject.toml / etc).
 *      If detection fails, ask the user once and remember the answer.
 *   2. Run the test command via termRef.current.runCommand() — this streams
 *      output to the xterm terminal in real time AND captures it for the loop.
 *   3. If tests pass (exit code 0) → stop, report success.
 *   4. If tests fail:
 *      a. Truncate the failure output to fit in the context window (~3 000 chars).
 *      b. Call chatRef.current.programmaticSend() with the failure message.
 *      c. Apply whatever file changes the model proposes.
 *      d. Repeat from step 2.
 *   5. After MAX_ATTEMPTS without passing → stop, report final failure.
 *
 * State exposed:
 *   verifyState  — 'idle' | 'running' | 'passed' | 'failed' | `retry-N`
 *   attempt      — current attempt number (1-based, 0 when idle)
 *   testCommand  — the command being used
 */

import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TerminalHandle } from './Terminal.js';
import type { ChatHandle }    from './ChatPane.js';

const API_URL =
  (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3001';

const MAX_ATTEMPTS = 3;
// How many chars of test output to feed back — enough to capture failures
// without blowing past the model's context window.
const MAX_OUTPUT_CHARS = 3_000;

export type VerifyState =
  | 'idle'
  | 'detecting'     // reading project files to find test command
  | 'running'       // tests are running
  | 'passed'        // all tests pass
  | `retry-${number}` // tests failed, injecting into chat for attempt N
  | 'failed';       // exhausted max attempts

interface DetectedTest {
  command: string | null;
  source:  string | null;
  confidence: 'detected' | 'guessed' | 'none';
}

export function useAutoVerify(
  repoRoot:   string,
  termRef:    RefObject<TerminalHandle>,
  chatRef:    RefObject<ChatHandle>,
  applyChanges: () => Promise<Array<{ path: string; ok: boolean; error?: string }>>,
) {
  const [verifyState, setVerifyState] = useState<VerifyState>('idle');
  const [attempt,     setAttempt]     = useState(0);
  const [testCommand, setTestCommand] = useState<string | null>(null);
  const [askCommand,  setAskCommand]  = useState(false);
  // Persisted across calls within the same session (avoid re-detecting every time)
  const cachedCmd = useRef<string | null>(null);

  // ── detect or use cached command ─────────────────────────────────────────
  const resolveTestCommand = useCallback(async (): Promise<string | null> => {
    if (cachedCmd.current) return cachedCmd.current;
    if (!repoRoot) return null;

    setVerifyState('detecting');
    try {
      const res = await fetch(
        `${API_URL}/detect-test-command?root=${encodeURIComponent(repoRoot)}`
      );
      const data = await res.json() as DetectedTest;
      if (data.command) {
        cachedCmd.current = data.command;
        setTestCommand(data.command);
        return data.command;
      }
    } catch { /* fall through */ }

    // No command detected — show the ask-user dialog
    setAskCommand(true);
    return null;
  }, [repoRoot]);

  // Called by the UI when the user types a custom test command
  const setCustomCommand = useCallback((cmd: string) => {
    cachedCmd.current = cmd;
    setTestCommand(cmd);
    setAskCommand(false);
  }, []);

  // ── main verify loop ──────────────────────────────────────────────────────
  const verify = useCallback(async () => {
    if (!termRef.current || !chatRef.current) return;

    const cmd = await resolveTestCommand();
    if (!cmd) return; // user hasn't answered the prompt yet

    setAttempt(0);

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      setAttempt(i);
      setVerifyState('running');

      const { exitCode, output } = await termRef.current.runCommand(cmd);

      if (exitCode === 0) {
        setVerifyState('passed');
        return;
      }

      if (i === MAX_ATTEMPTS) {
        setVerifyState('failed');
        return;
      }

      // Tests failed — inject into chat for another fix attempt
      setVerifyState(`retry-${i}`);

      const truncated = output.length > MAX_OUTPUT_CHARS
        ? '…(truncated)…\n' + output.slice(-MAX_OUTPUT_CHARS)
        : output;

      const failureMsg =
        `Tests failed (attempt ${i}/${MAX_ATTEMPTS}, exit ${exitCode}).\n\n` +
        `Command: \`${cmd}\`\n\n` +
        `Output:\n\`\`\`\n${truncated.trim()}\n\`\`\`\n\n` +
        `Please fix the issue and output the complete corrected file(s) using the File: format.`;

      const changes = await chatRef.current.programmaticSend(failureMsg, 'retry-inject');

      if (changes.length > 0) {
        await applyChanges();
      }
      // Loop: run tests again
    }

    setVerifyState('failed');
  }, [resolveTestCommand, termRef, chatRef, applyChanges]);

  const reset = useCallback(() => {
    setVerifyState('idle');
    setAttempt(0);
  }, []);

  return {
    verify,
    reset,
    verifyState,
    attempt,
    testCommand,
    askCommand,
    setCustomCommand,
  };
}
