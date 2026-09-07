/**
 * POST /api/preview-start
 * Body: { command?: string, port?: number }
 *
 * Starts (or restarts) a dev server *detached* inside the sandbox, so it
 * outlives this request — unlike /api/run, which is SSE-streamed and tied to
 * the connection that launched it (fine for one-off commands, wrong for a
 * long-running server). Returns the sandbox's public domain for that port so
 * the client can render a live preview.
 *
 * With no `command`, the project shape decides:
 *   package.json scripts.dev → npm run dev
 *   package.json scripts.start → npm start
 *   an index.html and no npm script → a built-in static file server
 * A blank Workspace that just built a plain HTML/CSS/JS app has no
 * package.json at all; hardcoding `npm run dev` meant preview could never
 * start for exactly the apps Workspace produces most often.
 *
 * The launched process is checked for liveness before we answer, and a dead
 * one returns its log tail — "started fine, blank pane" was indistinguishable
 * from a crash on the client.
 */

import { requireSession, REPO_DIR } from '../sandbox-session.js';
import {
  STATIC_SERVER_PATH,
  STATIC_SERVER_SOURCE,
  staticServeCommand,
} from './static-server.js';

const DEFAULT_PORT = 3000;
/** Long enough to catch an immediate crash, short enough not to stall the request. */
const LIVENESS_WAIT_MS = 1500;

/** Single-quote for safe embedding inside `sh -c '...'`. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function readFile(sandbox, absPath) {
  try {
    const r = await sandbox.runCommand({ cmd: 'bash', args: ['-lc', `cat ${shQuote(absPath)}`] });
    if ((r.exitCode ?? 1) !== 0) return null;
    return await r.stdout();
  } catch {
    return null;
  }
}

async function exists(sandbox, absPath) {
  try {
    const r = await sandbox.runCommand({ cmd: 'bash', args: ['-lc', `test -e ${shQuote(absPath)}`] });
    return (r.exitCode ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * Pick a start command from what is actually in the project.
 * Returns { command, source, static? } or null when nothing is previewable.
 */
async function detectCommand(sandbox, port) {
  const pkgRaw = await readFile(sandbox, `${REPO_DIR}/package.json`);
  if (pkgRaw) {
    let scripts = {};
    try {
      scripts = JSON.parse(pkgRaw).scripts ?? {};
    } catch { /* malformed package.json — fall through to the static check */ }

    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
    if (script) {
      const run = script === 'start' ? 'npm start' : `npm run ${script}`;
      // A fresh project has no node_modules; `npm run dev` would exit
      // immediately with "command not found" and leave an empty preview.
      const installed = await exists(sandbox, `${REPO_DIR}/node_modules`);
      return {
        command: installed ? run : `npm install --no-audit --no-fund && ${run}`,
        source: `package.json scripts.${script}${installed ? '' : ' (with npm install)'}`,
      };
    }
  }

  for (const dir of ['', 'public', 'dist', 'build', 'site']) {
    const rel = dir ? `${dir}/index.html` : 'index.html';
    if (await exists(sandbox, `${REPO_DIR}/${rel}`)) {
      const serveDir = dir ? `${REPO_DIR}/${dir}` : REPO_DIR;
      return {
        command: staticServeCommand(serveDir, port),
        source: `static site (${rel})`,
        static: true,
      };
    }
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { command, port } = req.body || {};
  const explicit = typeof command === 'string' && command.trim() ? command.trim() : null;
  const p = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;

  try {
    const sandbox = await requireSession(req);

    let cmd = explicit;
    let source = explicit ? 'command from the preview bar' : null;
    let isStatic = false;

    if (!cmd) {
      const detected = await detectCommand(sandbox, p);
      if (!detected) {
        return res.status(400).json({
          error:
            'Nothing to preview yet — no package.json dev/start script and no index.html in the project. ' +
            'Build the app first, or type an explicit command in the preview bar.',
        });
      }
      cmd = detected.command;
      source = detected.source;
      isStatic = !!detected.static;
    } else if (explicit.startsWith('node ' + STATIC_SERVER_PATH)) {
      isStatic = true;
    }

    // The static server lives in the sandbox as a real file so the command
    // stays short and hand-editable in the preview bar.
    if (isStatic) {
      await sandbox.writeFiles([
        { path: STATIC_SERVER_PATH, content: Buffer.from(STATIC_SERVER_SOURCE, 'utf8') },
      ]);
    }

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
      const err = await result.stderr();
      return res.status(500).json({
        error: `Could not start preview (exit ${result.exitCode})${err ? `: ${String(err).slice(0, 400)}` : ''}`,
      });
    }

    // Did it survive? A crash-on-boot used to be reported as success and
    // rendered as an empty iframe with no explanation anywhere.
    const check = await sandbox.runCommand({
      cmd: 'bash',
      args: [
        '-lc',
        [
          `sleep ${(LIVENESS_WAIT_MS / 1000).toFixed(1)}`,
          `if kill -0 "$(cat ${pidFile} 2>/dev/null)" 2>/dev/null; then echo ALIVE; else echo DEAD; fi`,
          `tail -c 1500 ${logFile} 2>/dev/null || true`,
        ].join('\n'),
      ],
    });
    const out = String((await check.stdout()) || '');
    const [status, ...logLines] = out.split('\n');
    const log = logLines.join('\n').trim();

    if (status.trim() === 'DEAD') {
      return res.status(500).json({
        error:
          `Preview command exited immediately: ${cmd}` +
          (log ? `\n\n${log.slice(-1200)}` : '\n\n(no output)'),
        command: cmd,
        source,
        log: log.slice(-1200),
      });
    }

    return res.json({
      url: sandbox.domain(p),
      port: p,
      command: cmd,
      source,
      log: log.slice(-1200) || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
