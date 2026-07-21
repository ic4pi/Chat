/**
 * POST /api/run-code  (SSE — maxDuration: 300)
 * Body: { code: string, language: string, timeoutMs?: number }
 * Writes the code to a file in the sandbox and runs the appropriate interpreter.
 */

import { setupSSE, sseEvent } from '../lib/sse.js';
import { requireSession, ensurePythonStack, REPO_DIR, VENV_DIR } from '../lib/sandbox-session.js';

const DEFAULT_TIMEOUT = 2 * 60 * 1000;

const LANG_CONFIG = {
  python: { ext: '.py', runner: ['python3'], needsPython: true },
  py:     { ext: '.py', runner: ['python3'], needsPython: true },
  javascript: { ext: '.js', runner: ['node'] },
  js:         { ext: '.js', runner: ['node'] },
  typescript: { ext: '.ts', runner: ['npx', 'ts-node', '--skipProject'] },
  ts:         { ext: '.ts', runner: ['npx', 'ts-node', '--skipProject'] },
  bash: { ext: '.sh', runner: ['bash'] },
  sh:   { ext: '.sh', runner: ['bash'] },
  ruby: { ext: '.rb', runner: ['ruby'] },
};
const DEFAULT_LANG = { ext: '.sh', runner: ['bash'] };

export default async function handler(req, res) {
  if (!setupSSE(res, req)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { code, language, timeoutMs } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });

  const lang   = (language || '').toLowerCase().trim();
  const config = LANG_CONFIG[lang] ?? DEFAULT_LANG;
  const timeout = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`Timed out after ${timeout / 1000}s`)), timeout);
  let streamDone = false;
  res.on('close', () => { if (!streamDone && !abort.signal.aborted) abort.abort(new Error('Client disconnected')); });

  try {
    const sandbox = await requireSession(req);
    sseEvent(res, 'status', `Running ${lang || 'bash'} in sandbox ${sandbox.name}`);

    if (config.needsPython) {
      sseEvent(res, 'status', 'Ensuring Python + pip…');
      const py = await ensurePythonStack(sandbox);
      if (!py.ok) {
        sseEvent(res, 'stderr', `Python setup failed: ${py.error || 'unknown'}\n`);
      } else if (!py.already) {
        sseEvent(res, 'status', py.detail || 'Python ready');
      }
    }

    const filename = `_snippet${config.ext}`;
    await sandbox.writeFiles([{ path: `/tmp/${filename}`, content: Buffer.from(code, 'utf8') }]);

    // Prefer the sandbox venv interpreter when present.
    let runner = config.runner;
    if (config.needsPython) {
      const venvPy = await sandbox.runCommand({
        cmd: 'bash',
        args: ['-lc', `test -x ${VENV_DIR}/bin/python && echo yes || echo no`],
      });
      const out = typeof venvPy.stdout === 'function' ? (await venvPy.stdout()).trim() : '';
      if (out === 'yes') runner = [`${VENV_DIR}/bin/python`];
    }

    const [cmd, ...args] = runner;
    const sdxCmd = await sandbox.runCommand({
      cmd, args: [...args, `/tmp/${filename}`],
      cwd: REPO_DIR,
      detached: true,
    });

    try {
      for await (const log of sdxCmd.logs({ signal: abort.signal })) {
        sseEvent(res, log.stream, log.data);
      }
    } catch (logErr) {
      if (abort.signal.aborted) {
        await sdxCmd.kill('SIGTERM').catch(() => {});
        sseEvent(res, 'timeout', abort.signal.reason?.message ?? 'Aborted');
        return;
      }
      throw logErr;
    }

    const finished = await sdxCmd.wait();
    sseEvent(res, 'exit', String(finished.exitCode ?? 0));

  } catch (err) {
    sseEvent(res, 'error', err.message || String(err));
  } finally {
    streamDone = true;
    clearTimeout(timer);
    res.end();
  }
}
