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
import cors from 'cors';
import { Sandbox } from '@vercel/sandbox';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
// Allow any localhost port (Vite, CRA, etc.) plus any origin in production.
// Credentials are not used here; tighten this in prod if needed.
app.use(cors());
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

import { getFileTree, readFile, writeFiles as writeFilesHelper, countFiles } from './repo.ts';
import { searchRepo }       from './search.ts';
import { detectTestCommand } from './detect-test.ts';

// ---------------------------------------------------------------------------
// /files  GET ?root=<absolute-path>
// ---------------------------------------------------------------------------
app.get('/files', (req: Request, res: Response): void => {
  const root = req.query['root'];
  if (typeof root !== 'string' || !root) {
    res.status(400).json({ error: 'root query param required' }); return;
  }
  try {
    const tree = getFileTree(root);
    res.json({ root, tree, totalFiles: countFiles(tree) });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// /file  GET ?root=<root>&path=<relative-path>
// ---------------------------------------------------------------------------
app.get('/file', (req: Request, res: Response): void => {
  const root = req.query['root'];
  const relPath = req.query['path'];
  if (typeof root !== 'string' || typeof relPath !== 'string') {
    res.status(400).json({ error: 'root and path query params required' }); return;
  }
  try {
    const content = readFile(root, relPath);
    res.json({ path: relPath, content, lines: content.split('\n').length });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// /write-files  POST { root, files: [{ path, content }] }
// ---------------------------------------------------------------------------
app.post('/write-files', (req: Request, res: Response): void => {
  const { root, files } = req.body as { root?: unknown; files?: unknown };
  if (typeof root !== 'string' || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'root (string) and files (array) required' }); return;
  }
  try {
    const results = writeFilesHelper(root, files as Array<{ path: string; content: string }>);
    const allOk = results.every(r => r.written);
    res.status(allOk ? 200 : 207).json({ results });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// /search  POST { root, query, maxFiles? }
// Returns scored file matches for auto-context.
// ---------------------------------------------------------------------------
app.post('/search', async (req: Request, res: Response): Promise<void> => {
  const { root, query, maxFiles } = req.body as {
    root?: unknown; query?: unknown; maxFiles?: unknown;
  };
  if (typeof root !== 'string' || typeof query !== 'string') {
    res.status(400).json({ error: 'root and query (strings) required' }); return;
  }
  try {
    const matches = await searchRepo(root, query, typeof maxFiles === 'number' ? maxFiles : 6);
    res.json({ matches });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// /detect-test-command  GET ?root=<abs-path>
// Infers the test command from project files.
// ---------------------------------------------------------------------------
app.get('/detect-test-command', (req: Request, res: Response): void => {
  const root = req.query['root'];
  if (typeof root !== 'string') {
    res.status(400).json({ error: 'root query param required' }); return;
  }
  try {
    const result = detectTestCommand(root);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---------------------------------------------------------------------------
// /run-code — like /run but accepts { code, language } instead of a raw shell
// command string. Writes the code to a temp file and runs with the right
// interpreter, which avoids heredoc / shell-quoting nightmares with multi-line
// code. SSE format is identical to /run.
// ---------------------------------------------------------------------------

const LANG_CONFIG: Record<string, { ext: string; runner: string[] }> = {
  python:     { ext: '.py',  runner: ['python3'] },
  py:         { ext: '.py',  runner: ['python3'] },
  javascript: { ext: '.js',  runner: ['node'] },
  js:         { ext: '.js',  runner: ['node'] },
  typescript: { ext: '.ts',  runner: ['npx', 'ts-node', '--skipProject'] },
  ts:         { ext: '.ts',  runner: ['npx', 'ts-node', '--skipProject'] },
  bash:       { ext: '.sh',  runner: ['bash'] },
  sh:         { ext: '.sh',  runner: ['bash'] },
  shell:      { ext: '.sh',  runner: ['bash'] },
  ruby:       { ext: '.rb',  runner: ['ruby'] },
  rb:         { ext: '.rb',  runner: ['ruby'] },
};

const DEFAULT_LANG_CONFIG = { ext: '.sh', runner: ['bash'] };

app.post('/run-code', async (req: Request, res: Response): Promise<void> => {
  const { code, language, timeoutMs } = req.body as {
    code?: unknown; language?: unknown; timeoutMs?: unknown;
  };

  if (typeof code !== 'string' || !code.trim()) {
    res.status(400).json({ error: '"code" must be a non-empty string' });
    return;
  }

  const lang     = (typeof language === 'string' ? language : '').toLowerCase().trim();
  const config   = LANG_CONFIG[lang] ?? DEFAULT_LANG_CONFIG;
  const timeout  = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  setupSSE(res);

  const abort = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abort.abort(new Error(`Code execution timed out after ${timeout / 1000}s`));
  }, timeout);

  let streamDone = false;
  res.on('close', () => {
    if (!streamDone && !abort.signal.aborted) abort.abort(new Error('Client disconnected'));
  });

  let tmpFile: string | null = null;
  let sandbox: Sandbox | null = null;

  try {
    if (process.env['LOCAL_MODE'] === 'true') {
      // Write code to a temp file then spawn the interpreter directly.
      tmpFile = path.join(os.tmpdir(), `sb-code-${Date.now()}${config.ext}`);
      fs.writeFileSync(tmpFile, code, 'utf8');

      sseEvent(res, 'status',
        `[LOCAL_MODE] ${config.runner[0]} ${path.basename(tmpFile)}`);

      await new Promise<void>((resolve, reject) => {
        const [cmd, ...args] = config.runner;
        const child = spawn(cmd!, [...args, tmpFile!], { stdio: 'pipe' });

        const abortListener = () => {
          child.kill('SIGTERM');
          sseEvent(res, 'timeout',
            abort.signal.reason instanceof Error ? abort.signal.reason.message : 'Aborted');
          resolve();
        };
        abort.signal.addEventListener('abort', abortListener, { once: true });

        child.stdout.on('data', (c: Buffer) => sseEvent(res, 'stdout', c.toString()));
        child.stderr.on('data', (c: Buffer) => sseEvent(res, 'stderr', c.toString()));
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
      // Vercel Sandbox: write file, then runCommand.
      const auth = resolveSandboxAuth();
      sseEvent(res, 'status', 'Creating sandbox…');

      sandbox = await Sandbox.create({ ...auth, runtime: 'node24', timeout });
      sseEvent(res, 'status', `Sandbox ready: ${sandbox.name}`);

      const filename = `code${config.ext}`;
      await sandbox.writeFiles([{ path: filename, content: Buffer.from(code, 'utf8') }]);

      const [cmd, ...args] = config.runner;
      const sdxCmd = await sandbox.runCommand({
        cmd: cmd!,
        args: [...args, filename],
        detached: true,
      });

      try {
        for await (const log of sdxCmd.logs({ signal: abort.signal })) {
          sseEvent(res, log.stream, log.data);
        }
      } catch (logErr: unknown) {
        if (abort.signal.aborted) {
          await sdxCmd.kill('SIGTERM').catch(() => {});
          sseEvent(res, 'timeout',
            abort.signal.reason instanceof Error ? abort.signal.reason.message : 'Aborted');
          return;
        }
        throw logErr;
      }

      const finished = await sdxCmd.wait();
      sseEvent(res, 'exit', String(finished.exitCode ?? 0));
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sandbox-runner] /run-code error:', message);
    sseEvent(res, 'error', message);
  } finally {
    streamDone = true;
    clearTimeout(timeoutHandle);
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    }
    if (sandbox) sandbox.stop().catch(() => {});
    res.end();
  }
});

// ---------------------------------------------------------------------------
// /chat — LLM proxy, or LOCAL_CHAT_MODE mock for testing the full pipeline.
//
// LOCAL_CHAT_MODE responses vary by the first keyword in the user message:
//   contains "error" / "fail" / "broken"  → code block that raises an error
//   anything else                          → working streaming Python code
//
// Format matches the Vercel chat app:
//   { reply: string, model: string, provider: string }
// ---------------------------------------------------------------------------

const MOCK_SUCCESS_REPLY = `\
Sure — here's a Python script that outputs several lines with a short \
delay between each, so you can watch the streaming in real time:

\`\`\`python
import time
import sys

tasks = ["Initialising", "Loading data", "Processing", "Analysing", "Done"]
for i, task in enumerate(tasks, 1):
    print(f"[{i}/{len(tasks)}] {task}...")
    sys.stdout.flush()
    time.sleep(0.5)

print("\\nAll tasks complete.")
\`\`\`

Each line arrives as it is printed — no buffering.`;

const MOCK_ERROR_REPLY = `\
Here is a script that will fail — it imports a module that does not exist:

\`\`\`python
import definitely_not_a_real_module

result = definitely_not_a_real_module.compute(42)
print(f"Result: {result}")
\`\`\`

The error should appear immediately in the terminal with a clean traceback.`;

app.post('/chat', async (req: Request, res: Response): Promise<void> => {
  const { messages, systemPrompt } = req.body as {
    messages?: Array<{ role: string; content: string }>;
    systemPrompt?: string;
  };
  const lastUserMsg = [...(messages ?? [])].reverse()
    .find(m => m.role === 'user')?.content ?? '';

  if (process.env['LOCAL_CHAT_MODE'] === 'true') {
    const lower = lastUserMsg.toLowerCase();
    const isError = /error|fail|broken|bad|crash|wrong/i.test(lower);
    const reply = isError ? MOCK_ERROR_REPLY : MOCK_SUCCESS_REPLY;
    // Small simulated delay so the UI doesn't feel instant.
    await new Promise(r => setTimeout(r, 600));
    res.json({ reply, model: 'mock-local', provider: 'LOCAL_CHAT_MODE' });
    return;
  }

  // ── Real mode: proxy to OpenRouter or Venice ──
  const { model, provider: providerId } = req.body as { model?: string; provider?: string };
  const provider = (providerId === 'venice')
    ? { url: 'https://api.venice.ai/api/v1/chat/completions', key: process.env['VENICE_API_KEY'], label: 'Venice' }
    : { url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env['OPENROUTER_API_KEY'], label: 'OpenRouter' };

  if (!provider.key) {
    res.status(500).json({ error: `${provider.label} API key not configured. Set LOCAL_CHAT_MODE=true to use mock responses.` });
    return;
  }

  try {
    // Prepend the client-supplied system prompt (file context, agent instructions)
    const messagesWithSystem = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...(messages ?? [])]
      : (messages ?? []);

    const upstream = await fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`,
        ...(providerId !== 'venice' ? { 'HTTP-Referer': 'http://localhost:5173', 'X-Title': 'Sandbox Chat' } : {}),
      },
      body: JSON.stringify({
        model: model ?? 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
        messages: messagesWithSystem,
        stream: false,
      }),
    });
    const data = await upstream.json() as { choices?: Array<{ message?: { content?: string } }> };
    const reply = data.choices?.[0]?.message?.content ?? '';
    res.json({ reply, model, provider: provider.label });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
