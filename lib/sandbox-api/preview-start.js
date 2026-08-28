/**
 * POST /api/preview-start
 * Body: { command?: string, port?: number }  — defaults: 'npm run dev' / 3000
 *
 * Starts (or restarts) a dev server *detached* inside the sandbox, so it
 * outlives this request — unlike /api/run, which is SSE-streamed and tied to
 * the connection that launched it (fine for one-off commands, wrong for a
 * long-running server). Returns the sandbox's public domain for that port so
 * the client can render a live preview.
 */

import { requireSession, REPO_DIR } from '../sandbox-session.js';

const DEFAULT_COMMAND = 'npm run dev';
const DEFAULT_PORT = 3000;

/** Single-quote for safe embedding inside `sh -c '...'`. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { command, port } = req.body || {};
  const cmd = typeof command === 'string' && command.trim() ? command.trim() : DEFAULT_COMMAND;
  const p = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;

  try {
    const sandbox = await requireSession(req);

    const pidFile = `/tmp/.preview-${p}.pid`;
    const logFile = `/tmp/.preview-${p}.log`;
    // Kill whatever this endpoint previously started on this port (makes
    // "start" idempotently double as "restart"), then launch the new command
    // detached so it survives past this request. Lines, not `&&` — chaining
    // a backgrounded (`&`) command with `&&` mis-parses the following steps.
    const script = [
      'set -e',
      `if [ -f ${pidFile} ]; then kill -9 "$(cat ${pidFile})" 2>/dev/null || true; rm -f ${pidFile}; fi`,
      `cd ${REPO_DIR}`,
      `nohup sh -c ${shQuote(cmd)} > ${logFile} 2>&1 &`,
      `echo $! > ${pidFile}`,
    ].join('\n');

    const result = await sandbox.runCommand({ cmd: 'bash', args: ['-lc', script] });
    if (result.exitCode !== 0) {
      return res.status(500).json({ error: `Could not start preview (exit ${result.exitCode})` });
    }

    return res.json({ url: sandbox.domain(p), port: p, command: cmd });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
