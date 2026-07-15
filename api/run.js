/**
 * POST /api/run  (SSE — maxDuration: 300)
 * Body: { command: string, timeoutMs?: number }
 * Runs a shell command in the sandbox repo dir and streams stdout/stderr.
 *
 * SSE events: status | stdout | stderr | exit | timeout | error
 * Each data field is a JSON-encoded string.
 */

import { Sandbox } from '@vercel/sandbox';
import { setupSSE, sseEvent } from '../lib/sse.js';
import { requireSession, REPO_DIR } from '../lib/sandbox-session.js';

const DEFAULT_TIMEOUT = 2 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { command, timeoutMs } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });

  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT;

  setupSSE(res);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`Timed out after ${timeout / 1000}s`)), timeout);
  let streamDone = false;
  res.on('close', () => { if (!streamDone && !abort.signal.aborted) abort.abort(new Error('Client disconnected')); });

  let sandbox = null;
  try {
    sandbox = await requireSession(req);
    sseEvent(res, 'status', `Running in sandbox ${sandbox.name}`);

    const cmd = await sandbox.runCommand({
      cmd: 'bash', args: ['-c', command],
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
