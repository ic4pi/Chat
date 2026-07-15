/**
 * sandbox-runner — Express server that accepts a shell command, spins up a
 * Vercel Sandbox on demand, and streams stdout/stderr back to the caller over
 * Server-Sent Events as the output arrives.
 *
 * POST /run
 *   Body:    { "command": "bash -c '...'" }
 *   Optional: { "timeoutMs": 120000 }   (default: 2 minutes)
 *
 * SSE event stream (each event is a JSON-encoded line):
 *   event: status   data: "Creating sandbox…"
 *   event: stdout   data: "<chunk>"
 *   event: stderr   data: "<chunk>"
 *   event: exit     data: "<exit-code>"       — always last on success
 *   event: timeout  data: "<message>"         — instead of exit on timeout
 *   event: error    data: "<message>"         — instead of exit on hard error
 *
 * Note: the SDK method is runCommand({ detached: true }), not runCommandDetached.
 * The "detached" option makes runCommand return a Command object immediately so
 * we can iterate its .logs() async generator for real-time streaming.
 */

import express, { type Request, type Response } from 'express';
import { Sandbox } from '@vercel/sandbox';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

type SandboxAuth =
  | { token: string; teamId: string; projectId: string }
  | Record<string, never>; // empty → SDK uses VERCEL_OIDC_TOKEN automatically

function resolveSandboxAuth(): SandboxAuth {
  const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, VERCEL_OIDC_TOKEN } = process.env;

  if (VERCEL_TOKEN && VERCEL_TEAM_ID && VERCEL_PROJECT_ID) {
    return { token: VERCEL_TOKEN, teamId: VERCEL_TEAM_ID, projectId: VERCEL_PROJECT_ID };
  }
  if (VERCEL_OIDC_TOKEN) {
    // SDK picks this up from the environment automatically.
    return {};
  }
  throw new Error(
    'No Vercel credentials found.\n' +
    '  Option A (dev): run "vercel env pull" to get VERCEL_OIDC_TOKEN.\n' +
    '  Option B (server): set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.'
  );
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseEvent(res: Response, event: string, data: string): void {
  // Each SSE message: "event: <type>\ndata: <payload>\n\n"
  // Using named events lets clients filter with addEventListener('<event>', …).
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function setupSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Tell nginx / any proxy not to buffer the response.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.post('/run', async (req: Request, res: Response): Promise<void> => {
  const { command, timeoutMs } = req.body as {
    command?: unknown;
    timeoutMs?: unknown;
  };

  if (typeof command !== 'string' || !command.trim()) {
    res.status(400).json({ error: '"command" must be a non-empty string' });
    return;
  }

  const timeout =
    typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  setupSSE(res);

  // AbortController drives both the client-disconnect cancellation and the
  // command timeout. We pass its signal to command.logs() so the iterator
  // exits when either fires.
  const abort = new AbortController();

  const timeoutHandle = setTimeout(() => {
    abort.abort(new Error(`Command timed out after ${timeout / 1000}s`));
  }, timeout);

  // Abort if the client disconnects so we don't keep the sandbox alive.
  // IMPORTANT: use res.on('close'), NOT req.on('close'). In HTTP/1.1 the
  // request is "done" (and emits 'close') the moment the POST body is fully
  // received — long before the SSE response finishes. res.on('close') fires
  // when the underlying socket actually drops, i.e. a real client disconnect.
  let streamDone = false; // prevent the normal res.end() path from self-aborting
  res.on('close', () => {
    if (!streamDone && !abort.signal.aborted) {
      abort.abort(new Error('Client disconnected'));
    }
  });

  let sandbox: Sandbox | null = null;

  try {
    if (process.env['LOCAL_MODE'] === 'true') {
      // ----------------------------------------------------------------
      // LOCAL_MODE: bypass Vercel Sandbox and run the command directly
      // via child_process.spawn. Useful for verifying SSE streaming without
      // needing Vercel credentials. The SSE layer is identical to production.
      // ----------------------------------------------------------------
      sseEvent(res, 'status', '[LOCAL_MODE] running via child_process.spawn');

      await new Promise<void>((resolve, reject) => {
        const child = spawn('bash', ['-c', command], { stdio: 'pipe' });

        const abortListener = () => {
          child.kill('SIGTERM');
          sseEvent(res, 'timeout',
            abort.signal.reason instanceof Error
              ? abort.signal.reason.message
              : 'Aborted');
          resolve();
        };
        abort.signal.addEventListener('abort', abortListener, { once: true });

        child.stdout.on('data', (chunk: Buffer) => sseEvent(res, 'stdout', chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => sseEvent(res, 'stderr', chunk.toString()));

        child.on('error', (err) => {
          abort.signal.removeEventListener('abort', abortListener);
          reject(err);
        });

        child.on('close', (code) => {
          abort.signal.removeEventListener('abort', abortListener);
          if (!abort.signal.aborted) sseEvent(res, 'exit', String(code ?? 0));
          resolve();
        });
      });

    } else {
      // ----------------------------------------------------------------
      // PRODUCTION: Vercel Sandbox
      // ----------------------------------------------------------------
      const auth = resolveSandboxAuth();

      sseEvent(res, 'status', 'Creating sandbox…');

      sandbox = await Sandbox.create({
        ...auth,
        runtime: 'node24',
        timeout,
      });

      sseEvent(res, 'status', `Sandbox ready: ${sandbox.name}`);

      const cmd = await sandbox.runCommand({
        cmd: 'bash',
        args: ['-c', command],
        detached: true,
      });

      try {
        for await (const log of cmd.logs({ signal: abort.signal })) {
          sseEvent(res, log.stream, log.data);
        }
      } catch (logErr: unknown) {
        if (abort.signal.aborted) {
          await cmd.kill('SIGTERM').catch(() => { /* best effort */ });
          const reason =
            abort.signal.reason instanceof Error
              ? abort.signal.reason.message
              : 'Aborted';
          sseEvent(res, 'timeout', reason);
          return;
        }
        throw logErr;
      }

      const finished = await cmd.wait();
      sseEvent(res, 'exit', String(finished.exitCode ?? 0));
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sandbox-runner] error:', message);
    sseEvent(res, 'error', message);
  } finally {
    streamDone = true;        // mark done BEFORE res.end() so the 'close' listener
    clearTimeout(timeoutHandle); // doesn't mis-fire as a client disconnect
    if (sandbox) {
      sandbox.stop().catch((e: unknown) => {
        console.error('[sandbox-runner] sandbox.stop() failed:', e);
      });
    }
    res.end();
  }
});

// Health check — useful to confirm the server is up before running tests.
app.get('/health', (_req, res) => {
  res.json({ ok: true, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const PORT = Number(process.env['PORT'] ?? 3001);
app.listen(PORT, () => {
  console.log(`sandbox-runner  →  http://localhost:${PORT}`);
  console.log(`  POST /run     body: { command: string, timeoutMs?: number }`);
  console.log(`  GET  /health`);
  console.log();

  // Warn loudly at startup if no credentials are configured so the first
  // POST /run failure is not a surprise.
  try {
    resolveSandboxAuth();
    console.log('  Auth: credentials found ✓');
  } catch {
    console.warn(
      '  Auth: NO CREDENTIALS FOUND.\n' +
      '  Set VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID in .env,\n' +
      '  or run "vercel env pull" to populate VERCEL_OIDC_TOKEN.'
    );
  }
});
