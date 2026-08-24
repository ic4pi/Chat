/**
 * GET /api/self-test  (TEMPORARY — remove after debugging the auto-verify loop)
 *
 * Drives the real init-blank -> write-files -> detect-test-command -> run
 * pipeline end to end, server-side (where outbound access to vercel.com's
 * own Sandbox API is actually allowed), and returns every step's raw
 * result as JSON. Point a browser at this URL to see exactly where the
 * auto-verify loop breaks, without needing local tokens or a repro script.
 *
 * Writes one intentionally-broken JS file so the smoke check has something
 * real to fail on, matching the "run it, it fails" symptom being debugged.
 */

import initBlank from './init-blank.js';
import writeFiles from './write-files.js';
import detectTestCommand from './detect-test-command.js';
import run from './run.js';

function mockRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    _sse: [],
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this._status = c; return this; },
    json(b) { this._body = b; return this; },
    write(chunk) { this._sse.push(chunk.toString()); },
    end() {},
    on() {}, // res.on('close', ...) no-op for this harness
    flushHeaders() {},
  };
  return res;
}

async function call(handler, { method = 'POST', body = {}, headers = {} } = {}) {
  const req = { method, body, headers, on() {} };
  const res = mockRes();
  await handler(req, res);
  return { status: res._status, body: res._body, sse: res._sse.join('') || undefined };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const steps = {};

  try {
    steps.initBlank = await call(initBlank, { body: { name: 'self-test' } });
    const sandboxId = steps.initBlank.body?.sandboxId;
    if (!sandboxId) return res.status(200).json({ steps, stoppedAt: 'initBlank', reason: 'no sandboxId returned' });

    const headers = { 'x-sandbox-session': sandboxId };

    steps.writeFiles = await call(writeFiles, {
      headers,
      body: {
        files: [
          { path: 'index.html', content:
            '<!doctype html><html><head><title>Self Test Page</title>' +
            '<link rel="stylesheet" href="style.css"></head><body>' +
            '<h1>Hello</h1><p>Real visible text so the smoke content check passes.</p>' +
            '<script src="app.js"></script></body></html>' },
          { path: 'style.css', content: 'body { font-family: sans-serif; }' },
          { path: 'app.js', content: 'function broken( {\n  console.log("oops");\n' }, // deliberate syntax error
        ],
      },
    });

    steps.detectTestCommand = await call(detectTestCommand, { method: 'GET', headers });
    const cmd = steps.detectTestCommand.body?.command;
    if (!cmd) return res.status(200).json({ steps, sandboxId, stoppedAt: 'detectTestCommand', reason: 'no command detected' });

    steps.run = await call(run, { headers, body: { command: cmd } });

    return res.status(200).json({ ok: true, sandboxId, steps });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err), stack: err.stack, steps });
  }
}
