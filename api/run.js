/**
 * POST /api/run  (SSE — maxDuration: 300)
 * Body: { command: string, timeoutMs?: number }
 * Runs a shell command in the sandbox repo dir and streams stdout/stderr.
 *
 * SSE events: status | stdout | stderr | exit | timeout | error
 * Each data field is a JSON-encoded string.
 *
 * PATH always prefers the sandbox venv so `python` / `pip` work after Open repo.
 * Commands that look like Python/pip also force ensurePythonStack first.
 */

import { setupSSE, sseEvent } from '../lib/sse.js';
import {
  requireSession,
  ensurePythonStack,
  REPO_DIR,
  venvPathExport,
} from '../lib/sandbox-session.js';

const DEFAULT_TIMEOUT = 2 * 60 * 1000;
const PY_CMD_RE = /(^|[\s;/|&])(python3?|pip3?|pyvenv|venv)([\s;/|&]|$)/i;

export default async function handler(req, res) {
  if (!setupSSE(res, req)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { command, timeoutMs } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });

  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`Timed out after ${timeout / 1000}s`)), timeout);
  let streamDone = false;
  res.on('close', () => { if (!streamDone && !abort.signal.aborted) abort.abort(new Error('Client disconnected')); });

  let sandbox = null;
  try {
    sandbox = await requireSession(req);
    sseEvent(res, 'status', `Running in sandbox ${sandbox.name}`);

    if (PY_CMD_RE.test(command)) {
      sseEvent(res, 'status', 'Ensuring Python + pip (venv)…');
      const py = await ensurePythonStack(sandbox);
      if (!py.ok) {
        sseEvent(res, 'stderr', `Python setup failed: ${py.error || 'unknown'}\n`);
        sseEvent(res, 'exit', '1');
        return;
      }
      if (!py.already) {
        sseEvent(res, 'status', py.detail || 'Python ready');
      }
    }

    // Always prepend venv so python/pip resolve even when the model forgot to activate.
    const wrapped = `${venvPathExport()}; cd ${REPO_DIR} && ${command}`;

    const cmd = await sandbox.runCommand({
      cmd: 'bash', args: ['-lc', wrapped],
      cwd: REPO_DIR,
      detached: true,
    });

    try {
      for await (const log of cmd.logs({ signal: abort.signal })) {
        sseEvent(res, log.stream, log.data);
      }
    } catch (logErr) {
      if (abort.signal.aborted) {
        await cmd.kill('SIGTERM').catch(() => {});
        sseEvent(res, 'timeout', abort.signal.reason?.message ?? 'Aborted');
        return;
      }
      throw logErr;
    }

    const finished = await cmd.wait();
    sseEvent(res, 'exit', String(finished.exitCode ?? 0));

  } catch (err) {
    sseEvent(res, 'error', err.message || String(err));
  } finally {
    streamDone = true;
    clearTimeout(timer);
    res.end();
  }
}
