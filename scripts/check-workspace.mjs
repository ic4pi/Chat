/**
 * End-to-end check for the Workspace (/agent) "build me an app" pipeline.
 *
 * Runs the real API handlers and the real client-side parsing/validation
 * against a local stand-in sandbox (scripts/workspace-harness/), so the whole
 * path can be verified with no Vercel Sandbox or model credentials:
 *
 *   init-blank → parse a model reply → write-files → file tree →
 *   detect-test-command → run the smoke test → preview-start →
 *   fetch the served app → drive it in a real browser
 *
 * Run: npm run check:workspace
 */

import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SANDBOX = pathToFileURL(path.join(HERE, 'workspace-harness/local-sandbox.mjs')).href;

process.env['WORKSPACE_LOCAL_SANDBOX_URL'] = LOCAL_SANDBOX;
// The handlers gate on these before touching the SDK; the local stand-in
// ignores them, but the same configuration check has to pass.
process.env['VERCEL_TOKEN'] ||= 'local-harness';
process.env['VERCEL_TEAM_ID'] ||= 'local-harness';
process.env['VERCEL_PROJECT_ID'] ||= 'local-harness';
register('./workspace-harness/sandbox-hook.mjs', import.meta.url);

// Imported after register() so the hook is in place for the handler graph.
const { default: sandboxRouter } = await import('../api/sandbox/[op].js');
const { allSandboxes } = await import(LOCAL_SANDBOX);
const agentParse = await import('../sandbox-terminal/src/agentParse.ts');

let failures = 0;
let checks = 0;

function ok(label, detail = '') {
  checks++;
  console.log(`check-workspace: ok — ${label}${detail ? ` (${detail})` : ''}`);
}

function fail(label, detail) {
  checks++;
  failures++;
  console.error(`check-workspace: FAIL — ${label}${detail ? `\n    ${detail}` : ''}`);
}

function assert(cond, label, detail) {
  if (cond) ok(label);
  else fail(label, detail);
  return !!cond;
}

// ── minimal Vercel-style req/res shim ───────────────────────────────────────

async function call(op, { method = 'POST', body, query = {}, headers = {} } = {}) {
  const req = {
    method,
    url: `/api/sandbox/${op}`,
    query: { op, ...query },
    body,
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };

  let statusCode = 200;
  const resHeaders = {};
  let payload;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });

  const res = {
    setHeader(k, v) { resHeaders[k] = v; },
    getHeader(k) { return resHeaders[k]; },
    status(code) { statusCode = code; return res; },
    json(obj) { payload = obj; resolveDone(); return res; },
    send(obj) { payload = obj; resolveDone(); return res; },
    end() { resolveDone(); return res; },
  };

  await Promise.race([sandboxRouter(req, res).then(() => done), done]);
  return { status: statusCode, body: payload, headers: resHeaders };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'never attempted';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${url} never came up: ${lastErr}`);
}

// ── what a coding model actually sends back ─────────────────────────────────
// Complete files plus one stub block, so both the accept and the reject path
// are exercised on a single reply.

const MODEL_REPLY = `Here's a small task tracker.

File: index.html
\`\`\`html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Task Tracker</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <h1>Task Tracker</h1>
      <p class="hint">Type a task, press Add, click a task to complete it.</p>
      <form id="add-form">
        <input id="task-input" placeholder="What needs doing?" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <ul id="task-list"></ul>
      <p id="summary">0 tasks</p>
    </main>
    <script src="app.js"></script>
  </body>
</html>
\`\`\`

File: styles.css
\`\`\`css
body { font-family: system-ui, sans-serif; margin: 0; background: #10131a; color: #e8ecf4; }
main { max-width: 520px; margin: 0 auto; padding: 32px 20px; }
h1 { font-size: 22px; }
.hint { color: #8c94a8; font-size: 13px; }
form { display: flex; gap: 8px; }
input { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #2a3040; background: #171b26; color: inherit; }
button { padding: 8px 14px; border-radius: 6px; border: none; background: #ff3d8e; color: #0b0d12; font-weight: 700; cursor: pointer; }
ul { list-style: none; padding: 0; }
li { padding: 8px 10px; border-bottom: 1px solid #222836; cursor: pointer; }
li.done { text-decoration: line-through; color: #6b7385; }
\`\`\`

File: app.js
\`\`\`js
(function () {
  var tasks = [];
  var form = document.getElementById('add-form');
  var input = document.getElementById('task-input');
  var list = document.getElementById('task-list');
  var summary = document.getElementById('summary');

  function render() {
    list.innerHTML = '';
    tasks.forEach(function (task, i) {
      var li = document.createElement('li');
      li.textContent = task.text;
      li.dataset.index = String(i);
      if (task.done) li.className = 'done';
      list.appendChild(li);
    });
    var open = tasks.filter(function (t) { return !t.done; }).length;
    summary.textContent = tasks.length + ' tasks, ' + open + ' open';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    tasks.push({ text: text, done: false });
    input.value = '';
    render();
  });

  list.addEventListener('click', function (e) {
    var idx = Number(e.target.dataset.index);
    if (Number.isNaN(idx) || !tasks[idx]) return;
    tasks[idx].done = !tasks[idx].done;
    render();
  });

  render();
})();
\`\`\`

File: api/save.js
\`\`\`js
// ... existing imports ...
export default function handler(req, res) { res.json({ ok: true }); }
\`\`\`
`;

const cleanup = [];

async function main() {
  console.log('check-workspace: driving the Workspace pipeline against a local sandbox\n');

  // 1 ── Start a blank project, the way "Start blank" does.
  const init = await call('init-blank', { body: { name: 'task-tracker' } });
  if (!assert(init.status === 200 && init.body?.sandboxId, 'init-blank starts a project',
    JSON.stringify(init.body).slice(0, 300))) return;
  const session = { 'X-Sandbox-Session': init.body.sandboxId };
  ok('init-blank returns a repo dir', init.body.repoDir);

  // 2 ── Parse the model reply exactly as ChatPane does.
  const report = agentParse.extractFileChangeReport(MODEL_REPLY);
  const acceptedPaths = report.accepted.map(f => f.path).sort();
  assert(
    JSON.stringify(acceptedPaths) === JSON.stringify(['app.js', 'index.html', 'styles.css']),
    'model reply parses into the three real files',
    `got ${JSON.stringify(acceptedPaths)}`,
  );
  assert(
    report.rejected.some(r => r.path === 'api/save.js'),
    'stub File: block is rejected, not written',
    JSON.stringify(report.rejected),
  );

  // 3 ── Write them, the way applyChanges does.
  const write = await call('write-files', {
    headers: session,
    body: { files: report.accepted.map(f => ({ path: f.path, content: f.content })) },
  });
  const writeResults = write.body?.results ?? [];
  assert(
    write.status === 200 && writeResults.length === 3 && writeResults.every(r => r.written),
    'write-files saves every accepted file',
    JSON.stringify(write.body).slice(0, 400),
  );

  // 4 ── The file tree must show what was just written (refreshTree's endpoint).
  const tree = await call('files', { method: 'GET', headers: session });
  const names = [];
  (function walk(nodes) {
    for (const n of nodes ?? []) {
      if (n.type === 'file') names.push(n.path);
      else walk(n.children);
    }
  })(tree.body?.tree);
  assert(
    ['index.html', 'app.js', 'styles.css'].every(p => names.includes(p)),
    'file tree lists the newly written app files',
    `tree had ${JSON.stringify(names)}`,
  );

  // 5 ── Auto-test picks the built-in static smoke check for this project shape.
  const detect = await call('detect-test-command', { method: 'GET', headers: session });
  assert(
    detect.status === 200 && typeof detect.body?.command === 'string' && detect.body.command.includes('SMOKE'),
    'detect-test-command finds the static smoke check',
    JSON.stringify(detect.body).slice(0, 300),
  );

  // 6 ── Run it for real inside the sandbox.
  const sandbox = allSandboxes().find(s => s.name === init.body.sandboxId);
  cleanup.push(() => sandbox?.dispose());
  const smoke = await sandbox.runCommand({
    cmd: 'bash',
    args: ['-lc', `cd /vercel/sandbox/repo && ${detect.body.command}`],
  });
  const smokeOut = `${await smoke.stdout()}${await smoke.stderr()}`.trim();
  assert(smoke.exitCode === 0, 'the smoke test passes on the generated app', smokeOut.slice(0, 400));
  if (smoke.exitCode === 0) console.log(`    ${smokeOut}`);

  // 7 ── Preview with no command: the server must pick one from the project.
  const port = await freePort();
  const preview = await call('preview-start', { headers: session, body: { port } });
  cleanup.push(() => {
    try { execSync(`pkill -f workspace-static-server`, { stdio: 'ignore' }); } catch { /* none running */ }
  });
  if (!assert(
    preview.status === 200 && preview.body?.url,
    'preview-start auto-detects a command for a static app',
    JSON.stringify(preview.body).slice(0, 500),
  )) return;
  ok('preview command chosen', `${preview.body.source}`);

  // 8 ── The app is actually being served.
  const page = await waitForHttp(preview.body.url);
  const html = await page.text();
  assert(html.includes('<title>Task Tracker</title>'), 'preview serves the app entry page');
  const js = await fetch(`${preview.body.url}/app.js`);
  assert(
    js.ok && (js.headers.get('content-type') || '').includes('javascript'),
    'preview serves linked assets with the right content type',
    `HTTP ${js.status} ${js.headers.get('content-type')}`,
  );

  // 9 ── Drive it in a real browser: does the app work?
  await browserCheck(preview.body.url);

  // 10 ── An empty project must say so instead of failing silently.
  const empty = await call('init-blank', { body: { name: 'nothing-yet' } });
  const emptyPreview = await call('preview-start', {
    headers: { 'X-Sandbox-Session': empty.body.sandboxId },
    body: { port: await freePort() },
  });
  cleanup.push(() => allSandboxes().find(s => s.name === empty.body?.sandboxId)?.dispose());
  assert(
    emptyPreview.status === 400 && /Nothing to preview/.test(emptyPreview.body?.error || ''),
    'preview on an empty project explains itself instead of hanging',
    JSON.stringify(emptyPreview.body).slice(0, 300),
  );

  // 11 ── A dead session answers { error } with no results array — the shape
  //       applyChanges must surface rather than read as "nothing to report".
  const dead = await call('write-files', {
    headers: { 'X-Sandbox-Session': 'gone-forever' },
    body: { files: [{ path: 'index.html', content: '<html><body>hi there friend</body></html>' }] },
  });
  assert(
    dead.status >= 400 && !Array.isArray(dead.body?.results) && !!dead.body?.error,
    'a dead session returns an error, not an empty result set',
    JSON.stringify(dead.body).slice(0, 300),
  );
}

async function browserCheck(url) {
  let puppeteer;
  try {
    const req = (await import('node:module')).createRequire(
      new URL('../sandbox-terminal/package.json', import.meta.url),
    );
    puppeteer = req('puppeteer-core');
  } catch {
    console.log('check-workspace: skip — puppeteer-core not installed (run npm ci in sandbox-terminal)');
    return;
  }

  const exe = process.env['PUPPETEER_EXECUTABLE_PATH']
    || ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
      .find(p => fs.existsSync(p));
  if (!exe) {
    console.log('check-workspace: skip — no Chromium binary found for the browser check');
    return;
  }

  const browser = await puppeteer.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  cleanup.push(() => browser.close());

  const page = await browser.newPage();
  const consoleErrors = [];
  // The browser always asks for /favicon.ico; a missing one is not an app bug.
  const ignorable = (t) => /favicon\.ico/.test(t);
  page.on('console', m => {
    if (m.type() === 'error' && !ignorable(m.text() + m.location()?.url)) consoleErrors.push(m.text());
  });
  page.on('pageerror', e => consoleErrors.push(String(e)));

  await page.goto(url, { waitUntil: 'networkidle0', timeout: 20_000 });

  assert(await page.title() === 'Task Tracker', 'browser loads the app', await page.title());

  await page.type('#task-input', 'ship the workspace fix');
  await page.click('#add-form button');
  await page.waitForFunction(() => document.querySelectorAll('#task-list li').length === 1, { timeout: 5_000 });
  ok('adding a task works in the browser');

  await page.click('#task-list li');
  const done = await page.$eval('#task-list li', el => el.classList.contains('done'));
  assert(done, 'completing a task works in the browser');

  const summary = await page.$eval('#summary', el => el.textContent);
  assert(summary === '1 tasks, 0 open', 'the app updates its own state', String(summary));

  assert(consoleErrors.length === 0, 'the app runs with no console errors', consoleErrors.join(' | '));
}

try {
  await main();
} catch (err) {
  fail('harness crashed', err instanceof Error ? (err.stack || err.message) : String(err));
} finally {
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
}

console.log('');
if (failures) {
  console.error(`check-workspace: ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`check-workspace: all ${checks} checks passed`);
