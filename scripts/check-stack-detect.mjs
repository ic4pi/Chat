// Preview + smoke detection for non-Node/non-HTML stacks (Flask, FastAPI, Express file).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { previewResolveLines, freePortLines, PYTHON_SMOKE_COMMAND, NODE_ENTRY_SMOKE_COMMAND } from '../lib/sandbox-api/stack-detect.js';

let failed = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ' ' + extra}`); if (!cond) failed++; };
const proj = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
};
const sh = (cmd, cwd) => { try { return { code: 0, out: execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; } };
const resolve = (files) => sh(previewResolveLines(3000).join('\n') + '\necho "RUN_CMD=$RUN_CMD"', proj(files)).out.match(/RUN_CMD=(.*)/)?.[1];

ok('flask app → flask run', /-m flask --app app run .*--port 3000/.test(resolve({ 'app.py': 'from flask import Flask\napp = Flask(__name__)' })));
ok('fastapi app → uvicorn', /-m uvicorn app:app .*--port 3000/.test(resolve({ 'app.py': 'from fastapi import FastAPI\napp = FastAPI()' })));
ok('plain python → runs with PORT', /^PORT=3000 .*app\.py$/.test(resolve({ 'app.py': 'print(1)' })));
ok('express file, no package scripts → node', resolve({ 'server.js': 'x', 'package.json': '{}' }) === 'PORT=3000 node server.js');
ok('npm dev wins', resolve({ 'package.json': '{"scripts":{"dev":"vite"}}', 'app.py': 'x' }) === 'npm run dev');
ok('npm start used', resolve({ 'package.json': '{"scripts":{"start":"node x.js"}}' }) === 'npm start');
ok('static html still http.server', resolve({ 'index.html': '<html></html>' }) === 'python3 -m http.server 3000');
ok('static html with server.js stays static', resolve({ 'index.html': '<html></html>', 'server.js': 'x' }) === 'python3 -m http.server 3000');

ok('python smoke passes on good code', sh(PYTHON_SMOKE_COMMAND, proj({ 'app.py': 'x = 1\n', 'templates/a.html': '<p/>' })).code === 0);
ok('python smoke fails on syntax error', sh(PYTHON_SMOKE_COMMAND, proj({ 'app.py': 'def (:\n' })).code !== 0);
ok('node smoke passes on good file', sh(NODE_ENTRY_SMOKE_COMMAND, proj({ 'server.js': 'const a = 1;\n' })).code === 0);
ok('node smoke fails on syntax error', sh(NODE_ENTRY_SMOKE_COMMAND, proj({ 'server.js': 'const = ;\n' })).code !== 0);
ok('node smoke fails with no entry', sh(NODE_ENTRY_SMOKE_COMMAND, proj({ 'x.txt': 'a' })).code !== 0);

import { codingReasoningCap } from '../lib/providers.js';
ok('reasoning capped on OpenRouter coding calls', codingReasoningCap('openrouter').reasoning?.effort === 'low');
ok('no reasoning field for other providers', Object.keys(codingReasoningCap('venice')).length === 0 && Object.keys(codingReasoningCap('groq')).length === 0);

// Restart bug: killing only the launcher `sh` leaves the server it started holding the port.
const listening = (port) => new Promise((res) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(true); }); c.on('error', () => res(false)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withoutTools = (hide) => { // a PATH where the listed tools are not found
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
  for (const t of ['bash', 'sh', 'node', 'grep', 'cut', 'sort', 'sleep', 'cat', 'rm', 'kill', 'command', 'env', 'ps', 'ss', 'lsof', 'fuser', 'awk', 'sed', 'tr']) {
    if (hide.includes(t)) continue;
    try { fs.symlinkSync(execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(), path.join(dir, t)); } catch { /* not installed */ }
  }
  return dir;
};
for (const [label, hide] of [['lsof', ['fuser', 'ss']], ['fuser', ['lsof', 'ss']]]) {
  let have = true;
  try { execFileSync('bash', ['-c', `command -v ${label}`], { stdio: 'pipe' }); } catch { have = false; }
  if (!have) { console.log(`skip free-port via ${label} (not installed here)`); continue; }
  const port = 41000 + Math.floor(Math.random() * 1000);
  const srv = spawn('sh', ['-c', `node -e "require('http').createServer((q,r)=>r.end('x')).listen(${port})"`], { detached: true, stdio: 'ignore' });
  await sleep(800);
  const sh = srv.pid;
  try { process.kill(sh, 'SIGKILL'); } catch { /* gone */ }
  await sleep(300);
  const heldBefore = await listening(port);
  try { execFileSync('bash', ['-c', freePortLines(port).join('\n')], { env: { ...process.env, PATH: withoutTools(hide) }, stdio: 'pipe' }); } catch { /* ignore */ }
  await sleep(300);
  const heldAfter = await listening(port);
  ok(`killing only the launcher leaves the port held (repro, via ${label})`, heldBefore);
  ok(`free-port step releases it (via ${label})`, !heldAfter);
  if (heldAfter) { try { execFileSync('bash', ['-c', `fuser -k ${port}/tcp`], { stdio: 'pipe' }); } catch { /* cleanup */ } }
}
ok('free-port refuses privileged/invalid ports', freePortLines(80).length === 0 && freePortLines('x').length === 0);

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall stack-detect checks passed');
