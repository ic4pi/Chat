/**
 * Preview + smoke-test detection for stacks the coder may pick beyond Node and
 * plain HTML — a Flask/FastAPI app, a Python script server, a bare Express file.
 * Without this, Preview fell through to `python3 -m http.server` (a directory
 * listing of the source) and Auto-test found nothing to run, so Push stayed locked.
 */

/** Syntax-checks every .py file; fails on the first broken one. Single shell line. */
export const PYTHON_SMOKE_COMMAND =
  "python3 -m compileall -q -x '(node_modules|venv|[.]git)' . && echo 'python smoke ok: all files compile'";

/** Syntax-checks the Node entry file. Single shell line. */
export const NODE_ENTRY_SMOKE_COMMAND =
  'for f in server.js app.js index.js main.js; do if [ -f "$f" ]; then node --check "$f" && echo "node smoke ok: $f parses" && exit 0; exit 1; fi; done; exit 1';

/**
 * Shell lines that set RUN_CMD for Preview when no command was typed.
 * Runs with the project directory as cwd. Order: npm dev → npm start → Python
 * app → Node entry file → plain static server.
 */
export function previewResolveLines(port) {
  const p = Number(port);
  return [
    'PY=python3; [ -x /vercel/sandbox/venv/bin/python ] && PY=/vercel/sandbox/venv/bin/python',
    `if [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{}).dev?0:1)" >/dev/null 2>&1; then`,
    `  RUN_CMD="npm run dev"`,
    `elif [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{}).start?0:1)" >/dev/null 2>&1; then`,
    `  RUN_CMD="npm start"`,
    `elif [ -f app.py ] || [ -f main.py ] || [ -f server.py ]; then`,
    `  ENTRY=app.py; [ -f "$ENTRY" ] || ENTRY=main.py; [ -f "$ENTRY" ] || ENTRY=server.py`,
    `  MOD="\${ENTRY%.py}"`,
    `  if grep -q "FastAPI(" "$ENTRY"; then RUN_CMD="$PY -m uvicorn $MOD:app --host 0.0.0.0 --port ${p}"`,
    `  elif grep -q "Flask(" "$ENTRY"; then RUN_CMD="$PY -m flask --app $MOD run --host 0.0.0.0 --port ${p}"`,
    `  else RUN_CMD="PORT=${p} $PY $ENTRY"; fi`,
    `elif [ ! -f index.html ] && { [ -f server.js ] || [ -f app.js ] || [ -f index.js ]; }; then`,
    `  ENTRY=server.js; [ -f "$ENTRY" ] || ENTRY=app.js; [ -f "$ENTRY" ] || ENTRY=index.js`,
    `  RUN_CMD="PORT=${p} node $ENTRY"`,
    `elif command -v python3 >/dev/null 2>&1; then`,
    `  RUN_CMD="python3 -m http.server ${p}"`,
    `else`,
    `  RUN_CMD="npx --yes serve -l ${p} ."`,
    `fi`,
  ];
}

/** Installs Python deps before the preview starts, when the project lists any. */
export function pythonInstallLines(logFile) {
  return [
    'PY=python3; [ -x /vercel/sandbox/venv/bin/python ] && PY=/vercel/sandbox/venv/bin/python',
    `if [ -f requirements.txt ]; then "$PY" -m pip install -q -r requirements.txt >> ${logFile} 2>&1 || echo "pip install had errors — see preview log"; fi`,
  ];
}

/**
 * Shell lines that free a port before Preview starts on it. Preview used to kill only
 * the `sh` it launched, so the server that shell started (node, flask…) lived on and
 * held the port: every Restart then died with EADDRINUSE. Kills whatever LISTENS on it.
 */
export function freePortLines(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return [];
  const hex = p.toString(16).toUpperCase().padStart(4, '0');
  return [
    `PORT_PIDS=""`,
    // Linux (the real sandbox has no lsof, fuser, ss or netstat — only /proc): LISTEN sockets on this
    // port, matched to the processes that hold them.
    `if [ -r /proc/net/tcp ]; then`,
    `  PORT_INODES=$(awk 'NR>1 && $4=="0A" { split($2,a,":"); if (a[2]=="${hex}") print $10 }' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)`,
    `  for ino in $PORT_INODES; do`,
    `    for fd in /proc/[0-9]*/fd/*; do`,
    `      if [ "$(readlink "$fd" 2>/dev/null)" = "socket:[$ino]" ]; then pid=\${fd#/proc/}; PORT_PIDS="$PORT_PIDS \${pid%%/*}"; fi`,
    `    done`,
    `  done`,
    `elif command -v lsof >/dev/null 2>&1; then PORT_PIDS=$(lsof -t -iTCP:${p} -sTCP:LISTEN 2>/dev/null || true)`,
    `elif command -v fuser >/dev/null 2>&1; then PORT_PIDS=$(fuser ${p}/tcp 2>/dev/null || true)`,
    `elif command -v ss >/dev/null 2>&1; then PORT_PIDS=$(ss -ltnpH "sport = :${p}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)`,
    `fi`,
    `PORT_PIDS=$(printf '%s\\n' $PORT_PIDS | grep -v "^$$\\$" | sort -u | tr '\\n' ' ')`,
    `if [ -n "$PORT_PIDS" ]; then kill -9 $PORT_PIDS 2>/dev/null || true; sleep 0.4; fi`,
  ];
}


/**
 * Which page a static preview should open. A plain `python3 -m http.server`
 * shows a "Directory listing" when there is no index.html, which is what a
 * model that names its file `metaphysics101.html` used to get. Returns null
 * when the root already serves (an index.html) or there is nothing to open.
 */
export function pickEntryPage(htmlFiles) {
  const files = (htmlFiles || []).filter((f) => typeof f === 'string' && /\.html?$/i.test(f) && !f.includes('/'));
  if (!files.length || files.some((f) => /^index\.html?$/i.test(f))) return null;
  return files.slice().sort((a, b) => a.localeCompare(b))[0];
}
