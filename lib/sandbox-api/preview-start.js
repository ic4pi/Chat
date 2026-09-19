/**
 * POST /api/preview-start
 * Body: { command?: string, port?: number }  — defaults: auto-detect / 3000
 *
 * Starts (or restarts) a dev server *detached* inside the sandbox, so it
 * outlives this request — unlike /api/run, which is SSE-streamed and tied to
 * the connection that launched it (fine for one-off commands, wrong for a
 * long-running server). Returns the sandbox's public domain for that port so
 * the client can render a live preview.
 *
 * No command typed → auto-detect. Most generated projects are a plain
 * index.html with no build step; forcing "npm run dev" on those just
 * fails silently (no dev script) and Preview never shows anything.
 */

import { requireSession, REPO_DIR, ensureNodeStack } from '../sandbox-session.js';

const DEFAULT_PORT = 3000;

/** Single-quote for safe embedding inside `sh -c '...'`. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { command, port } = req.body || {};
  const explicitCmd = typeof command === 'string' && command.trim() ? command.trim() : '';
  const p = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;

  try {
    const sandbox = await requireSession(req);

    // A generated Node project (Vite/React/Next/etc.) has no node_modules
    // until something installs it — nothing else in the pipeline ever did,
    // so "npm run dev" died instantly on every fresh scaffold. Install first
    // whenever the command we're about to run actually needs it.
    let pkg = null;
    try {
      const pkgRes = await sandbox.runCommand({ cmd: 'cat', args: [`${REPO_DIR}/package.json`] });
      if ((pkgRes.exitCode ?? 1) === 0) pkg = JSON.parse(await pkgRes.stdout());
    } catch { /* no/invalid package.json — treat as absent */ }

    const scripts = pkg?.scripts || {};
    const explicitUsesNpm = explicitCmd && /(^|[\s;/|&])(npm|npx|yarn|pnpm)([\s;/|&]|$)/i.test(explicitCmd);
    const autoWillUseNpm = !explicitCmd && (scripts.dev || scripts.start);

    if (pkg && (explicitUsesNpm || autoWillUseNpm)) {
      const node = await ensureNodeStack(sandbox);
      if (!node.ok) {
        return res.status(500).json({
          error: `Dependencies failed to install (npm install): ${node.error || 'unknown error'}`,
        });
      }
    }

    const pidFile = `/tmp/.preview-${p}.pid`;
    const logFile = `/tmp/.preview-${p}.log`;

    const resolveCmd = explicitCmd
      ? `RUN_CMD=${shQuote(explicitCmd)}`
      : [
          `if [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{}).dev?0:1)" >/dev/null 2>&1; then`,
          `  RUN_CMD="npm run dev"`,
          `elif [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{}).start?0:1)" >/dev/null 2>&1; then`,
          `  RUN_CMD="npm start"`,
          `elif command -v python3 >/dev/null 2>&1; then`,
          `  RUN_CMD="python3 -m http.server ${p}"`,
          `else`,
          `  RUN_CMD="npx --yes serve -l ${p} ."`,
          `fi`,
        ].join('\n');

    // Kill whatever this endpoint previously started on this port (makes
    // "start" idempotently double as "restart"), then launch the new command
    // detached so it survives past this request. Lines, not `&&` — chaining
    // a backgrounded (`&`) command with `&&` mis-parses the following steps.
    const script = [
      'set -e',
      `if [ -f ${pidFile} ]; then kill -9 "$(cat ${pidFile})" 2>/dev/null || true; rm -f ${pidFile}; fi`,
      `cd ${REPO_DIR}`,
      resolveCmd,
      `nohup sh -c "$RUN_CMD" > ${logFile} 2>&1 &`,
      `echo $! > ${pidFile}`,
      `echo "RUN_CMD=$RUN_CMD"`,
      'sleep 0.8',
      `if ! kill -0 "$(cat ${pidFile})" 2>/dev/null; then`,
      `  echo "PREVIEW_DEAD"`,
      `  tail -n 40 ${logFile} || true`,
      `  exit 42`,
      `fi`,
    ].join('\n');

    const result = await sandbox.runCommand({ cmd: 'bash', args: ['-lc', script] });
    const out = String((await result.stdout()) || '');
    const err = String((await result.stderr()) || '');
    const usedCmd = /RUN_CMD=(.*)$/m.exec(out)?.[1] || explicitCmd || 'auto';

    if (result.exitCode !== 0) {
      const tail = (out + '\n' + err).trim().slice(0, 800);
      return res.status(500).json({
        error: `Preview did not stay up (command: ${usedCmd}). ${tail || `exit ${result.exitCode}`}`,
        command: usedCmd,
      });
    }

    return res.json({ url: sandbox.domain(p), port: p, command: usedCmd });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
