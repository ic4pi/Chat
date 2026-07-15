/**
 * Standalone test script — verifies that streaming works end to end without
 * any frontend.
 *
 * Usage:
 *   # Default command (shows stdout/stderr interleaved with a delay):
 *   node --experimental-strip-types test/run.ts
 *
 *   # Custom command (quote it as one argument):
 *   node --experimental-strip-types test/run.ts "echo hello && sleep 1 && echo world"
 *
 *   # Against a remote host:
 *   SERVER_URL=https://your-server.example.com \
 *   node --experimental-strip-types test/run.ts "python3 -c 'print(1+1)'"
 *
 * Exit code mirrors the remote process exit code (or 1/124 on error/timeout).
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_URL = (process.env['SERVER_URL'] ?? 'http://localhost:3001').replace(/\/$/, '');

// Default command exercises real-time streaming: "hello" should appear in the
// terminal *before* the 2-second sleep completes, proving we're not buffering.
const command =
  process.argv.slice(2).join(' ') ||
  [
    'echo "=== stdout line 1 ==="',
    'sleep 1',
    'echo "=== stdout line 2 (after 1s) ==="',
    'echo "=== stderr line ===" >&2',
    'sleep 1',
    'echo "=== stdout line 3 (after 2s) ==="',
    'exit 0',
  ].join(' && ');

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

// SSE lines look like:
//   event: stdout
//   data: "hello world\n"
//
//   event: exit
//   data: "0"
//
// We parse them into { event, data } pairs.

type SseMessage = { event: string; data: string };

async function* parseSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buf = '';
  let currentEvent = 'message';

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE messages are separated by blank lines.
      const parts = buf.split('\n\n');
      // The last element is either empty or an incomplete message.
      buf = parts.pop() ?? '';

      for (const part of parts) {
        let event = 'message';
        let data = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) {
            event = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            data = line.slice(6).trim();
          }
        }
        currentEvent = event;
        yield { event: currentEvent, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.error(`[test] server  : ${SERVER_URL}`);
console.error(`[test] command : ${command}`);
console.error(`[test] ${'─'.repeat(60)}`);

const startedAt = Date.now();

// 1. Confirm the server is up before sending a potentially expensive request.
try {
  const health = await fetch(`${SERVER_URL}/health`);
  if (!health.ok) throw new Error(`/health returned ${health.status}`);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[test] server not reachable: ${msg}`);
  console.error(`[test] Start the server first:  npm start`);
  process.exit(1);
}

// 2. POST /run
const res = await fetch(`${SERVER_URL}/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ command }),
});

if (!res.ok || !res.body) {
  console.error(`[test] HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

// 3. Stream and print
let exitCode = 1;

for await (const msg of parseSse(res.body)) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  switch (msg.event) {
    case 'status':
      console.error(`[+${elapsed}s] [status] ${JSON.parse(msg.data)}`);
      break;

    case 'stdout':
      // Write stdout chunks to our process stdout — no timestamp prefix so
      // the output looks clean for scripts that parse it.
      process.stdout.write(JSON.parse(msg.data) as string);
      break;

    case 'stderr':
      // Write stderr chunks to our process stderr.
      process.stderr.write(JSON.parse(msg.data) as string);
      break;

    case 'exit': {
      const code = Number(JSON.parse(msg.data));
      exitCode = code;
      console.error(`\n[+${elapsed}s] [exit] code=${code}`);
      break;
    }

    case 'timeout':
      console.error(`\n[+${elapsed}s] [timeout] ${JSON.parse(msg.data)}`);
      exitCode = 124; // standard timeout exit code
      break;

    case 'error':
      console.error(`\n[+${elapsed}s] [error] ${JSON.parse(msg.data)}`);
      exitCode = 1;
      break;

    default:
      console.error(`\n[+${elapsed}s] [${msg.event}] ${msg.data}`);
  }
}

process.exit(exitCode);
