// Preview + smoke detection for non-Node/non-HTML stacks (Flask, FastAPI, Express file).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewResolveLines, PYTHON_SMOKE_COMMAND, NODE_ENTRY_SMOKE_COMMAND } from '../lib/sandbox-api/stack-detect.js';

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

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall stack-detect checks passed');
